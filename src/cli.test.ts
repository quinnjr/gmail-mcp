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

  it("accounts: lists signed-in accounts, marking the default", async () => {
    const dir = await tmp();
    const { cli, saveAccountTokens, writeDefault } = await freshCli(dir);
    await saveAccountTokens("amy@example.com", { refresh_token: "a" });
    await saveAccountTokens("bob@example.com", { refresh_token: "b" });
    await writeDefault("bob@example.com");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(cli(["accounts"])).resolves.toBe(true);
      const out = spy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(out).toContain("  amy@example.com");
      expect(out).toContain("* bob@example.com");
    } finally {
      spy.mockRestore();
    }
  });

  it("auth --default: sets the default (normalized) or rejects an unknown account or missing value", async () => {
    const dir = await tmp();
    const { cli, saveAccountTokens, readDefault } = await freshCli(dir);
    await saveAccountTokens("amy@example.com", { refresh_token: "a" });
    await saveAccountTokens("bob@example.com", { refresh_token: "b" });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(cli(["auth", "--default", "Amy@Example.com"])).resolves.toBe(true);
      expect(await readDefault()).toBe("amy@example.com");

      await expect(cli(["auth", "--default", "nobody@example.com"])).rejects.toThrow(
        /Unknown account "nobody@example.com".*amy@example.com, bob@example.com/
      );
      await expect(cli(["auth", "--default"])).rejects.toThrow(/Usage: gmail-mcp auth --default/);
    } finally {
      spy.mockRestore();
    }
  });

  it("auth --remove: removes an account and repoints the default, or rejects with no value", async () => {
    const dir = await tmp();
    const { cli, saveAccountTokens, writeDefault, readDefault, listAccounts } = await freshCli(dir);
    await saveAccountTokens("amy@example.com", { refresh_token: "a" });
    await saveAccountTokens("bob@example.com", { refresh_token: "b" });
    await writeDefault("bob@example.com");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(cli(["auth", "--remove", "bob@example.com"])).resolves.toBe(true);
      expect(await listAccounts()).toEqual(["amy@example.com"]);
      expect(await readDefault()).toBe("amy@example.com");

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

  it("returns false for anything else, leaving it to the caller", async () => {
    const dir = await tmp();
    const { cli } = await freshCli(dir);
    await expect(cli(["serve-something-else"])).resolves.toBe(false);
  });
});
