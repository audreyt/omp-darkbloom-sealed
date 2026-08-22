/**
 * A `fetch` that seals outbound bodies and unseals inbound ones.
 *
 * Sealing is purely a transport concern, so it is applied here rather than in a
 * bespoke provider: omp's own `openai-completions` implementation builds the
 * request and parses the SSE — including native `tool_calls` streaming — and
 * this wrapper only transforms bytes on the wire. omp uses the same pattern
 * internally (`wrapFetchForCch`).
 */

import type { FetchImpl } from "@oh-my-pi/pi-utils";
import type { CoordinatorKey } from "./sealed";
import {
	CoordinatorKeyStore,
	SEALED_CONTENT_TYPE,
	encodeUtf8,
	unsealResponse,
	unsealSseEvent,
	sealRawRequest,
} from "./sealed";

const SSE_CONTENT_TYPE = "text/event-stream";
const JSON_CONTENT_TYPE = "application/json";


export interface ProviderPin {
	/** Stable hardware serial from Darkbloom's attestation record. */
	serial: string;
	/** Expected Apple Secure Enclave public key (base64), pinned out of band. */
	sePublicKey: string;
}
export interface SealedFetchOptions {
	/** Coordinator origin, e.g. `https://api.darkbloom.dev`. */
	baseUrl: string;
	store?: CoordinatorKeyStore;
	/** Underlying transport; injectable for tests. */
	fetchImpl?: typeof fetch;
	/**
	 * Hard pin to one owned provider. Adds provider_serial inside the sealed JSON,
	 * forces X-Darkbloom-Route:self, and rejects a successful response unless its
	 * attested Secure Enclave public key matches.
	 */
	providerPin?: ProviderPin;
}

/**
 * Rewrites a sealed SSE stream into the plaintext SSE omp expects.
 *
 * Each upstream frame is `data: <base64>`, and the sealed payload decrypts to a
 * complete SSE frame from the origin. Frames are emitted as they complete so
 * streaming latency is preserved.
 */
function unsealSseStream(
	upstream: ReadableStream<Uint8Array>,
	ephemeralPrivateKey: Uint8Array,
	coordPub: Uint8Array,
): ReadableStream<Uint8Array> {
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	let buffer = "";

	const flush = (
		controller: TransformStreamDefaultController<Uint8Array>,
		final: boolean,
	): void => {
		for (;;) {
			const boundary = buffer.indexOf("\n\n");
			if (boundary < 0) break;
			const frame = buffer.slice(0, boundary);
			buffer = buffer.slice(boundary + 2);
			emit(controller, frame);
		}
		if (final && buffer.trim().length > 0) {
			emit(controller, buffer);
			buffer = "";
		}
	};

	const emit = (
		controller: TransformStreamDefaultController<Uint8Array>,
		frame: string,
	): void => {
		for (const line of frame.split("\n")) {
			const trimmed = line.trim();
			if (trimmed.length === 0 || trimmed.startsWith(":")) continue;
			if (!trimmed.startsWith("data:")) continue;
			const payload = trimmed.slice("data:".length).trim();
			// `[DONE]` is emitted unsealed by the coordinator's SSE writer.
			if (payload === "[DONE]") {
				controller.enqueue(encoder.encode("data: [DONE]\n\n"));
				continue;
			}
			const plaintext = unsealSseEvent(payload, ephemeralPrivateKey, coordPub);
			const normalized = plaintext.endsWith("\n\n")
				? plaintext
				: `${plaintext.replace(/\n+$/, "")}\n\n`;
			controller.enqueue(encoder.encode(normalized));
		}
	};

	return upstream.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				buffer += decoder.decode(chunk, { stream: true });
				flush(controller, false);
			},
			flush(controller) {
				buffer += decoder.decode();
				flush(controller, true);
			},
		}),
	);
}

