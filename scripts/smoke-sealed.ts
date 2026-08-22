/**
 * Live sealed round trip: buffered JSON and SSE, plus what the provider was.
 *
 *   vp run smoke
 *   vp run smoke -- --model gemma-4-26b
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createSealedFetch } from "../src/fetch";
import { CoordinatorKeyStore } from "../src/sealed";
import { resolveProviderPin } from "../src/index";

const BASE_URL = process.env.DARKBLOOM_BASE_URL?.trim() ?? "https://api.darkbloom.dev";

async function resolveApiKey(): Promise<string> {
	const fromEnv = process.env.DARKBLOOM_API_KEY?.trim();
	if (fromEnv) return fromEnv;
	const path = join(process.env.HOME ?? "", ".darkbloom-key");
	if (!existsSync(path)) throw new Error("no DARKBLOOM_API_KEY and no ~/.darkbloom-key");
	return (await readFile(path, "utf8")).trim();
}

const argv = process.argv.slice(2);
const model = argv.includes("--model") ? String(argv[argv.indexOf("--model") + 1]) : "gpt-oss-20b";

const apiKey = await resolveApiKey();
const store = new CoordinatorKeyStore();
const providerPin = resolveProviderPin();
const key = await store.get(BASE_URL);
console.log(`coordinator: kid=${key.kid} alg=${key.algorithm} at ${BASE_URL}`);
console.log(`model:       ${model}`);
console.log(
	providerPin
		? `note:        coordinator CVM decrypts; provider is hard-pinned to serial=${providerPin.serial}, no public fallback`
		: "note:        coordinator and provider still decrypt; this seals the edge only",
);
console.log("");

const sealedFetch = createSealedFetch({ baseUrl: BASE_URL, store, providerPin });
const headers = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };

const describeProvider = (response: Response): string =>
	[
		response.headers.get("x-provider-chip"),
		response.headers.get("x-provider-model"),
		`trust=${response.headers.get("x-provider-trust-level")}`,
		`enclave=${response.headers.get("x-provider-secure-enclave")}`,
		`encrypted=${response.headers.get("x-provider-encrypted")}`,
		`sekey=${response.headers.has("x-attestation-se-public-key") ? "present" : "missing"}`,
	]
		.filter(Boolean)
		.join(" ");

function recordOf(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function completionContent(value: unknown): string {
	const root = recordOf(value);
	const choices = root?.choices;
	if (!Array.isArray(choices)) return "";
	const first = recordOf(choices[0]);
	const message = recordOf(first?.message);
	return typeof message?.content === "string" ? message.content : "";
}

function streamDelta(value: unknown): string {
	const root = recordOf(value);
	const choices = root?.choices;
	if (!Array.isArray(choices)) return "";
	const first = recordOf(choices[0]);
	const delta = recordOf(first?.delta);
	return typeof delta?.content === "string" ? delta.content : "";
}

// --- buffered ---------------------------------------------------------------
{
	const started = Date.now();
	const response = await sealedFetch(`${BASE_URL}/v1/chat/completions`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			model,
			messages: [{ role: "user", content: "Reply with exactly SEALED." }],
			max_tokens: 200,
		}),
	});
	const text = await response.text();
	console.log(`buffered: http=${response.status} ${Date.now() - started}ms`);
	console.log(`  provider: ${describeProvider(response)}`);
	if (!response.ok) {
		console.log(`  error:     ${text.slice(0, 500)}\n`);
		process.exitCode = 1;
	} else {
		const payload: unknown = JSON.parse(text);
		const root = recordOf(payload);
		console.log(`  content:  ${JSON.stringify(completionContent(payload))}`);
		console.log(`  usage:    ${JSON.stringify(root?.usage ?? {})}\n`);
	}
}

// --- streaming --------------------------------------------------------------
{
	const started = Date.now();
	const response = await sealedFetch(`${BASE_URL}/v1/chat/completions`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			model,
			stream: true,
			max_tokens: 200,
			messages: [{ role: "user", content: "Reply with exactly SEALED." }],
		}),
	});
	const text = await response.text();
	const frames = text.split("\n\n").filter((frame) => frame.trim().length > 0);
	let content = "";
	for (const frame of frames) {
		const data = frame.replace(/^data: /, "");
		if (data === "[DONE]") continue;
		try {
			content += streamDelta(JSON.parse(data));
		} catch {
			// A frame that is not JSON after unsealing is a protocol change worth
			// seeing rather than swallowing silently.
			console.log(`  non-JSON frame: ${data.slice(0, 80)}`);
		}
	}
	console.log(`streaming: http=${response.status} ${Date.now() - started}ms`);
	console.log(`  provider: ${describeProvider(response)}`);
	console.log(`  frames:   ${frames.length} unsealed`);
	console.log(`  content:  ${JSON.stringify(content)}`);
	if (!response.ok) {
		console.log(`  error:     ${text.slice(0, 500)}`);
		process.exitCode = 1;
	}
}
