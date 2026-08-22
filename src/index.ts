/**
 * omp extension: NaCl-sealed transport to the Darkbloom coordinator.
 *
 * Registers a `darkbloom-sealed` provider whose `streamSimple` delegates to
 * omp's own `openai-completions` implementation with a sealing `fetch`. omp
 * therefore does all the request building and SSE parsing — native `tool_calls`
 * included — and this extension only transforms wire bytes.
 *
 * What sealing buys, precisely: the request body is NaCl-Boxed to the
 * coordinator's X25519 key, so no hop before the coordinator sees plaintext
 * (`api.darkbloom.dev` sits behind a TLS-terminating proxy — responses carry
 * `via: 1.1 Caddy`). The coordinator still opens the box to route and bill, and
 * the provider still decrypts to run inference. Read
 * `docs/architecture/security/encryption.md` in Layr-Labs/d-inference before
 * treating this as end-to-end confidentiality; it is hop-by-hop by design.
 */

import { streamSimple } from "@oh-my-pi/pi-ai";
import type {
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createSealedFetch } from "./fetch";
import { CoordinatorKeyStore } from "./sealed";

const PROVIDER_ID = "darkbloom-sealed";
const API_ID = "darkbloom-sealed-completions";
const DEFAULT_BASE_URL = "https://api.darkbloom.dev";
const ENV_API_KEY = "DARKBLOOM_API_KEY";
const ENV_KEY_FILE = "DARKBLOOM_KEY_FILE";
const ENV_BASE_URL = "DARKBLOOM_BASE_URL";

interface DarkbloomModel {
	id: string;
	name: string;
	contextLength: number;
	maxTokens: number;
	/** USD per million tokens. */
	inputUsd: number;
	outputUsd: number;
	image: boolean;
	trustLevel: string;
	attestedProviders: number;
}

/** One `/v1/models` entry. Availability and trust live under `metadata`. */
interface DarkbloomModelEntry {
	id: string;
	name?: string;
	context_length?: number;
	max_output_length?: number;
	input_modalities?: string[];
	/** Per-token USD strings, e.g. "0.00000002". */
	pricing?: { prompt?: string; completion?: string };
	metadata?: {
		provider_count?: number;
		attested_providers?: number;
		routable_providers?: number;
		trust_level?: string;
		can_accept?: boolean;
		display_name?: string;
	};
}

const PER_TOKEN_TO_PER_MILLION = 1_000_000;

/**
 * Discovers models that can actually serve a request right now.
 *
 * `provider_count` is nested under `metadata`, not top level — reading it from
 * the entry root silently yielded zero models and the provider was dropped.
 * `can_accept` is the coordinator's own verdict, so it is the gate.
 */
async function fetchDarkbloomModels(
	baseUrl: string,
	apiKey: string,
): Promise<DarkbloomModel[]> {
	const response = await fetch(`${baseUrl}/v1/models`, {
		headers: { Authorization: `Bearer ${apiKey}` },
	});
	if (!response.ok) {
		throw new Error(`darkbloom model discovery HTTP ${response.status}`);
	}
	const payload = (await response.json()) as { data?: DarkbloomModelEntry[] };

	const out: DarkbloomModel[] = [];
	for (const entry of payload.data ?? []) {
		const meta = entry.metadata ?? {};
		const routable = meta.can_accept ?? (meta.provider_count ?? 0) > 0;
		// Listing a model with no provider online only defers the failure to
		// dispatch time, where it reads as a mysterious routing error.
		if (!routable) continue;
		const contextLength = entry.context_length ?? 32_768;
		out.push({
			id: entry.id,
			name: `${meta.display_name ?? entry.name ?? entry.id} (Darkbloom sealed)`,
			contextLength,
			maxTokens: Math.min(entry.max_output_length ?? 8_192, contextLength),
			inputUsd: Number.parseFloat(entry.pricing?.prompt ?? "0") * PER_TOKEN_TO_PER_MILLION,
			outputUsd:
				Number.parseFloat(entry.pricing?.completion ?? "0") * PER_TOKEN_TO_PER_MILLION,
			image: (entry.input_modalities ?? []).includes("image"),
			trustLevel: meta.trust_level ?? "unknown",
			attestedProviders: meta.attested_providers ?? 0,
		});
	}
	return out.sort((a, b) => a.id.localeCompare(b.id));
}

async function resolveApiKey(): Promise<string | undefined> {
	const fromEnv = process.env[ENV_API_KEY]?.trim();
	if (fromEnv) return fromEnv;
	const path = process.env[ENV_KEY_FILE]?.trim() ?? `${process.env.HOME}/.darkbloom-key`;
	const file = Bun.file(path);
	if (!(await file.exists())) return undefined;
	return (await file.text()).trim();
}

export default async function darkbloomSealed(pi: ExtensionAPI): Promise<void> {
	const apiKey = await resolveApiKey();
	if (!apiKey) {
		pi.logger?.info(`${PROVIDER_ID}: no ${ENV_API_KEY} and no key file; not registered`);
		return;
	}
	const baseUrl = process.env[ENV_BASE_URL]?.trim() ?? DEFAULT_BASE_URL;
	const store = new CoordinatorKeyStore();
	const sealedFetch = createSealedFetch({ baseUrl, store });

	pi.registerProvider(PROVIDER_ID, {
		baseUrl: `${baseUrl}/v1`,
		apiKey,
		api: API_ID,
		streamSimple: (model, context, options): AssistantMessageEventStream => {
			// Delegate to omp's openai-completions path, swapping only the
			// transport. The model is cloned rather than mutated so a shared
			// registry entry is not rewritten under other callers.
			//
			// `compat` must be an object: the completions path reads fields off
			// it directly (`baseCompat.disableReasoningOnForcedToolChoice`) and
			// throws on undefined, which is what a bare `{...model}` produces
			// for an extension-registered model.
			const delegated = {
				...model,
				api: "openai-completions",
				compat: model.compat ?? {},
			} as Model;
			const delegatedOptions: SimpleStreamOptions = {
				...(options ?? {}),
				apiKey,
				fetch: sealedFetch,
			};
			return streamSimple(delegated, context as Context, delegatedOptions);
		},
		fetchDynamicModels: async (resolved) => {
			const models = await fetchDarkbloomModels(baseUrl, resolved ?? apiKey);
			return models.map((m) => ({
				id: m.id,
				name: m.name,
				api: API_ID,
				reasoning: true,
				input: m.image ? ["text", "image"] : ["text"],
				cost: { input: m.inputUsd, output: m.outputUsd, cacheRead: 0, cacheWrite: 0 },
				contextWindow: m.contextLength,
				maxTokens: m.maxTokens,
			}));
		},
	});

	pi.registerCommand("darkbloom-sealing", {
		description: "Show the Darkbloom coordinator sealing key in use",
		handler: async (_args, ctx) => {
			try {
				const key = await store.get(baseUrl);
				ctx.ui.notify(
					`sealing to kid=${key.kid} alg=${key.algorithm} at ${baseUrl} — coordinator and provider still decrypt`,
					"info",
				);
			} catch (error) {
				ctx.ui.notify(
					`sealing unavailable: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
			}
		},
	});
}
