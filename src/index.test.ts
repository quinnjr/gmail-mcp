import { createServer, request } from "node:http";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { gmail_v1 } from "googleapis";
import { authenticate, createRequestHandler, type HandlerOptions } from "./index.js";

const gmail = (marker: string) => ({ users: { settings: {} }, marker }) as unknown as gmail_v1.Gmail;
const AMY = "amy-token";
const BOB = "bob-token";
const accounts: HandlerOptions["accounts"] = new Map([
  ["amy@example.com", { gmail: gmail("amy"), token: AMY }],
  ["bob@example.com", { gmail: gmail("bob"), token: BOB }],
]);

let base = "";
let close: () => void;

beforeAll(async () => {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const { handler } = createRequestHandler({ accounts, host: "127.0.0.1", port });
  server.on("request", handler);
  base = `http://127.0.0.1:${port}`;
  close = () => server.close();
});
afterAll(() => close());

const initialize = { jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } };
const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const as = (token: string) => ({ ...headers, authorization: `Bearer ${token}` });

/** Open a session as `token` against `baseUrl` and return its id. */
const openSessionAt = async (baseUrl: string, token: string): Promise<string> => {
  const res = await fetch(`${baseUrl}/mcp`, { method: "POST", headers: as(token), body: JSON.stringify(initialize) });
  expect(res.status).toBe(200);
  await res.text();
  const sid = res.headers.get("mcp-session-id")!;
  // The SDK rejects requests made before the client confirms initialization.
  await fetch(`${baseUrl}/mcp`, { method: "POST", headers: { ...as(token), "mcp-session-id": sid },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  return sid;
};
const openSession = (token: string): Promise<string> => openSessionAt(base, token);

const rpc = async (token: string, sid: string, body: unknown): Promise<string> => {
  const res = await fetch(`${base}/mcp`, { method: "POST", headers: { ...as(token), "mcp-session-id": sid }, body: JSON.stringify(body) });
  return res.text();
};

const tokenFor = async (email: string) => accounts.get(email)?.token;
const digestOf = (token: string) => createHash("sha256").update(token).digest("hex");

describe("authenticate", () => {
  it("returns undefined without a header, with a wrong scheme, or with a wrong token", async () => {
    expect(await authenticate(undefined, accounts.keys(), tokenFor)).toBeUndefined();
    expect(await authenticate("", accounts.keys(), tokenFor)).toBeUndefined();
    expect(await authenticate(`Basic ${AMY}`, accounts.keys(), tokenFor)).toBeUndefined();
    expect(await authenticate(AMY, accounts.keys(), tokenFor)).toBeUndefined();
    expect(await authenticate("Bearer nope", accounts.keys(), tokenFor)).toBeUndefined();
    expect(await authenticate(`Bearer  ${AMY}`, accounts.keys(), tokenFor)).toBeUndefined(); // two spaces is not the scheme grammar
  });

  it("returns the email and token digest, with a case-insensitive scheme", async () => {
    expect(await authenticate(`Bearer ${AMY}`, accounts.keys(), tokenFor)).toEqual({ email: "amy@example.com", digest: digestOf(AMY) });
    expect(await authenticate(`bearer ${BOB}`, accounts.keys(), tokenFor)).toEqual({ email: "bob@example.com", digest: digestOf(BOB) });
    expect(await authenticate(`BEARER ${BOB}`, accounts.keys(), tokenFor)).toEqual({ email: "bob@example.com", digest: digestOf(BOB) });
  });

  it("fails closed for one account whose token lookup throws, without blocking the others", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const flaky = async (email: string) => {
      if (email === "bob@example.com") throw new Error("EACCES");
      return tokenFor(email);
    };
    expect(await authenticate(`Bearer ${AMY}`, accounts.keys(), flaky)).toEqual({ email: "amy@example.com", digest: digestOf(AMY) });
    expect(await authenticate(`Bearer ${BOB}`, accounts.keys(), flaky)).toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("request routing", () => {
  it("404s unknown paths without looking at credentials", async () => {
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });

  it("401s an unauthenticated or wrongly-authenticated request, before any session lookup", async () => {
    // Auth precedes session lookup: replaying a real, live session id with no token or a
    // wrong token must get the identical 401 body a dead session id would.
    const sid = await openSession(AMY);
    const bodies: unknown[] = [];
    for (const h of [headers, { ...headers, authorization: "Bearer wrong" }]) {
      const res = await fetch(`${base}/mcp`, { method: "POST", headers: { ...h, "mcp-session-id": sid }, body: JSON.stringify(initialize) });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe("Bearer");
      const json = await res.json();
      expect(json).toMatchObject({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
      bodies.push(json);
    }
    expect(bodies[0]).toEqual(bodies[1]);
  });

  it("404s an unknown session id for an authenticated caller", async () => {
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: { ...as(AMY), "mcp-session-id": "stale" }, body: JSON.stringify(initialize) });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: -32001, message: "Session not found" } });
  });

  it("400s an authenticated GET without a session", async () => {
    expect((await fetch(`${base}/mcp`, { headers: as(AMY) })).status).toBe(400);
  });

  it("opens a session on initialize and rejects a rebound Host header", async () => {
    const ok = await fetch(`${base}/mcp`, { method: "POST", headers: as(AMY), body: JSON.stringify(initialize) });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("mcp-session-id")).toMatch(/[0-9a-f-]{36}/);
    await ok.text();

    // fetch() strips a caller-set Host header; node:http sends it verbatim.
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${base}/mcp`, { method: "POST", headers: { ...as(AMY), host: "evil.example" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end(JSON.stringify(initialize));
    });
    expect(status).toBe(403);
  });

  it("404s another account's token reusing a session id, indistinguishable from a dead session", async () => {
    const sid = await openSession(AMY);
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: { ...as(BOB), "mcp-session-id": sid },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null });
  });

  it("drops a session and 404s once its token rotates, but accepts the new token on a fresh initialize", async () => {
    const tokens = new Map<string, string>([["amy@example.com", AMY], ["bob@example.com", BOB]]);
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const { handler } = createRequestHandler({ accounts, host: "127.0.0.1", port, tokenFor: async (email) => tokens.get(email) });
    server.on("request", handler);
    const rotBase = `http://127.0.0.1:${port}`;
    try {
      const sid = await openSessionAt(rotBase, AMY);
      const T2 = "amy-token-2";
      tokens.set("amy@example.com", T2);

      const stale = await fetch(`${rotBase}/mcp`, { method: "POST", headers: { ...as(T2), "mcp-session-id": sid },
        body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/list", params: {} }) });
      expect(stale.status).toBe(404);
      expect(await stale.json()).toMatchObject({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null });

      const fresh = await fetch(`${rotBase}/mcp`, { method: "POST", headers: as(T2), body: JSON.stringify(initialize) });
      expect(fresh.status).toBe(200);
    } finally {
      server.close();
    }
  });

  it("401s (not 500) when the presented token's owner has an unreadable token file, other accounts unaffected", async () => {
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const flaky = async (email: string) => {
      if (email === "bob@example.com") throw new Error("EACCES: permission denied");
      return accounts.get(email)?.token;
    };
    const { handler } = createRequestHandler({ accounts, host: "127.0.0.1", port, tokenFor: flaky });
    server.on("request", handler);
    const flakyBase = `http://127.0.0.1:${port}`;
    try {
      const bobRes = await fetch(`${flakyBase}/mcp`, { method: "POST", headers: as(BOB), body: JSON.stringify(initialize) });
      expect(bobRes.status).toBe(401);
      const amyRes = await fetch(`${flakyBase}/mcp`, { method: "POST", headers: as(AMY), body: JSON.stringify(initialize) });
      expect(amyRes.status).toBe(200);
      expect(spy).toHaveBeenCalled();
    } finally {
      server.close();
      spy.mockRestore();
    }
  });

  it("lists gmail_list_accounts and no default-account tool", async () => {
    const sid = await openSession(AMY);
    const text = await rpc(AMY, sid, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    expect(text).toContain("gmail_list_accounts");
    expect(text).not.toContain("gmail_set_default_account");
  });

  it("scopes gmail_list_accounts to the calling token's own account", async () => {
    const sid = await openSession(BOB);
    const text = await rpc(BOB, sid, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "gmail_list_accounts", arguments: {} } });
    expect(text).toContain("bob@example.com");
    expect(text).not.toContain("amy@example.com");
  });

  it("invalidates the old token and accepts the new one immediately on rotation, with no restart", async () => {
    const tokens = new Map<string, string>([["amy@example.com", AMY], ["bob@example.com", BOB]]);
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const { handler } = createRequestHandler({
      accounts, host: "127.0.0.1", port,
      tokenFor: async (email) => tokens.get(email),
    });
    server.on("request", handler);
    const rotBase = `http://127.0.0.1:${port}`;
    try {
      const sid = await openSessionAt(rotBase, AMY);

      const NEW_AMY = "amy-token-rotated";
      tokens.set("amy@example.com", NEW_AMY);

      const listTools = { jsonrpc: "2.0", id: 4, method: "tools/list", params: {} };
      const stale = await fetch(`${rotBase}/mcp`, { method: "POST", headers: { ...as(AMY), "mcp-session-id": sid }, body: JSON.stringify(listTools) });
      expect(stale.status).toBe(401);

      // The old session is bound to the old token's digest; reusing its id with the new
      // token 404s (and drops the session) rather than silently accepting it.
      const reused = await fetch(`${rotBase}/mcp`, { method: "POST", headers: { ...as(NEW_AMY), "mcp-session-id": sid }, body: JSON.stringify(listTools) });
      expect(reused.status).toBe(404);

      // A fresh initialize with the new token works immediately, no restart needed.
      const fresh = await fetch(`${rotBase}/mcp`, { method: "POST", headers: as(NEW_AMY), body: JSON.stringify(initialize) });
      expect(fresh.status).toBe(200);
    } finally {
      server.close();
    }
  });
});
