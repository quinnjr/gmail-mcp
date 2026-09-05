import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { google, type Auth } from "googleapis";

const configDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
const dataDir = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");

// Reuses google-mcp's OAuth client; override to point anywhere else.
export const CREDENTIALS_PATH =
  process.env.GMAIL_MCP_CREDENTIALS || path.join(configDir, "google-mcp", "credentials.json");
export const TOKEN_PATH =
  process.env.GMAIL_MCP_TOKENS || path.join(dataDir, "gmail-mcp", "tokens.json");
// ponytail: seed from google-mcp's refresh token so the first run needs no browser.
// Tools outside its granted scopes (settings.*, permanent delete) 403 until `gmail-mcp auth`.
const SEED_TOKEN_PATH = path.join(dataDir, "google-mcp", "tokens.json");

// Full mailbox (needed for messages.delete / batchDelete / insert / import) plus settings.
export const SCOPES = [
  "https://mail.google.com/",
  "https://www.googleapis.com/auth/gmail.settings.basic",
  "https://www.googleapis.com/auth/gmail.settings.sharing",
];

const readJson = async (file: string): Promise<Record<string, unknown>> =>
  JSON.parse(await fs.readFile(file, "utf8"));

const saveTokens = async (tokens: Auth.Credentials): Promise<void> => {
  await fs.mkdir(path.dirname(TOKEN_PATH), { recursive: true });
  await fs.writeFile(TOKEN_PATH, JSON.stringify(tokens, null, 2), { mode: 0o600 });
};

export const createClient = async (redirectUri?: string): Promise<Auth.OAuth2Client> => {
  const creds = await readJson(CREDENTIALS_PATH);
  const { client_id, client_secret } = (creds.installed ?? creds.web) as {
    client_id: string;
    client_secret: string;
  };
  const client = new google.auth.OAuth2(client_id, client_secret, redirectUri);
  // Refreshes emit only the new access token; keep the refresh token alongside it.
  client.on("tokens", (t) => {
    saveTokens({ ...client.credentials, ...t }).catch((err) =>
      console.error("gmail-mcp: failed to persist refreshed tokens:", err)
    );
  });
  return client;
};

/** Load stored tokens (own, then google-mcp's). Returns false when neither exists. */
export const loadTokens = async (client: Auth.OAuth2Client): Promise<boolean> => {
  for (const file of [TOKEN_PATH, SEED_TOKEN_PATH]) {
    try {
      client.setCredentials(await readJson(file));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  return false;
};

/** Interactive browser consent for the full scope set; writes TOKEN_PATH. */
export const authorize = async (): Promise<void> => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
  const client = await createClient(redirectUri);
  const url = client.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: SCOPES });

  const code = await new Promise<string>((resolve, reject) => {
    server.on("request", (req, res) => {
      const u = new URL(req.url ?? "/", redirectUri);
      const code = u.searchParams.get("code");
      const error = u.searchParams.get("error");
      res.end(code ? "gmail-mcp authorized. You can close this tab." : `OAuth failed: ${error}`);
      if (code) resolve(code);
      else reject(new Error(`OAuth error: ${error}`));
    });
    console.error(`Open this URL to authorize gmail-mcp:\n\n${url}\n`);
    spawn("xdg-open", [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  });
  server.close();

  const { tokens } = await client.getToken(code);
  await saveTokens(tokens);
  console.error(`Tokens saved to ${TOKEN_PATH}`);
};
