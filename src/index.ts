#!/usr/bin/env node
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { google } from "googleapis";
import { authorize, createClient, loadTokens, TOKEN_PATH } from "./auth.js";
import { registerTools } from "./tools.js";

const main = async (): Promise<void> => {
  if (process.argv[2] === "auth") return authorize();

  const auth = await createClient();
  if (!(await loadTokens(auth))) {
    console.error(`No tokens at ${TOKEN_PATH}. Run: gmail-mcp auth`);
    process.exit(1);
  }
  const gmail = google.gmail({ version: "v1", auth });

  // Streamable HTTP only. One McpServer per session (the SDK requires 1:1 server/transport).
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    try {
      const header = req.headers["mcp-session-id"];
      const sessionId = Array.isArray(header) ? header[0] : header;
      let transport = sessionId ? sessions.get(sessionId) : undefined;
      if (sessionId && !transport) {
        res.writeHead(404, { "content-type": "application/json" })
          .end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null }));
        return;
      }
      if (transport === undefined) {
        if (req.method !== "POST") {
          res.writeHead(400).end("Missing mcp-session-id");
          return;
        }
        const t: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          onsessioninitialized: (id: string) => {
            sessions.set(id, t);
          },
        });
        t.onclose = () => t.sessionId && sessions.delete(t.sessionId);
        const server = new McpServer({ name: "gmail-mcp", version: "0.1.0" });
        registerTools(server, gmail);
        await server.connect(t);
        await t.handleRequest(req, res);
        return;
      }
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error("gmail-mcp request failed:", err);
      if (!res.headersSent) res.writeHead(500).end("Internal error");
    }
  });

  const host = process.env.GMAIL_MCP_HOST || "127.0.0.1";
  const port = Number(process.env.GMAIL_MCP_PORT || process.env.PORT || 3016);
  httpServer.listen(port, host, () => console.error(`gmail-mcp listening on http://${host}:${port}/mcp`));
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
