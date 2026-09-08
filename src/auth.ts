import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { google, type Auth, type gmail_v1 } from "googleapis";

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

export const ACCOUNTS_DIR =
  process.env.GMAIL_MCP_ACCOUNTS_DIR || path.join(dataDir, "gmail-mcp", "accounts");
export const DEFAULT_PATH = path.join(ACCOUNTS_DIR, "..", "default");

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();
export const accountPath = (email: string): string => path.join(ACCOUNTS_DIR, `${normalizeEmail(email)}.json`);

const writeJson = async (file: string, value: unknown): Promise<void> => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2), { mode: 0o600 });
};

export const saveAccountTokens = (email: string, tokens: Auth.Credentials): Promise<void> =>
  writeJson(accountPath(email), tokens);

export const listAccounts = async (): Promise<string[]> => {
  try {
    return (await fs.readdir(ACCOUNTS_DIR))
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -".json".length))
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
};

export const readDefault = async (): Promise<string | undefined> => {
  try {
    const v = normalizeEmail(await fs.readFile(DEFAULT_PATH, "utf8"));
    return v || undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
};

export const writeDefault = async (email: string): Promise<void> => {
  await fs.mkdir(path.dirname(DEFAULT_PATH), { recursive: true });
  await fs.writeFile(DEFAULT_PATH, `${normalizeEmail(email)}\n`, { mode: 0o600 });
};

export const removeAccount = async (email: string): Promise<void> => {
  const target = normalizeEmail(email);
  const known = await listAccounts();
  if (!known.includes(target)) throw new Error(`Unknown account "${target}". Signed-in accounts: ${known.join(", ") || "none"}`);
  await fs.rm(accountPath(target));
  if ((await readDefault()) === target) {
    const rest = known.filter((e) => e !== target);
    if (rest.length) await writeDefault(rest[0]);
    else await fs.rm(DEFAULT_PATH, { force: true });
  }
};

// Full mailbox (needed for messages.delete / batchDelete / insert / import) plus settings.
export const SCOPES = [
  "https://mail.google.com/",
  "https://www.googleapis.com/auth/gmail.settings.basic",
  "https://www.googleapis.com/auth/gmail.settings.sharing",
];

const AUTH_TIMEOUT_MS = 5 * 60_000;

const readJson = async (file: string): Promise<Record<string, unknown>> =>
  JSON.parse(await fs.readFile(file, "utf8"));

export const createClient = async (redirectUri?: string, tokenFile?: string): Promise<Auth.OAuth2Client> => {
  const creds = await readJson(CREDENTIALS_PATH);
  const app = (creds.installed ?? creds.web) as { client_id?: string; client_secret?: string } | undefined;
  if (!app?.client_id || !app.client_secret) {
    throw new Error(
      `${CREDENTIALS_PATH} is not an OAuth client file: expected {"installed": {"client_id", "client_secret", ...}} ` +
        "as downloaded from Google Cloud Console > Credentials > OAuth client ID (Desktop app)"
    );
  }
  const client = new google.auth.OAuth2(app.client_id, app.client_secret, redirectUri);
  if (tokenFile) {
    // Refreshes emit only the new access token; keep the refresh token alongside it.
    client.on("tokens", (t) => {
      writeJson(tokenFile, { ...client.credentials, ...t }).catch((err) =>
        console.error(
          `gmail-mcp: could not write refreshed tokens to ${tokenFile} (${err}). ` +
            "This process keeps working; if auth fails after a restart, run `gmail-mcp auth`."
        )
      );
    });
  }
  return client;
};

export interface AuthorizeOptions {
  /** Hand the consent URL to the user. Defaults to xdg-open plus a stderr print. */
  open?: (url: string) => void;
  /** Exchange the callback code for tokens. Defaults to the OAuth client's getToken. */
  exchange?: (client: Auth.OAuth2Client, code: string) => Promise<Auth.Credentials>;
  /** Look up the signed-in address after consent. Defaults to Gmail's getProfile. */
  profile?: (client: Auth.OAuth2Client) => Promise<string>;
  timeoutMs?: number;
}

const fetchProfileEmail = async (client: Auth.OAuth2Client): Promise<string> => {
  const { data } = await google.gmail({ version: "v1", auth: client }).users.getProfile({ userId: "me" });
  if (!data.emailAddress) throw new Error("Gmail getProfile returned no emailAddress");
  return data.emailAddress;
};

export interface LoadedAccounts { clients: Map<string, gmail_v1.Gmail>; default: string }
export interface LoadAccountsOptions {
  profile?: (client: Auth.OAuth2Client) => Promise<string>;
  legacyPaths?: string[];
  gmailFor?: (client: Auth.OAuth2Client) => gmail_v1.Gmail;
}

/** Copy the first legacy token file into the account store. Returns the email, or undefined when none exists. */
const migrateLegacy = async (
  legacyPaths: string[],
  profile: (client: Auth.OAuth2Client) => Promise<string>
): Promise<string | undefined> => {
  for (const file of legacyPaths) {
    let tokens: Auth.Credentials;
    try {
      tokens = (await readJson(file)) as Auth.Credentials;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    const client = await createClient();
    client.setCredentials(tokens);
    let raw: string;
    try {
      raw = await profile(client);
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      throw new Error(`Could not migrate ${file} into the account store (${msg}). Run \`gmail-mcp auth\` to sign in.`);
    }
    const email = raw.trim().toLowerCase();
    await saveAccountTokens(email, tokens);
    console.error(`gmail-mcp: migrated ${file} to ${accountPath(email)}`);
    return email;
  }
  return undefined;
};

/** Every stored account as a ready Gmail client, plus the default. Undefined when nothing is signed in. */
export const loadAccounts = async ({
  profile = fetchProfileEmail,
  legacyPaths = [TOKEN_PATH, SEED_TOKEN_PATH],
  gmailFor = (auth) => google.gmail({ version: "v1", auth }),
}: LoadAccountsOptions = {}): Promise<LoadedAccounts | undefined> => {
  let emails = await listAccounts();
  if (emails.length === 0) {
    const migrated = await migrateLegacy(legacyPaths, profile);
    if (!migrated) return undefined;
    await writeDefault(migrated);
    emails = [migrated];
  }
  const clients = new Map<string, gmail_v1.Gmail>();
  for (const email of emails) {
    const file = accountPath(email);
    const client = await createClient(undefined, file);
    client.setCredentials((await readJson(file)) as Auth.Credentials);
    clients.set(email, gmailFor(client));
  }
  let def = await readDefault();
  if (!def || !clients.has(def)) {
    if (def) console.error(`gmail-mcp: default account ${def} is not signed in; using ${emails[0]}`);
    def = emails[0];
  }
  return { clients, default: def };
};

const openInBrowser = (url: string): void => {
  console.error(`Open this URL to authorize gmail-mcp:\n\n${url}\n`);
  spawn("xdg-open", [url], { stdio: "ignore", detached: true })
    .on("error", () => console.error("Could not open a browser automatically; open the URL above by hand."))
    .unref();
};

/** Interactive browser consent for the full scope set; saves tokens per account. */
export const authorize = async ({
  open = openInBrowser,
  exchange = async (client, code) => (await client.getToken(code)).tokens,
  profile = fetchProfileEmail,
  timeoutMs = AUTH_TIMEOUT_MS,
}: AuthorizeOptions = {}): Promise<string> => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
  const client = await createClient(redirectUri);
  const state = randomUUID();
  const url = client.generateAuthUrl({ access_type: "offline", prompt: "consent select_account", scope: SCOPES, state });

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
    const tokens = await exchange(client, code);
    client.setCredentials(tokens);
    const email = (await profile(client)).trim().toLowerCase();
    await saveAccountTokens(email, tokens);
    if (!(await readDefault())) await writeDefault(email);
    console.error(`Signed in as ${email}; tokens saved to ${accountPath(email)}`);
    return email;
  } finally {
    server.close();
  }
};
