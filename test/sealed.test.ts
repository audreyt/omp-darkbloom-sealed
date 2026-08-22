import { describe, expect, test } from "bun:test";
import nacl from "tweetnacl";
import { createSealedFetch } from "../src/fetch";
import type { CoordinatorKey } from "../src/sealed";
import {
	CoordinatorKeyStore,
	SEALED_CONTENT_TYPE,
	base64Decode,
	base64Encode,
	encodeUtf8,
	sealRawRequest,
	unsealResponse,
	unsealSseEvent,
} from "../src/sealed";

/** Stands in for the coordinator: holds the private key, opens the box. */
function fakeCoordinator() {
	const pair = nacl.box.keyPair();
	const key: CoordinatorKey = {
		kid: "72190d50e78c876c",
		publicKey: pair.publicKey,
		algorithm: "x25519-nacl-box",
	};
	const open = (envelopeJson: string): string => {
		const env = JSON.parse(envelopeJson) as {
			kid: string;
			ephemeral_public_key: string;
			ciphertext: string;
		};
		const sealed = base64Decode(env.ciphertext);
		const nonce = sealed.subarray(0, nacl.box.nonceLength);
		const ct = sealed.subarray(nacl.box.nonceLength);
		const pt = nacl.box.open(
			new Uint8Array(ct),
			new Uint8Array(nonce),
			base64Decode(env.ephemeral_public_key),
			pair.secretKey,
		);
		if (!pt) throw new Error("coordinator could not open the box");
		return new TextDecoder().decode(pt);
	};
	const seal = (plaintext: string, clientPub: Uint8Array): string => {
		const nonce = nacl.randomBytes(nacl.box.nonceLength);
		const ct = nacl.box(encodeUtf8(plaintext), nonce, clientPub, pair.secretKey);
		const out = new Uint8Array(nonce.length + ct.length);
		out.set(nonce, 0);
		out.set(ct, nonce.length);
		return base64Encode(out);
	};
	return { key, pair, open, seal };
}

describe("seal / unseal round trip", () => {
	test("envelope carries kid, ephemeral key and nonce-prefixed ciphertext", () => {
		const coord = fakeCoordinator();
		const sealed = sealRawRequest(encodeUtf8('{"model":"gpt-oss-20b"}'), coord.key);
		const env = JSON.parse(sealed.envelopeJson) as Record<string, string>;
		expect(env.kid).toBe("72190d50e78c876c");
		expect(base64Decode(env.ephemeral_public_key!).length).toBe(nacl.box.publicKeyLength);
		// 24-byte nonce prefix, then the box (which adds a 16-byte MAC).
		expect(base64Decode(env.ciphertext!).length).toBeGreaterThan(nacl.box.nonceLength + 16);
		expect(coord.open(sealed.envelopeJson)).toBe('{"model":"gpt-oss-20b"}');
	});

	test("each request uses a fresh ephemeral key", () => {
		const coord = fakeCoordinator();
		const a = sealRawRequest(encodeUtf8("x"), coord.key);
		const b = sealRawRequest(encodeUtf8("x"), coord.key);
		expect(base64Encode(a.ephemeralPublicKey)).not.toBe(base64Encode(b.ephemeralPublicKey));
	});

	test("response unseals with the request's ephemeral private key", () => {
		const coord = fakeCoordinator();
		const sealed = sealRawRequest(encodeUtf8("q"), coord.key);
		const envelope = JSON.stringify({
			kid: coord.key.kid,
			ciphertext: coord.seal('{"ok":true}', sealed.ephemeralPublicKey),
		});
		expect(unsealResponse(envelope, sealed.ephemeralPrivateKey, coord.key.publicKey)).toBe(
			'{"ok":true}',
		);
	});

	// Fail closed: a tampered payload must throw, never surface as plaintext.
	test("tampered ciphertext throws instead of degrading", () => {
		const coord = fakeCoordinator();
		const sealed = sealRawRequest(encodeUtf8("q"), coord.key);
		const good = coord.seal("secret", sealed.ephemeralPublicKey);
		const bytes = base64Decode(good);
		const last = bytes.length - 1;
		bytes.set([(bytes.at(last) ?? 0) ^ 0xff], last);
		expect(() =>
			unsealSseEvent(base64Encode(bytes), sealed.ephemeralPrivateKey, coord.key.publicKey),
		).toThrow(/failed to decrypt/);
	});

	test("payload shorter than the nonce is rejected", () => {
		const coord = fakeCoordinator();
		const sealed = sealRawRequest(encodeUtf8("q"), coord.key);
		expect(() =>
			unsealSseEvent(base64Encode(new Uint8Array(8)), sealed.ephemeralPrivateKey, coord.key.publicKey),
		).toThrow(/shorter than the nonce/);
	});
});

