import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { gmail_v1 } from "googleapis";
import { createRequestHandler } from "./index.js";

let base = "";
let close: () => void;

beforeAll(async () => {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const gmail = { users: { settings: {} } } as unknown as gmail_v1.Gmail;
  const { handler } = createRequestHandler({
    accounts: { clients: new Map([["amy@example.com", gmail]]), default: "amy@example.com" },
    host: "127.0.0.1", port,
  });
  server.on("request", handler);
  base = `http://127.0.0.1:${port}`;
  close = () => server.close();
});
afterAll(() => close());

const initialize = { jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } };
const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };

describe("request routing", () => {
  it("404s unknown paths and unknown session ids with a JSON-RPC error", async () => {
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: { ...headers, "mcp-session-id": "stale" }, body: JSON.stringify(initialize) });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: -32001 } });
  });

  it("400s a GET without a session", async () => {
    expect((await fetch(`${base}/mcp`, { headers })).status).toBe(400);
  });

  it("opens a session on initialize and rejects a rebound Host header", async () => {
    const ok = await fetch(`${base}/mcp`, { method: "POST", headers, body: JSON.stringify(initialize) });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("mcp-session-id")).toMatch(/[0-9a-f-]{36}/);

    // fetch() strips a caller-set Host header; node:http sends it verbatim.
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${base}/mcp`, { method: "POST", headers: { ...headers, host: "evil.example" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end(JSON.stringify(initialize));
    });
    expect(status).toBe(403);
  });

  it("lists gmail_list_accounts through a session", async () => {
    const init = await fetch(`${base}/mcp`, { method: "POST", headers, body: JSON.stringify(initialize) });
    const sid = init.headers.get("mcp-session-id")!;
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: { ...headers, "mcp-session-id": sid },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) });
    const text = await res.text();
    expect(text).toContain("gmail_list_accounts");
  });
});
