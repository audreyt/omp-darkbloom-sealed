/**
 * Link the installed omp packages into local `node_modules`.
 *
 * omp provides `@oh-my-pi/*` to the extension at load time, so they must not be
 * vendored — installing them pulls omp's whole native tree (~800 MB) and can
 * drift from the host version. Symlinking the real installation gives
 * typecheck and `bun test` the same code the runtime will use.
 *
 * Run via `vp run link:omp` after `vp install`.
 */

import { existsSync } from "node:fs";
import { mkdir, rm, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";

const PACKAGES = ["pi-ai", "pi-coding-agent", "pi-catalog", "pi-utils"];

const CANDIDATE_ROOTS = [
	join(process.env.HOME ?? "", ".bun/install/global/node_modules/@oh-my-pi"),
	"/opt/homebrew/lib/node_modules/@oh-my-pi",
	"/usr/local/lib/node_modules/@oh-my-pi",
];

const root = CANDIDATE_ROOTS.find((candidate) => existsSync(candidate));
if (!root) {
	console.error(
		"omp packages not found. Looked in:\n" +
			CANDIDATE_ROOTS.map((c) => `  ${c}`).join("\n"),
	);
	process.exit(1);
}

const target = join(import.meta.dir, "..", "node_modules", "@oh-my-pi");
await mkdir(target, { recursive: true });

for (const name of PACKAGES) {
	const source = join(root, name);
	if (!existsSync(source)) {
		console.log(`skip ${name} (not installed)`);
		continue;
	}
	const link = join(target, name);
	await rm(link, { force: true, recursive: true });
	await mkdir(dirname(link), { recursive: true });
	await symlink(source, link, "dir");
	console.log(`linked ${name} -> ${source}`);
}
