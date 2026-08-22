# omp-darkbloom-sealed

An [omp](https://omp.sh) extension that NaCl-Box-seals every request body to the [Darkbloom](https://darkbloom.dev) coordinator's X25519 key, instead of relying on TLS alone.

## What this actually buys — and what it does not

**Buys:** no hop *before* the coordinator sees plaintext. `api.darkbloom.dev` sits behind a TLS-terminating reverse proxy (responses carry `via: 1.1 Caddy`), and sealing takes it out of the plaintext path. Real defence in depth.

**Does not buy:** confidentiality from Darkbloom. Their own canonical doc, `docs/architecture/security/encryption.md` in `Layr-Labs/d-inference`, is explicit — and opens by disowning contrary marketing:

> "This document is the canonical reference for Darkbloom's **hop-by-hop** encryption… The code is the source of truth; **marketing language that contradicts these paths is wrong**."
>
> "The coordinator **decrypts the consumer body inside Confidential VM memory**, runs routing and billing, then re-seals the response."
>
> *What the coordinator sees*: "**Prompt content while the request is in flight**." Followed by: "It **must not**: Log prompt content. Retain prompt content… Expose prompts to observability tools or human operators."

Verified in code at the line the doc cites — `coordinator/api/sender_encryption.go`:

```go
plaintext, ok := box.Open(nil, ct2[24:], &nonce, &ephemPub, &coordPriv)
```

…using `s.coordinatorKey.PrivateKey`, then handing `plaintext` to downstream handlers. The provider decrypts too: *"The provider decrypts prompts and runs inference. It sees: Prompt content."*

So **plaintext exists in two places per request**, and the guarantees there are CVM isolation, process hardening, and stated policy — **not key custody**. If you need the party you pay to be cryptographically unable to read your prompt, this is the wrong tool; client-to-enclave E2EE (see `~/w/omp-venice-e2ee`) is.

Use this because you want the edge out of the path, or on principle. Not because it makes Darkbloom blind.

## Design

Sealing is a transport concern, so it is applied as a `fetch` wrapper rather than a bespoke provider. `streamSimple` delegates to omp's own `openai-completions` implementation with `options.fetch` swapped:

```
Context ──omp openai-completions──► request JSON
        ──sealed fetch───────────► NaCl Box → application/eigeninference-sealed+json
        ──coordinator────────────► sealed SSE, one box per event
        ──sealed fetch───────────► unsealed plaintext SSE
        ──omp openai-completions──► native toolcall_* events
```

omp therefore does all request building and SSE parsing, **native `tool_calls` included** — no in-band dialect, unlike the Venice E2EE path where the gateway strips `tools`. omp uses this same wrap-fetch pattern internally (`wrapFetchForCch`).

Wire format mirrors `console-ui/src/lib/encryption.ts`: envelope `{kid, ephemeral_public_key, ciphertext}` where `ciphertext = 24-byte nonce || box`, base64. A fresh ephemeral keypair per request gives forward secrecy; responses are sealed back to that ephemeral public key.

## Install

```bash
vp install
vp run link:omp
ln -s "$PWD" ~/.omp/agent/extensions/omp-darkbloom-sealed
omp models refresh     # required, see below
```

Key resolution: `DARKBLOOM_API_KEY`, else `DARKBLOOM_KEY_FILE`, else `~/.darkbloom-key`. Override the origin with `DARKBLOOM_BASE_URL`.

```
/darkbloom-sealing     # which coordinator kid is in use
```

## Verified live

| Check | Result |
|---|---|
| Coordinator key | `kid=72190d50e78c876c`, `x25519-nacl-box` |
| Sealed non-streaming | HTTP 200, 745 ms, unsealed and parsed |
| Sealed SSE | 35 frames unsealed, content assembled correctly |
| Provider attestation | `Apple M4 Max` / `M3 Ultra`, `trust_level: hardware` |
| omp registration | `darkbloom-sealed (3)` |
| Agentic tool call | `read probe.txt` → correct contents returned |

## Fails closed

If the coordinator key cannot be fetched, the request **throws** rather than falling back to plaintext — the caller asked for sealing, so silently downgrading would be the one unacceptable outcome. A tampered or wrongly-keyed payload throws for the same reason. `GET`s (model discovery) pass through unsealed by design.

## Two traps worth knowing

**Discovery fields are nested.** `provider_count` lives under `metadata`, not at the entry root. Reading it from the root silently yielded zero models and omp dropped the provider **with no diagnostic**. Worse, `provider_count` is not the availability signal at all: `gemma-4-26b` reports `provider_count: 0` alongside `routable_providers: 62` and serves fine. The gate is `metadata.can_accept`.

**Empty discovery is cached.** omp caches `fetchDynamicModels` in SQLite with a 24 h TTL, so the zero-model result above persisted after the fix until `omp models refresh`.

**`compat` must be an object.** A delegated model built with `{...model, api: "openai-completions"}` leaves `compat` undefined, and the completions path reads fields off it directly (`baseCompat.disableReasoningOnForcedToolChoice`) and throws.

## Models

Discovered live, gated on `metadata.can_accept`, priced from the entry's own per-token `pricing` (×10⁶):

| Model | Context | Out | $/Mtok in / out |
|---|---|---|---|
| `gpt-oss-20b` | 131 072 | 32 768 | $0.02 / $0.10 |
| `gemma-4-26b` | 131 072 | 32 768 | $0.05 / $0.25 |
| `qwen3.6-35b-a3b-vl-mtp-mxfp8` | 262 144 | 8 192 | $0.08 / $0.75 |

The ceiling is the catch: 35B MoE with 3B active. The docs' Qwen3.5 122B and MiniMax M2.5 239B tiers are not online. Good as a cheap, fast, high-volume rung; not a primary agentic coding model.

## Verify

```bash
vp run typecheck
vp test              # 10 tests
vp run smoke         # live sealed round trip
```
