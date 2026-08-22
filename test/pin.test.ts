import { describe, expect, test } from "bun:test";
import { resolveProviderPin } from "../src/index";

const VALID_KEY = Buffer.alloc(64, 7).toString("base64");

describe("resolveProviderPin", () => {
	test("leaves public routing unchanged when no pin is configured", () => {
		expect(resolveProviderPin({})).toBeUndefined();
	});

	test("requires serial and Secure Enclave key together", () => {
		expect(() =>
			resolveProviderPin({ DARKBLOOM_PROVIDER_SERIAL: "JYKJDQ7WW3" }),
		).toThrow(/configured together/);
		expect(() =>
			resolveProviderPin({ DARKBLOOM_PROVIDER_SE_PUBLIC_KEY: VALID_KEY }),
		).toThrow(/configured together/);
	});

	test("rejects malformed serials and public keys", () => {
		expect(() =>
			resolveProviderPin({
				DARKBLOOM_PROVIDER_SERIAL: "Min.local",
				DARKBLOOM_PROVIDER_SE_PUBLIC_KEY: VALID_KEY,
			}),
		).toThrow(/invalid DARKBLOOM_PROVIDER_SERIAL/);
		expect(() =>
			resolveProviderPin({
				DARKBLOOM_PROVIDER_SERIAL: "JYKJDQ7WW3",
				DARKBLOOM_PROVIDER_SE_PUBLIC_KEY: Buffer.alloc(32).toString("base64"),
			}),
		).toThrow(/base64 64-byte/);
	});

	test("returns the stable hardware identity for a valid pin", () => {
		expect(
			resolveProviderPin({
				DARKBLOOM_PROVIDER_SERIAL: "JYKJDQ7WW3",
				DARKBLOOM_PROVIDER_SE_PUBLIC_KEY: VALID_KEY,
			}),
		).toEqual({ serial: "JYKJDQ7WW3", sePublicKey: VALID_KEY });
	});
});
