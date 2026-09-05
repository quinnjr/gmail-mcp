#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { google, type gmail_v1 } from "googleapis";
import { authorize, createClient, loadTokens, TOKEN_PATH } from "./auth.js";
import { registerTools } from "./tools.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

// ponytail: fixed sweep; make it configurable if a client legitimately idles longer.
const SESSION_IDLE_MS = 60 * 60_000;

interface Session {
  transport: StreamableHTTPServerTransport;
  lastSeen: number;
}

export interface HandlerOptions {
  gmail: gmail_v1.Gmail;
  host: string;
  port: number;
  sessions?: Map<string, Session>;
}

/**
 * Streamable HTTP only, at /mcp. One McpServer per session (the SDK requires 1:1
 * server/transport). Exported so the routing can be exercised without a socket.
 */
export const createRequestHandler = ({ gmail, host, port, sessions = new Map() }: HandlerOptions) => {
  // The SDK compares the raw Host header, so list each name with and without the port.
  // Anything else is a DNS-rebinding attempt.
  const allowedHosts = [...new Set([host, "127.0.0.1", "localhost", "[::1]"])].flatMap((h) => [h, `${h}:${port}`]);

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    try {
      const header = req.headers["mcp-session-id"];
      const sessionId = Array.isArray(header) ? header[0] : header;
      const existing = sessionId ? sessions.get(sessionId) : undefined;
      if (sessionId && !existing) {
        res.writeHead(404, { "content-type": "application/json" })
          .end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null }));
        return;
      }
      if (existing) {
        existing.lastSeen = Date.now();
        await existing.transport.handleRequest(req, res);
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(400).end("Missing mcp-session-id");
        return;
      }
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        enableDnsRebindingProtection: true,
        allowedHosts,
        onsessioninitialized: (id: string) => {
          sessions.set(id, { transport, lastSeen: Date.now() });
        },
      });
      transport.onclose = () => transport.sessionId && sessions.delete(transport.sessionId);
      const server = new McpServer({ name: "gmail-mcp", version });
      registerTools(server, gmail);
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error("gmail-mcp request failed:", err);
      if (!res.headersSent) res.writeHead(500).end("Internal error");
    }
  };

  // Clients that vanish without DELETE never fire onclose; reap them.
  const sweep = () => {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const [id, s] of sessions) {
      if (s.lastSeen < cutoff) {
        sessions.delete(id);
        s.transport.close().catch(() => {});
      }
    }
  };

  return { handler, sweep, allowedHosts };
};

// All diagnostics go to stderr on purpose: stdout stays quiet so a process manager
// or shell pipeline never mistakes status lines for output.
const main = async (): Promise<void> => {
  if (process.argv[2] === "auth") return authorize();

  const auth = await createClient();
  if (!(await loadTokens(auth))) {
    console.error(`No tokens at ${TOKEN_PATH}. Run: gmail-mcp auth`);
    process.exit(1);
  }
  const gmail = google.gmail({ version: "v1", auth });

  const host = process.env.GMAIL_MCP_HOST || "127.0.0.1";
  const port = Number(process.env.GMAIL_MCP_PORT || process.env.PORT || 3016);
  const { handler, sweep } = createRequestHandler({ gmail, host, port });
  setInterval(sweep, SESSION_IDLE_MS / 4).unref();
  createServer(handler).listen(port, host, () =>
    console.error(`gmail-mcp ${version} listening on http://${host}:${port}/mcp`)
  );
};

// Only run when executed directly, so importing this module for its exports is side-effect free.
const isEntrypoint = (() => {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url).pathname);
  } catch {
    return false;
  }
})();
if (isEntrypoint) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
