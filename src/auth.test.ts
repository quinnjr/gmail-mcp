import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadTokens } from "./auth.js";

const tmp = () => mkdtemp(path.join(os.tmpdir(), "gmail-mcp-"));
const client = () => {
  const calls: unknown[] = [];
  return { calls, setCredentials: (c: unknown) => void calls.push(c) };
};

// CREDENTIALS_PATH / TOKEN_PATH are read at import time; re-import per test with env set.
const freshAuth = async (dir: string) => {
  vi.resetModules();
  vi.stubEnv("GMAIL_MCP_CREDENTIALS", path.join(dir, "credentials.json"));
  vi.stubEnv("GMAIL_MCP_TOKENS", path.join(dir, "tokens.json"));
  vi.stubEnv("GMAIL_MCP_ACCOUNTS_DIR", path.join(dir, "accounts"));
  return import("./auth.js");
};
const writeCredentials = (dir: string) =>
  writeFile(path.join(dir, "credentials.json"), JSON.stringify({ installed: { client_id: "id", client_secret: "secret" } }));

afterEach(() => vi.unstubAllEnvs());

describe("loadTokens", () => {
  it("prefers the first path, falls back to the seed, and reports when neither exists", async () => {
    const dir = await tmp();
    const own = path.join(dir, "own.json");
    const seed = path.join(dir, "seed.json");
    await writeFile(seed, JSON.stringify({ refresh_token: "seed" }));

    const c1 = client();
    expect(await loadTokens(c1, [own, seed])).toBe(true);
    expect(c1.calls).toEqual([{ refresh_token: "seed" }]);

    await writeFile(own, JSON.stringify({ refresh_token: "own" }));
    const c2 = client();
    expect(await loadTokens(c2, [own, seed])).toBe(true);
    expect(c2.calls).toEqual([{ refresh_token: "own" }]);

    const c3 = client();
    expect(await loadTokens(c3, [path.join(dir, "missing.json")])).toBe(false);
    expect(c3.calls).toEqual([]);
  });

  it("rethrows anything other than a missing file", async () => {
    const dir = await tmp();
    const bad = path.join(dir, "bad.json");
    await writeFile(bad, "{not json");
    await expect(loadTokens(client(), [bad])).rejects.toThrow(SyntaxError);
  });
});

describe("createClient", () => {
  it("names the file and expected shape when credentials.json is not an OAuth client", async () => {
    const dir = await tmp();
    await writeFile(path.join(dir, "credentials.json"), JSON.stringify({ type: "service_account" }));
    const { createClient } = await freshAuth(dir);
    await expect(createClient()).rejects.toThrow(/credentials\.json is not an OAuth client file.*client_id/);
  });

  it("persists refreshed tokens to the given file, merged with the existing refresh token", async () => {
    const dir = await tmp();
    await writeCredentials(dir);
    const { createClient } = await freshAuth(dir);
    const file = path.join(dir, "accounts", "amy@example.com.json");
    const c = await createClient(undefined, file);
    c.setCredentials({ refresh_token: "keep-me", access_token: "old" });
    c.emit("tokens", { access_token: "new", expiry_date: 123 });
    await vi.waitFor(async () =>
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ refresh_token: "keep-me", access_token: "new", expiry_date: 123 })
    );
  });
});

describe("account store", () => {
  it("saves under the lower-cased email, lists sorted, and reads/writes the default", async () => {
    const dir = await tmp();
    const a = await freshAuth(dir);
    expect(await a.listAccounts()).toEqual([]);
    expect(await a.readDefault()).toBeUndefined();

    await a.saveAccountTokens("Zed@Example.com", { refresh_token: "z" });
    await a.saveAccountTokens("amy@example.com", { refresh_token: "a" });
    expect(a.accountPath("Zed@Example.com")).toBe(path.join(dir, "accounts", "zed@example.com.json"));
    expect(JSON.parse(await readFile(a.accountPath("zed@example.com"), "utf8"))).toEqual({ refresh_token: "z" });
    expect(await a.listAccounts()).toEqual(["amy@example.com", "zed@example.com"]);

    await a.writeDefault("Zed@Example.com");
    expect(await a.readDefault()).toBe("zed@example.com");
  });

  it("removeAccount deletes the file and repoints or clears the default", async () => {
    const dir = await tmp();
    const a = await freshAuth(dir);
    await a.saveAccountTokens("amy@example.com", { refresh_token: "a" });
    await a.saveAccountTokens("bob@example.com", { refresh_token: "b" });
    await a.writeDefault("amy@example.com");

    await a.removeAccount("amy@example.com");
    expect(await a.listAccounts()).toEqual(["bob@example.com"]);
    expect(await a.readDefault()).toBe("bob@example.com");

    await a.removeAccount("bob@example.com");
    expect(await a.listAccounts()).toEqual([]);
    expect(await a.readDefault()).toBeUndefined();

    await expect(a.removeAccount("nobody@example.com")).rejects.toThrow(/Unknown account "nobody@example.com"/);
  });
});

describe("authorize", () => {
  it("ignores stray paths and wrong state, then exchanges the matching code and saves tokens", async () => {
    const dir = await tmp();
    await writeCredentials(dir);
    const { authorize } = await freshAuth(dir);

    let consentUrl = "";
    const done = authorize({
      open: (url) => void (consentUrl = url),
      exchange: async (_client, code) => ({ refresh_token: `rt-for-${code}` }),
    });
    await vi.waitFor(() => expect(consentUrl).not.toBe(""));
    const u = new URL(consentUrl);
    const redirect = new URL(u.searchParams.get("redirect_uri")!);
    const state = u.searchParams.get("state")!;
    expect(u.searchParams.get("scope")).toContain("https://mail.google.com/");

    expect((await fetch(new URL("/favicon.ico", redirect))).status).toBe(404);
    expect((await fetch(new URL(`/oauth2callback?code=evil&state=wrong`, redirect))).status).toBe(400);
    const ok = await fetch(new URL(`/oauth2callback?code=good&state=${state}`, redirect));
    expect(ok.status).toBe(200);

    await done;
    expect(JSON.parse(await readFile(path.join(dir, "tokens.json"), "utf8"))).toEqual({ refresh_token: "rt-for-good" });
  });

  it("gives up after the timeout with a message naming the fix", async () => {
    const dir = await tmp();
    await writeCredentials(dir);
    const { authorize } = await freshAuth(dir);
    await expect(authorize({ open: () => {}, timeoutMs: 50 })).rejects.toThrow(/gmail-mcp auth/);
  });
});
