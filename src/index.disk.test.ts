import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { gmail_v1 } from "googleapis";

// GMAIL_MCP_ACCOUNTS_DIR is read at import time; re-import per test with env set.
const freshIndex = async (dir: string) => {
  vi.resetModules();
  vi.stubEnv("GMAIL_MCP_ACCOUNTS_DIR", path.join(dir, "accounts"));
  const [index, auth] = await Promise.all([import("./index.js"), import("./auth.js")]);
  return { ...index, ...auth };
};

afterEach(() => vi.unstubAllEnvs());

describe("createRequestHandler over a real ACCOUNTS_DIR", () => {
  it("authenticates against tokenFor: readAccountToken as the token file on disk changes", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gmail-mcp-disk-"));
    const { createRequestHandler, readAccountToken, writeAccountToken, tokenPath } = await freshIndex(dir);

    const gmail = { users: { settings: {} } } as unknown as gmail_v1.Gmail;
    const accounts = new Map([["amy@example.com", { gmail, token: "unused-in-memory-token" }]]);

    const server = createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const { handler } = createRequestHandler({ accounts, host: "127.0.0.1", port, tokenFor: readAccountToken });
    server.on("request", handler);
    const base = `http://127.0.0.1:${port}`;

    const initialize = { jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } };
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    const post = (token: string) =>
      fetch(`${base}/mcp`, { method: "POST", headers: { ...headers, authorization: `Bearer ${token}` }, body: JSON.stringify(initialize) });

    try {
      // (a) a written token file authenticates.
      await writeAccountToken("amy@example.com", "t1");
      const a = await post("t1");
      expect(a.status).toBe(200);
      await a.text();

      // (b) removing the token file 401s the next request.
      await rm(tokenPath("amy@example.com"));
      const b = await post("t1");
      expect(b.status).toBe(401);

      // (c) an empty token file 401s too.
      await writeFile(tokenPath("amy@example.com"), "");
      const c = await post("t1");
      expect(c.status).toBe(401);

      // (d) writing a new token authenticates it on a fresh initialize.
      await writeAccountToken("amy@example.com", "t2");
      const d = await post("t2");
      expect(d.status).toBe(200);
      await d.text();
    } finally {
      server.close();
    }
  });
});
