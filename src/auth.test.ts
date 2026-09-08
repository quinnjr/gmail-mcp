import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const tmp = () => mkdtemp(path.join(os.tmpdir(), "gmail-mcp-"));

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

describe("loadAccounts", () => {
  const gmailFor = (client: { credentials: unknown }) => ({ marker: client.credentials }) as unknown as import("googleapis").gmail_v1.Gmail;

  it("returns undefined when nothing is stored and no legacy file exists", async () => {
    const dir = await tmp();
    await writeCredentials(dir);
    const a = await freshAuth(dir);
    expect(await a.loadAccounts({ legacyPaths: [path.join(dir, "missing.json")], gmailFor })).toBeUndefined();
  });

  it("builds one client per account, each with its bearer token", async () => {
    const dir = await tmp();
    await writeCredentials(dir);
    const a = await freshAuth(dir);
    await a.saveAccountTokens("amy@example.com", { refresh_token: "a" });
    await a.saveAccountTokens("bob@example.com", { refresh_token: "b" });
    const loaded = (await a.loadAccounts({ gmailFor }))!;
    expect([...loaded.accounts.keys()]).toEqual(["amy@example.com", "bob@example.com"]);
    expect((loaded.accounts.get("bob@example.com")!.gmail as unknown as { marker: unknown }).marker).toEqual({ refresh_token: "b" });
    expect(loaded.accounts.get("bob@example.com")!.token).toBe(await a.readAccountToken("bob@example.com"));
  });

  it("generates and persists a token for an account that has none", async () => {
    const dir = await tmp();
    await writeCredentials(dir);
    const a = await freshAuth(dir);
    await a.saveAccountTokens("amy@example.com", { refresh_token: "a" });
    expect(await a.readAccountToken("amy@example.com")).toBeUndefined();
    const loaded = (await a.loadAccounts({ gmailFor }))!;
    const token = loaded.accounts.get("amy@example.com")!.token;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await readFile(a.tokenPath("amy@example.com"), "utf8")).trim()).toBe(token);
    // A second load keeps the same token.
    expect((await a.loadAccounts({ gmailFor }))!.accounts.get("amy@example.com")!.token).toBe(token);
  });

  it("skips an account whose credentials file fails to parse", async () => {
    const dir = await tmp();
    await writeCredentials(dir);
    const a = await freshAuth(dir);
    await a.saveAccountTokens("amy@example.com", { refresh_token: "a" });
    await a.saveAccountTokens("bob@example.com", { refresh_token: "b" });
    await writeFile(a.accountPath("bob@example.com"), "{not json");
    const loaded = (await a.loadAccounts({ gmailFor }))!;
    expect([...loaded.accounts.keys()]).toEqual(["amy@example.com"]);
  });

  it("migrates a legacy token file into the store under the profile email, with a token", async () => {
    const dir = await tmp();
    await writeCredentials(dir);
    const legacy = path.join(dir, "tokens.json");
    await writeFile(legacy, JSON.stringify({ refresh_token: "old" }));
    const a = await freshAuth(dir);
    const loaded = (await a.loadAccounts({ legacyPaths: [legacy], profile: async () => "Legacy@Example.com", gmailFor }))!;
    expect([...loaded.accounts.keys()]).toEqual(["legacy@example.com"]);
    expect(loaded.accounts.get("legacy@example.com")!.token).toBe(await a.readAccountToken("legacy@example.com"));
    expect(await a.listAccounts()).toEqual(["legacy@example.com"]);
    expect(JSON.parse(await readFile(a.accountPath("legacy@example.com"), "utf8"))).toEqual({ refresh_token: "old" });
    // legacy === TOKEN_PATH (stubbed by freshAuth to <dir>/tokens.json): our own file, removed after migration.
    await expect(readFile(legacy, "utf8")).rejects.toThrow(/ENOENT/);
  });

  it("migrates from a seed file that isn't TOKEN_PATH when it is the only one that exists", async () => {
    const dir = await tmp();
    await writeCredentials(dir);
    const missingOwn = path.join(dir, "tokens.json");
    const seedFile = path.join(dir, "seed-tokens.json");
    await writeFile(seedFile, JSON.stringify({ refresh_token: "seed" }));
    const a = await freshAuth(dir);
    const loaded = (await a.loadAccounts({
      legacyPaths: [missingOwn, seedFile],
      profile: async () => "seed@example.com",
      gmailFor,
    }))!;
    expect([...loaded.accounts.keys()]).toEqual(["seed@example.com"]);
    expect(await a.listAccounts()).toEqual(["seed@example.com"]);
    expect(JSON.parse(await readFile(seedFile, "utf8"))).toEqual({ refresh_token: "seed" }); // seed left in place
  });

  it("wraps a profile lookup failure during migration with an actionable message", async () => {
    const dir = await tmp();
    await writeCredentials(dir);
    const legacy = path.join(dir, "tokens.json");
    await writeFile(legacy, JSON.stringify({ refresh_token: "old" }));
    const a = await freshAuth(dir);
    await expect(
      a.loadAccounts({
        legacyPaths: [legacy],
        profile: async () => {
          throw new Error("insufficient scope");
        },
        gmailFor,
      })
    ).rejects.toThrow(/Could not migrate .*tokens\.json.*insufficient scope.*gmail-mcp auth/);
  });

  it("rethrows anything other than a missing legacy file", async () => {
    const dir = await tmp();
    await writeCredentials(dir);
    const bad = path.join(dir, "bad.json");
    await writeFile(bad, "{not json");
    const a = await freshAuth(dir);
    await expect(a.loadAccounts({ legacyPaths: [bad], gmailFor })).rejects.toThrow(SyntaxError);
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
  it("saves under the lower-cased email and lists sorted", async () => {
    const dir = await tmp();
    const a = await freshAuth(dir);
    expect(await a.listAccounts()).toEqual([]);

    await a.saveAccountTokens("Zed@Example.com", { refresh_token: "z" });
    await a.saveAccountTokens("amy@example.com", { refresh_token: "a" });
    expect(a.accountPath("Zed@Example.com")).toBe(path.join(dir, "accounts", "zed@example.com.json"));
    expect(JSON.parse(await readFile(a.accountPath("zed@example.com"), "utf8"))).toEqual({ refresh_token: "z" });
    expect(await a.listAccounts()).toEqual(["amy@example.com", "zed@example.com"]);
  });

  it("keeps .token files out of listAccounts and normalizes tokenPath", async () => {
    const dir = await tmp();
    const a = await freshAuth(dir);
    expect(a.tokenPath("Zed@Example.com")).toBe(path.join(dir, "accounts", "zed@example.com.token"));
    await a.saveAccountTokens("zed@example.com", { refresh_token: "z" });
    await a.writeAccountToken("Zed@Example.com", "sekrit");
    expect(await a.listAccounts()).toEqual(["zed@example.com"]);
    expect(await a.readAccountToken("zed@example.com")).toBe("sekrit");
    expect(await a.readAccountToken("nobody@example.com")).toBeUndefined();
  });

  it("generateToken returns distinct 32-byte base64url secrets", async () => {
    const a = await freshAuth(await tmp());
    const one = a.generateToken();
    expect(one).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(one, "base64url")).toHaveLength(32);
    expect(a.generateToken()).not.toBe(one);
  });

  it("removeAccount deletes the credentials and the token file", async () => {
    const dir = await tmp();
    const a = await freshAuth(dir);
    await a.saveAccountTokens("amy@example.com", { refresh_token: "a" });
    await a.writeAccountToken("amy@example.com", "t-amy");
    await a.saveAccountTokens("bob@example.com", { refresh_token: "b" });

    await a.removeAccount("amy@example.com");
    expect(await a.listAccounts()).toEqual(["bob@example.com"]);
    expect(await a.readAccountToken("amy@example.com")).toBeUndefined();

    // bob never had a token file; removal must still succeed.
    await a.removeAccount("bob@example.com");
    expect(await a.listAccounts()).toEqual([]);

    await expect(a.removeAccount("nobody@example.com")).rejects.toThrow(/Unknown account "nobody@example.com"/);
  });

  it("rejects path-traversal-shaped account names", async () => {
    const dir = await tmp();
    const a = await freshAuth(dir);
    expect(() => a.accountPath("../x")).toThrow(/Invalid account/);
    expect(() => a.tokenPath("../x")).toThrow(/Invalid account/);
  });
});