describe("CoordinatorKeyStore", () => {
	test("caches by base url and refetches after clear", async () => {
		const coord = fakeCoordinator();
		let calls = 0;
		const impl = (async () => {
			calls++;
			return new Response(
				JSON.stringify({
					kid: coord.key.kid,
					public_key: base64Encode(coord.key.publicKey),
					algorithm: "x25519-nacl-box",
				}),
				{ status: 200 },
			);
		}) as unknown as typeof fetch;
		const store = new CoordinatorKeyStore(60_000, impl);
		await store.get("https://api.darkbloom.dev");
		await store.get("https://api.darkbloom.dev");
		expect(calls).toBe(1);
		store.clear();
		await store.get("https://api.darkbloom.dev");
		expect(calls).toBe(2);
	});

	test("a 503 surfaces rather than allowing a plaintext fallback", async () => {
		const impl = (async () => new Response("{}", { status: 503 })) as unknown as typeof fetch;
		const store = new CoordinatorKeyStore(60_000, impl);
		await expect(store.get("https://api.darkbloom.dev")).rejects.toThrow(
			/sealing is not configured/,
		);
	});
});

describe("createSealedFetch", () => {
	test("seals the POST body, sets the sealed content type, and unseals SSE", async () => {
		const coord = fakeCoordinator();
		let sentContentType = "";
		let openedBody = "";

		const impl = (async (url: string | URL | Request, init?: RequestInit) => {
			const target = String(typeof url === "string" ? url : (url as Request).url ?? url);
			if (target.endsWith("/v1/encryption-key")) {
				return new Response(
					JSON.stringify({
						kid: coord.key.kid,
						public_key: base64Encode(coord.key.publicKey),
						algorithm: "x25519-nacl-box",
					}),
					{ status: 200 },
				);
			}
			const headers = new Headers(init?.headers);
			sentContentType = headers.get("content-type") ?? "";
			openedBody = coord.open(String(init?.body));
			// The client's ephemeral pubkey is in the envelope it just sent.
			const clientPub = base64Decode(
				(JSON.parse(String(init?.body)) as { ephemeral_public_key: string })
					.ephemeral_public_key,
			);
			const frames = [
				`data: ${coord.seal('data: {"choices":[{"delta":{"content":"hi"}}]}', clientPub)}\n\n`,
				"data: [DONE]\n\n",
			].join("");
			return new Response(frames, {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			});
		}) as unknown as typeof fetch;

		const sealedFetch = createSealedFetch({
			baseUrl: "https://api.darkbloom.dev",
			fetchImpl: impl,
		});
		const res = await sealedFetch("https://api.darkbloom.dev/v1/chat/completions", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: '{"model":"gpt-oss-20b","stream":true}',
		});

		expect(sentContentType).toBe(SEALED_CONTENT_TYPE);
		// The origin never saw the plaintext; the fake coordinator had to open it.
		expect(openedBody).toBe('{"model":"gpt-oss-20b","stream":true}');
		const text = await res.text();
		// Unsealed back into ordinary SSE that omp's parser can consume.
		expect(text).toContain('data: {"choices":[{"delta":{"content":"hi"}}]}');
		expect(text).toContain("data: [DONE]");
		expect(res.headers.get("content-type")).toBe("text/event-stream");
	});

	test("GET passes through unsealed", async () => {
		let sawSealed = false;
		const impl = (async (_url: string, init?: RequestInit) => {
			const ct = new Headers(init?.headers).get("content-type") ?? "";
			if (ct === SEALED_CONTENT_TYPE) sawSealed = true;
			return new Response('{"data":[]}', { status: 200 });
		}) as unknown as typeof fetch;
		const sealedFetch = createSealedFetch({
			baseUrl: "https://api.darkbloom.dev",
			fetchImpl: impl,
		});
		await sealedFetch("https://api.darkbloom.dev/v1/models", { method: "GET" });
		expect(sawSealed).toBe(false);
	});

	test("refuses to send when the coordinator key is unavailable", async () => {
		const impl = (async (url: string) =>
			String(url).endsWith("/v1/encryption-key")
				? new Response("{}", { status: 503 })
				: new Response("{}", { status: 200 })) as unknown as typeof fetch;
		const sealedFetch = createSealedFetch({
			baseUrl: "https://api.darkbloom.dev",
			fetchImpl: impl,
		});
		await expect(
			sealedFetch("https://api.darkbloom.dev/v1/chat/completions", {
				method: "POST",
				body: '{"a":1}',
			}),
		).rejects.toThrow(/refusing to send plaintext/);
	});
});
