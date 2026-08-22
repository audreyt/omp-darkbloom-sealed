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

export interface SealedFetchOptions {
	/** Coordinator origin, e.g. `https://api.darkbloom.dev`. */
	baseUrl: string;
	store?: CoordinatorKeyStore;
	/** Underlying transport; injectable for tests. */
	fetchImpl?: typeof fetch;
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

		const sealed = sealRawRequest(encodeUtf8(plaintextBody), coordKey);
		const headers = new Headers(request.headers);
		headers.set("Content-Type", SEALED_CONTENT_TYPE);
		headers.delete("Content-Length");

		const response = await doFetch(request.url, {
			method: "POST",
			headers,
			body: sealed.envelopeJson,
			...(request.signal ? { signal: request.signal } : {}),
		});

		const responseType = response.headers.get("content-type") ?? "";
		const outHeaders = new Headers(response.headers);

		if (!response.ok) {
			// Errors come back unsealed; hand them through so omp can classify.
			if (response.status === 400 && responseType.includes("json")) {
				const text = await response.text();
				if (text.includes("kid_mismatch")) store.clear();
				return new Response(text, {
					status: response.status,
					statusText: response.statusText,
					headers: outHeaders,
				});
			}
			return response;
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
		// A coordinator without sealing configured answers plaintext JSON; only
		// unseal what actually looks like an envelope.
		const looksSealed = raw.includes('"ciphertext"');
		const body = looksSealed
			? unsealResponse(raw, sealed.ephemeralPrivateKey, coordKey.publicKey)
			: raw;
		outHeaders.set("Content-Type", JSON_CONTENT_TYPE);
		outHeaders.delete("Content-Length");
		return new Response(body, {
			status: response.status,
			statusText: response.statusText,
			headers: outHeaders,
		});
	};
}
