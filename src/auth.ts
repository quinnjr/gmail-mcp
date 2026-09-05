import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
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
export const SEED_TOKEN_PATH =
  process.env.GMAIL_MCP_SEED_TOKENS || path.join(dataDir, "google-mcp", "tokens.json");

// Full mailbox (needed for messages.delete / batchDelete / insert / import) plus settings.
export const SCOPES = [
  "https://mail.google.com/",
  "https://www.googleapis.com/auth/gmail.settings.basic",
  "https://www.googleapis.com/auth/gmail.settings.sharing",
];

const AUTH_TIMEOUT_MS = 5 * 60_000;

const readJson = async (file: string): Promise<Record<string, unknown>> =>
  JSON.parse(await fs.readFile(file, "utf8"));

const saveTokens = async (tokens: Auth.Credentials): Promise<void> => {
  await fs.mkdir(path.dirname(TOKEN_PATH), { recursive: true });
  await fs.writeFile(TOKEN_PATH, JSON.stringify(tokens, null, 2), { mode: 0o600 });
};

export const createClient = async (redirectUri?: string): Promise<Auth.OAuth2Client> => {
  const creds = await readJson(CREDENTIALS_PATH);
  const app = (creds.installed ?? creds.web) as { client_id?: string; client_secret?: string } | undefined;
  if (!app?.client_id || !app.client_secret) {
    throw new Error(
      `${CREDENTIALS_PATH} is not an OAuth client file: expected {"installed": {"client_id", "client_secret", ...}} ` +
        "as downloaded from Google Cloud Console > Credentials > OAuth client ID (Desktop app)"
    );
  }
  const client = new google.auth.OAuth2(app.client_id, app.client_secret, redirectUri);
  // Refreshes emit only the new access token; keep the refresh token alongside it.
  client.on("tokens", (t) => {
    saveTokens({ ...client.credentials, ...t }).catch((err) =>
      console.error(
        `gmail-mcp: could not write refreshed tokens to ${TOKEN_PATH} (${err}). ` +
          "This process keeps working; if auth fails after a restart, run `gmail-mcp auth`."
      )
    );
  });
  return client;
};

/** Load stored tokens (own, then google-mcp's). Returns false when neither exists. */
export const loadTokens = async (
  client: Pick<Auth.OAuth2Client, "setCredentials">,
  paths: string[] = [TOKEN_PATH, SEED_TOKEN_PATH]
): Promise<boolean> => {
  for (const file of paths) {
    try {
      client.setCredentials(await readJson(file));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  return false;
};

export interface AuthorizeOptions {
  /** Hand the consent URL to the user. Defaults to xdg-open plus a stderr print. */
  open?: (url: string) => void;
  /** Exchange the callback code for tokens. Defaults to the OAuth client's getToken. */
  exchange?: (client: Auth.OAuth2Client, code: string) => Promise<Auth.Credentials>;
  timeoutMs?: number;
}

const openInBrowser = (url: string): void => {
  console.error(`Open this URL to authorize gmail-mcp:\n\n${url}\n`);
  spawn("xdg-open", [url], { stdio: "ignore", detached: true })
    .on("error", () => console.error("Could not open a browser automatically; open the URL above by hand."))
    .unref();
};

/** Interactive browser consent for the full scope set; writes TOKEN_PATH. */
export const authorize = async ({
  open = openInBrowser,
  exchange = async (client, code) => (await client.getToken(code)).tokens,
  timeoutMs = AUTH_TIMEOUT_MS,
}: AuthorizeOptions = {}): Promise<void> => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
  const client = await createClient(redirectUri);
  const state = randomUUID();
  const url = client.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: SCOPES, state });

  try {
    const code = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`No OAuth callback within ${timeoutMs / 60_000} minutes; run \`gmail-mcp auth\` again`)),
        timeoutMs
      );
      server.on("request", (req, res) => {
        const u = new URL(req.url ?? "/", redirectUri);
        // Browsers also fetch /favicon.ico; only the callback path decides the flow.
        if (u.pathname !== "/oauth2callback") {
          res.writeHead(404).end();
          return;
        }
        const code = u.searchParams.get("code");
        const error = u.searchParams.get("error");
        if (u.searchParams.get("state") !== state) {
          res.writeHead(400).end("OAuth state mismatch; ignoring this callback.");
          return;
        }
        res.end(code ? "gmail-mcp authorized. You can close this tab." : `OAuth failed: ${error}`);
        if (code) {
          clearTimeout(timer);
          resolve(code);
        } else if (error) {
          clearTimeout(timer);
          reject(new Error(`OAuth error: ${error}`));
        }
      });
      open(url);
    });
    await saveTokens(await exchange(client, code));
    console.error(`Tokens saved to ${TOKEN_PATH}`);
  } finally {
    server.close();
  }
};
