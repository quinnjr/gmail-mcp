#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  authorize, generateToken, listAccounts, loadAccounts, normalizeEmail, readAccountToken,
  removeAccount, unknownAccountError, writeAccountToken, type LoadedAccount,
} from "./auth.js";
import { registerTools } from "./tools.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

// ponytail: fixed sweep; make it configurable if a client legitimately idles longer.
const SESSION_IDLE_MS = 60 * 60_000;

interface Session {
  transport: StreamableHTTPServerTransport;
  lastSeen: number;
  /** The account whose bearer token opened this session; no other token may use it. */
  email: string;
}

export interface HandlerOptions {
  accounts: Map<string, LoadedAccount>;
  host: string;
  port: number;
  sessions?: Map<string, Session>;
  /** Looks up the current token for an email; defaults to the in-memory `accounts` entry. */
  tokenFor?: (email: string) => Promise<string | undefined>;
}

const digest = (v: string): Buffer => createHash("sha256").update(v).digest();

/**
 * The email owning the bearer token in `header`, or undefined. Hashing both sides keeps the
 * comparison constant time (timingSafeEqual needs equal lengths) and hides token length.
 * Tokens are resolved via `tokenFor` on every call so a rotated token takes effect immediately.
 */
export const authenticate = async (
  header: string | undefined,
  emails: Iterable<string>,
  tokenFor: (email: string) => Promise<string | undefined>
): Promise<string | undefined> => {
  const match = /^Bearer (\S+)$/i.exec(header ?? "");
  if (!match) return undefined;
  const candidate = digest(match[1]);
  let found: string | undefined;
  for (const email of emails) {
    const token = await tokenFor(email);
    if (token && timingSafeEqual(candidate, digest(token))) found = email;
  }
  return found;
};

const rpcError = (res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void => {
  res
    .writeHead(status, { "content-type": "application/json", ...headers })
    .end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message }, id: null }));
};

/**
 * Streamable HTTP only, at /mcp. One McpServer per session (the SDK requires 1:1
 * server/transport). Exported so the routing can be exercised without a socket.
 */
export const createRequestHandler = ({
  accounts,
  host,
  port,
  sessions = new Map(),
  tokenFor = async (email) => accounts.get(email)?.token,
}: HandlerOptions) => {
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
      // Authenticate before the session lookup so an unauthenticated probe cannot tell a live
      // session id from a dead one.
      const auth = req.headers.authorization;
      const email = await authenticate(Array.isArray(auth) ? auth[0] : auth, accounts.keys(), tokenFor);
      if (!email) {
        rpcError(res, 401, "Unauthorized", { "www-authenticate": "Bearer" });
        return;
      }
      const header = req.headers["mcp-session-id"];
      const sessionId = Array.isArray(header) ? header[0] : header;
      const existing = sessionId ? sessions.get(sessionId) : undefined;
      if (sessionId && !existing) {
        rpcError(res, 404, "Session not found");
        return;
      }
      if (existing) {
        if (existing.email !== email) {
          rpcError(res, 403, "Forbidden");
          return;
        }
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
          sessions.set(id, { transport, lastSeen: Date.now(), email });
        },
      });
      transport.onclose = () => transport.sessionId && sessions.delete(transport.sessionId);
      const server = new McpServer({ name: "gmail-mcp", version });
      // The token binds the session to exactly one account, so that is all the session can see.
      registerTools(server, { clients: new Map([[email, accounts.get(email)!.gmail]]), default: email });
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

// All diagnostics go to stderr on purpose: only bearer tokens go to stdout, so
// `gmail-mcp token <email>` can be piped straight into a client config.
export const cli = async (argv: string[]): Promise<boolean> => {
  const [cmd, flag, value] = argv;
  const known = async () => (await listAccounts()).join(", ") || "none";
  if (cmd === "accounts") {
    const all = await listAccounts();
    if (all.length === 0) console.error("No accounts. Run: gmail-mcp auth");
    for (const e of all) console.error(e);
    return true;
  }
  if (cmd === "token") {
    if (!flag) throw new Error("Usage: gmail-mcp token <email> [--rotate]");
    const email = normalizeEmail(flag);
    const all = await listAccounts();
    if (!all.includes(email)) throw unknownAccountError(email, all);
    if (value && value !== "--rotate") throw new Error(`Unknown option ${value}. Usage: gmail-mcp token <email> [--rotate]`);
    const rotate = value === "--rotate";
    const token = (!rotate && (await readAccountToken(email))) || generateToken();
    await writeAccountToken(email, token);
    console.error(`Bearer token for ${email}${rotate ? " (rotated; existing clients must be updated)" : ""}:`);
    console.log(token);
    return true;
  }
  if (cmd !== "auth") return false;
  if (flag === "--remove") {
    if (!value) throw new Error("Usage: gmail-mcp auth --remove <email>");
    await removeAccount(value);
    console.error(`Removed ${normalizeEmail(value)}. Signed-in accounts: ${await known()}`);
    return true;
  }
  if (flag) throw new Error(`Unknown option ${flag}. Usage: gmail-mcp auth [--remove <email>]`);
  await authorize();
  return true;
};

const main = async (): Promise<void> => {
  if (await cli(process.argv.slice(2))) return;

  const loaded = await loadAccounts();
  if (!loaded) {
    console.error("No accounts. Run: gmail-mcp auth");
    process.exit(1);
  }
  const { accounts } = loaded;
  console.error(
    `gmail-mcp accounts: ${[...accounts.keys()].join(", ")}. ` +
      "Every /mcp request needs `Authorization: Bearer <token>`; print one with `gmail-mcp token <email>`."
  );

  const host = process.env.GMAIL_MCP_HOST || "127.0.0.1";
  const port = Number(process.env.GMAIL_MCP_PORT || process.env.PORT || 3016);
  const { handler, sweep } = createRequestHandler({ accounts, host, port, tokenFor: readAccountToken });
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