function addProviderPin(plaintextBody: string, pin: ProviderPin): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(plaintextBody);
	} catch (error) {
		throw new Error(
			`darkbloom-sealed: pinned request body must be JSON — ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("darkbloom-sealed: pinned request body must be a JSON object");
	}
	const body = parsed as Record<string, unknown>;
	if ("provider_serial" in body || "provider_serials" in body) {
		throw new Error(
			"darkbloom-sealed: request already contains provider routing fields; the configured pin is authoritative",
		);
	}
	body.provider_serial = pin.serial;
	return JSON.stringify(body);
}

function verifyPinnedProvider(headers: Headers, pin: ProviderPin): void {
	const trust = headers.get("x-provider-trust-level")?.trim().toLowerCase();
	const enclave = headers.get("x-provider-secure-enclave")?.trim().toLowerCase();
	const actualKey = headers.get("x-attestation-se-public-key")?.trim();
	if (trust !== "hardware") {
		throw new Error(
			`darkbloom-sealed: pinned provider ${pin.serial} did not return hardware trust`,
		);
	}
	if (enclave !== "true") {
		throw new Error(
			`darkbloom-sealed: pinned provider ${pin.serial} did not attest Secure Enclave`,
		);
	}
	if (!actualKey) {
		throw new Error(
			`darkbloom-sealed: pinned provider ${pin.serial} omitted x-attestation-se-public-key`,
		);
	}
	if (actualKey !== pin.sePublicKey) {
		throw new Error(
			`darkbloom-sealed: pinned provider ${pin.serial} Secure Enclave key mismatch`,
		);
	}
}

export function createSealedFetch(options: SealedFetchOptions): FetchImpl {
	const doFetch: FetchImpl = options.fetchImpl ?? fetch;
	// The store must share this transport, or an injected fetch (tests, proxies)
	// silently bypasses it for key discovery and hits the real network.
	const store = options.store ?? new CoordinatorKeyStore(undefined, doFetch);

	return async (input, init) => {
		const request = new Request(input, init);
		// Only POSTs with a body are sealable; GETs (model discovery) pass through.
		if (request.method !== "POST") return doFetch(input, init);

		const plaintextBody = await request.text();
		if (plaintextBody.length === 0) return doFetch(input, init);
		const providerPin = options.providerPin;
		const routedBody = providerPin
			? addProviderPin(plaintextBody, providerPin)
			: plaintextBody;

		let coordKey: CoordinatorKey;
		try {
			coordKey = await store.get(options.baseUrl);
		} catch (error) {
			// Never downgrade silently: if the caller asked for sealing and the
			// key cannot be had, the request must fail rather than leak.
			throw new Error(
				`darkbloom-sealed: refusing to send plaintext — ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		const sealed = sealRawRequest(encodeUtf8(routedBody), coordKey);
		const headers = new Headers(request.headers);
		headers.set("Content-Type", SEALED_CONTENT_TYPE);

		const response = await doFetch(request.url, {
			method: "POST",
			headers,
			body: sealed.envelopeJson,
			...(request.signal ? { signal: request.signal } : {}),
		});

		if (response.ok && providerPin) {
			try {
				verifyPinnedProvider(response.headers, providerPin);
			} catch (error) {
				void response.body?.cancel();
				throw error;
			}
		}

		const responseType = response.headers.get("content-type") ?? "";
		const outHeaders = new Headers(response.headers);

		if (!response.ok) {
			// Pre-decryption transport errors (bad envelope/kid) are plaintext;
			// downstream routing/admission errors are written through the sealing
			// response writer and arrive as buffered ciphertext. Preserve both.
			const text = await response.text();
			if (response.status === 400 && text.includes("kid_mismatch")) store.clear();
			if (text.includes('"ciphertext"')) {
				let body: string;
				try {
					body = unsealResponse(text, sealed.ephemeralPrivateKey, coordKey.publicKey);
				} catch (error) {
					throw new Error(
						`darkbloom-sealed: error response advertised ciphertext but failed to unseal — ${error instanceof Error ? error.message : String(error)}`,
					);
				}
				outHeaders.set("Content-Type", JSON_CONTENT_TYPE);
				outHeaders.delete("Content-Length");
				return new Response(body, {
					status: response.status,
					statusText: response.statusText,
					headers: outHeaders,
				});
			}
			return new Response(text, {
				status: response.status,
				statusText: response.statusText,
				headers: outHeaders,
			});
		}

		if (responseType.includes(SSE_CONTENT_TYPE)) {
			if (!response.body) throw new Error("darkbloom-sealed: SSE response had no body");
			outHeaders.set("Content-Type", SSE_CONTENT_TYPE);
			outHeaders.delete("Content-Length");
			return new Response(
				unsealSseStream(response.body, sealed.ephemeralPrivateKey, coordKey.publicKey),
				{ status: response.status, statusText: response.statusText, headers: outHeaders },
			);
		}

		const raw = await response.text();
		let body: string;
		try {
			// A sealed request requires a sealed successful response. Accepting a
			// plaintext 2xx silently downgrades the caller's confidentiality claim.
			body = unsealResponse(raw, sealed.ephemeralPrivateKey, coordKey.publicKey);
		} catch (error) {
			throw new Error(
				`darkbloom-sealed: successful buffered response was not valid sealed ciphertext — ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		outHeaders.set("Content-Type", JSON_CONTENT_TYPE);
		outHeaders.delete("Content-Length");
		return new Response(body, {
			status: response.status,
			statusText: response.statusText,
			headers: outHeaders,
		});
	};
}