describe("authorize", () => {
  it("ignores stray paths and wrong state, then exchanges the matching code and saves tokens", async () => {
    const dir = await tmp();
    await writeCredentials(dir);
    const { authorize } = await freshAuth(dir);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    let consentUrl = "";
    const done = authorize({
      open: (url) => void (consentUrl = url),
      exchange: async (_client, code) => ({ refresh_token: `rt-for-${code}` }),
      profile: async () => "Amy@Example.com",
    });
    await vi.waitFor(() => expect(consentUrl).not.toBe(""));
    const u = new URL(consentUrl);
    const redirect = new URL(u.searchParams.get("redirect_uri")!);
    const state = u.searchParams.get("state")!;
    expect(u.searchParams.get("scope")).toContain("https://mail.google.com/");
    expect(u.searchParams.get("prompt")).toBe("consent select_account");

    expect((await fetch(new URL("/favicon.ico", redirect))).status).toBe(404);
    expect((await fetch(new URL(`/oauth2callback?code=evil&state=wrong`, redirect))).status).toBe(400);
    const ok = await fetch(new URL(`/oauth2callback?code=good&state=${state}`, redirect));
    expect(ok.status).toBe(200);

    const result = await done;
    expect(result.email).toBe("amy@example.com");
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.parse(await readFile(path.join(dir, "accounts", "amy@example.com.json"), "utf8"))).toEqual({ refresh_token: "rt-for-good" });
    expect((await readFile(path.join(dir, "accounts", "amy@example.com.token"), "utf8")).trim()).toBe(result.token);
    expect(log.mock.calls.flat()).toContain(result.token);
    log.mockRestore();
  });

  it("wraps a profile lookup failure with an actionable message and writes no account file", async () => {
    const dir = await tmp();
    await writeCredentials(dir);
    const { authorize } = await freshAuth(dir);

    let consentUrl = "";
    const done = authorize({
      open: (url) => void (consentUrl = url),
      exchange: async () => ({ refresh_token: "rt" }),
      profile: async () => {
        throw new Error("boom");
      },
    });
    await vi.waitFor(() => expect(consentUrl).not.toBe(""));
    const u = new URL(consentUrl);
    const redirect = new URL(u.searchParams.get("redirect_uri")!);
    const state = u.searchParams.get("state")!;
    // Attach the assertion before triggering the callback so the rejection is never unhandled.
    const rejected = expect(done).rejects.toThrow(/could not determine the account email.*boom.*gmail-mcp auth/);
    await fetch(new URL(`/oauth2callback?code=good&state=${state}`, redirect));
    await rejected;
    await expect(readFile(path.join(dir, "accounts"))).rejects.toThrow(/ENOENT/);
  });

  it("gives up after the timeout with a message naming the fix", async () => {
    const dir = await tmp();
    await writeCredentials(dir);
    const { authorize } = await freshAuth(dir);
    await expect(authorize({ open: () => {}, timeoutMs: 50 })).rejects.toThrow(/gmail-mcp auth/);
  });

  it("adding a second account leaves the first account's token alone", async () => {
    const dir = await tmp();
    await writeCredentials(dir);
    const a = await freshAuth(dir);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await a.saveAccountTokens("first@example.com", { refresh_token: "f" });
    await a.writeAccountToken("first@example.com", "keep-me");

    const run = async (email: string) => {
      let consentUrl = "";
      const done = a.authorize({
        open: (url) => void (consentUrl = url),
        exchange: async () => ({ refresh_token: "s" }),
        profile: async () => email,
      });
      await vi.waitFor(() => expect(consentUrl).not.toBe(""));
      const u = new URL(consentUrl);
      await fetch(new URL(`/oauth2callback?code=c&state=${u.searchParams.get("state")}`, new URL(u.searchParams.get("redirect_uri")!)));
      return done;
    };

    expect((await run("second@example.com")).email).toBe("second@example.com");
    expect(await a.listAccounts()).toEqual(["first@example.com", "second@example.com"]);
    expect(await a.readAccountToken("first@example.com")).toBe("keep-me");

    // Re-authorizing an existing account keeps its token.
    expect((await run("first@example.com")).token).toBe("keep-me");
    expect(await a.readAccountToken("first@example.com")).toBe("keep-me");
    log.mockRestore();
  });
});
