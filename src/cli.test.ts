import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const tmp = () => mkdtemp(path.join(os.tmpdir(), "gmail-mcp-cli-"));

// GMAIL_MCP_ACCOUNTS_DIR / GMAIL_MCP_CREDENTIALS are read at import time; re-import per test with env set.
const freshCli = async (dir: string) => {
  vi.resetModules();
  vi.stubEnv("GMAIL_MCP_ACCOUNTS_DIR", path.join(dir, "accounts"));
  vi.stubEnv("GMAIL_MCP_CREDENTIALS", path.join(dir, "credentials.json"));
  const [index, auth] = await Promise.all([import("./index.js"), import("./auth.js")]);
  return { ...index, ...auth };
};

afterEach(() => vi.unstubAllEnvs());

describe("cli", () => {
  it("accounts: prints a hint and returns true when nothing is signed in", async () => {
    const dir = await tmp();
    const { cli } = await freshCli(dir);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(cli(["accounts"])).resolves.toBe(true);
      expect(spy.mock.calls.map((c) => c.join(" ")).join("\n")).toContain("No accounts. Run: gmail-mcp auth");
    } finally {
      spy.mockRestore();
    }
  });

  it("accounts: lists signed-in accounts with no default marker", async () => {
    const dir = await tmp();
    const { cli, saveAccountTokens } = await freshCli(dir);
    await saveAccountTokens("amy@example.com", { refresh_token: "a" });
    await saveAccountTokens("bob@example.com", { refresh_token: "b" });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(cli(["accounts"])).resolves.toBe(true);
      const out = spy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(out).toContain("amy@example.com");
      expect(out).toContain("bob@example.com");
      expect(out).not.toContain("*");
    } finally {
      spy.mockRestore();
    }
  });

  it("token: prints the account's token on stdout, minting one when missing", async () => {
    const dir = await tmp();
    const { cli, saveAccountTokens, readAccountToken } = await freshCli(dir);
    await saveAccountTokens("amy@example.com", { refresh_token: "a" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(cli(["token", "Amy@Example.com"])).resolves.toBe(true);
      const minted = await readAccountToken("amy@example.com");
      expect(minted).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(log.mock.calls.flat()).toEqual([minted]);

      // A second call is stable.
      log.mockClear();
      await cli(["token", "amy@example.com"]);
      expect(log.mock.calls.flat()).toEqual([minted]);

      // --rotate replaces it.
      log.mockClear();
      await expect(cli(["token", "amy@example.com", "--rotate"])).resolves.toBe(true);
      const rotated = await readAccountToken("amy@example.com");
      expect(rotated).not.toBe(minted);
      expect(log.mock.calls.flat()).toEqual([rotated]);
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
  });

  it("token: rejects an unknown account or a missing email", async () => {
    const dir = await tmp();
    const { cli, saveAccountTokens } = await freshCli(dir);
    await saveAccountTokens("amy@example.com", { refresh_token: "a" });
    await expect(cli(["token", "nobody@example.com"])).rejects.toThrow(
      /Unknown account "nobody@example.com".*amy@example.com/
    );
    await expect(cli(["token"])).rejects.toThrow(/Usage: gmail-mcp token/);
  });

  it("auth --default: is gone and rejects as an unknown option", async () => {
    const dir = await tmp();
    const { cli } = await freshCli(dir);
    await expect(cli(["auth", "--default", "amy@example.com"])).rejects.toThrow(/Unknown option --default/);
  });

  it("auth --remove: removes an account and its token, or rejects with no value", async () => {
    const dir = await tmp();
    const { cli, saveAccountTokens, writeAccountToken, readAccountToken, listAccounts } = await freshCli(dir);
    await saveAccountTokens("amy@example.com", { refresh_token: "a" });
    await saveAccountTokens("bob@example.com", { refresh_token: "b" });
    await writeAccountToken("bob@example.com", "bob-token");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(cli(["auth", "--remove", "bob@example.com"])).resolves.toBe(true);
      expect(await listAccounts()).toEqual(["amy@example.com"]);
      expect(await readAccountToken("bob@example.com")).toBeUndefined();

      await expect(cli(["auth", "--remove"])).rejects.toThrow(/Usage: gmail-mcp auth --remove/);
    } finally {
      spy.mockRestore();
    }
  });

  it("auth --bogus: rejects with an unknown-option message", async () => {
    const dir = await tmp();
    const { cli } = await freshCli(dir);
    await expect(cli(["auth", "--bogus"])).rejects.toThrow(/Unknown option --bogus/);
  });

  it("auth: with no flag, runs authorize() and propagates its failure", async () => {
    const dir = await tmp();
    const { cli } = await freshCli(dir);
    await expect(cli(["auth"])).rejects.toThrow(/ENOENT|no such file/);
  });

  it("returns false for anything else, leaving it to the caller", async () => {
    const dir = await tmp();
    const { cli } = await freshCli(dir);
    await expect(cli(["serve-something-else"])).resolves.toBe(false);
  });
});
