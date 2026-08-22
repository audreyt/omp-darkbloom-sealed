/**
 * NaCl Box sealing for the Darkbloom coordinator.
 *
 * Mirrors `console-ui/src/lib/encryption.ts` and
 * `coordinator/api/sender_encryption.go`: fetch the coordinator's long-lived
 * X25519 key from `GET /v1/encryption-key`, seal each request body to it with a
 * fresh ephemeral keypair, and POST as `application/eigeninference-sealed+json`.
 *
 * Scope, stated plainly: this removes every hop *before* the coordinator from
 * the plaintext path — notably the TLS-terminating reverse proxy that fronts
 * `api.darkbloom.dev` (responses carry `via: 1.1 Caddy`). It does NOT hide the
 * body from the coordinator, which holds the private key and opens the box to
 * route and bill (`sender_encryption.go`, `box.Open` with
 * `s.coordinatorKey.PrivateKey`), nor from the provider, which decrypts to run
 * inference. Those two are constrained by CVM isolation, process hardening and
 * stated policy — not by key custody.
 */

import type { FetchImpl } from "@oh-my-pi/pi-utils";
import nacl from "tweetnacl";

export const SEALED_CONTENT_TYPE = "application/eigeninference-sealed+json";
export const ENCRYPTION_KEY_PATH = "/v1/encryption-key";

export interface CoordinatorKey {
	kid: string;
	publicKey: Uint8Array;
	algorithm: string;
}

export interface SealedRequest {
	envelopeJson: string;
	ephemeralPublicKey: Uint8Array;
	ephemeralPrivateKey: Uint8Array;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function base64Encode(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

export function base64Decode(b64: string): Uint8Array {
	const binary = atob(b64);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}

/** Seals raw bytes; wire format is `24-byte nonce || box`, base64 in the envelope. */
export function sealRawRequest(
	plaintext: Uint8Array,
	coordKey: CoordinatorKey,
): SealedRequest {
	const ephem = nacl.box.keyPair();
	const nonce = nacl.randomBytes(nacl.box.nonceLength);
	// tweetnacl rejects subarray views and SharedArrayBuffer-backed arrays.
	const ct = nacl.box(new Uint8Array(plaintext), nonce, coordKey.publicKey, ephem.secretKey);
	const sealed = new Uint8Array(nonce.length + ct.length);
	sealed.set(nonce, 0);
	sealed.set(ct, nonce.length);
	return {
		envelopeJson: JSON.stringify({
			kid: coordKey.kid,
			ephemeral_public_key: base64Encode(ephem.publicKey),
			ciphertext: base64Encode(sealed),
		}),
		ephemeralPublicKey: ephem.publicKey,
		ephemeralPrivateKey: ephem.secretKey,
	};
}

function openSealed(
	sealed: Uint8Array,
	ephemeralPrivateKey: Uint8Array,
	coordPub: Uint8Array,
): Uint8Array {
	if (sealed.length < nacl.box.nonceLength) {
		throw new Error("sealed payload shorter than the nonce prefix");
	}
	const nonce = new Uint8Array(sealed.subarray(0, nacl.box.nonceLength));
	const ct = new Uint8Array(sealed.subarray(nacl.box.nonceLength));
	const pt = nacl.box.open(ct, nonce, coordPub, ephemeralPrivateKey);
	if (!pt) {
		// Fail closed. A tampered or wrongly-keyed payload must never fall
		// through as if it were plaintext.
		throw new Error("sealed payload failed to decrypt — wrong key or tampered ciphertext");
	}
	return pt;
}

/** Unseals a buffered `{kid, ciphertext}` response envelope. */
export function unsealResponse(
	body: string,
	ephemeralPrivateKey: Uint8Array,
	coordPub: Uint8Array,
): string {
	const env = JSON.parse(body) as { kid?: string; ciphertext?: string };
	if (!env.ciphertext) throw new Error("sealed response envelope has no ciphertext");
	return textDecoder.decode(
		openSealed(base64Decode(env.ciphertext), ephemeralPrivateKey, coordPub),
	);
}

/**
 * Unseals one SSE event payload — the base64 that follows `data: `. The
 * plaintext is itself an SSE frame from the upstream source.
 */
export function unsealSseEvent(
	payloadB64: string,
	ephemeralPrivateKey: Uint8Array,
	coordPub: Uint8Array,
): string {
	return textDecoder.decode(
		openSealed(base64Decode(payloadB64), ephemeralPrivateKey, coordPub),
	);
}

/** Fetches and caches the coordinator key. Cache is keyed by base URL. */
export class CoordinatorKeyStore {
	readonly #ttlMs: number;
	readonly #fetchImpl: FetchImpl;
	#cache = new Map<string, { key: CoordinatorKey; expiresAt: number }>();

	constructor(ttlMs = 60 * 60 * 1000, fetchImpl: FetchImpl = fetch) {
		this.#ttlMs = ttlMs;
		this.#fetchImpl = fetchImpl;
	}

	/** Drop cached keys; call after a `kid_mismatch` response. */
	clear(): void {
		this.#cache.clear();
	}

	async get(baseUrl: string, force = false): Promise<CoordinatorKey> {
		const hit = this.#cache.get(baseUrl);
		if (!force && hit && hit.expiresAt > Date.now()) return hit.key;

		const response = await this.#fetchImpl(`${baseUrl}${ENCRYPTION_KEY_PATH}`);
		if (!response.ok) {
			// 503 is the coordinator's documented signal that sealing is not
			// configured; surface it rather than silently sending plaintext.
			throw new Error(
				`coordinator key unavailable (HTTP ${response.status}) — sealing is not configured on ${baseUrl}`,
			);
		}
		const payload = (await response.json()) as {
			kid?: string;
			public_key?: string;
			algorithm?: string;
		};
		if (!payload.kid || !payload.public_key) {
			throw new Error("coordinator key response missing kid or public_key");
		}
		const key: CoordinatorKey = {
			kid: payload.kid,
			publicKey: base64Decode(payload.public_key),
			algorithm: payload.algorithm ?? "x25519-nacl-box",
		};
		this.#cache.set(baseUrl, { key, expiresAt: Date.now() + this.#ttlMs });
		return key;
	}
}

export function encodeUtf8(text: string): Uint8Array {
	return textEncoder.encode(text);
}
