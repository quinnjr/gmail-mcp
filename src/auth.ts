import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
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
export const normalizeEmail = (email: string): string => {
  const v = email.trim().toLowerCase();
  if (v.includes("/") || v.includes("\\") || v.includes("..")) {
    throw new Error(`Invalid account "${email}"`);
  }
  return v;
};
export const accountPath = (email: string): string => path.join(ACCOUNTS_DIR, `${normalizeEmail(email)}.json`);
/** Bearer secret for one account. `.token`, so listAccounts (which filters on `.json`) never sees it. */
export const tokenPath = (email: string): string => path.join(ACCOUNTS_DIR, `${normalizeEmail(email)}.token`);

export const unknownAccountError = (email: string, known: string[]): Error =>
  new Error(
    `Unknown account "${email}". Signed-in accounts: ${known.join(", ") || "none"}. Run \`gmail-mcp auth\` to add one.`
  );

const writeSecureFile = async (file: string, contents: string): Promise<void> => {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  // mkdir's mode only applies when it creates the directory, and writeFile's mode only
  // applies when it creates the file; chmod explicitly so a pre-existing, drifted-permission
  // directory or file is repaired on every write.
  await fs.chmod(dir, 0o700);
  await fs.writeFile(file, contents, { mode: 0o600 });
  await fs.chmod(file, 0o600);
};

const writeJson = async (file: string, value: unknown): Promise<void> => {
  await writeSecureFile(file, JSON.stringify(value, null, 2));
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

/** A caller's bearer secret: 32 random bytes, base64url. */
export const generateToken = (): string => randomBytes(32).toString("base64url");

export const readAccountToken = async (email: string): Promise<string | undefined> => {
  try {
    return (await fs.readFile(tokenPath(email), "utf8")).trim() || undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
};

export const writeAccountToken = async (email: string, token: string): Promise<void> => {
  await writeSecureFile(tokenPath(email), `${token}\n`);
};

/**
 * A token reader that skips re-reading a `.token` file when its mtime and size haven't
 * changed since the last call, so a hot per-request auth check avoids a disk read each time.
 */
export const cachedTokenReader = (): ((email: string) => Promise<string | undefined>) => {
  const cache = new Map<string, { mtimeMs: number; size: number; token: string | undefined }>();
  return async (email: string): Promise<string | undefined> => {
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(tokenPath(email));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        cache.delete(email);
        return undefined;
      }
      throw err;
    }
    const cached = cache.get(email);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.token;
    }
    const token = await readAccountToken(email);
    cache.set(email, { mtimeMs: stat.mtimeMs, size: stat.size, token });
    return token;
  };
};

/** The account's token, minting and persisting one when it has none. */
const ensureToken = async (email: string, onCreate?: (path: string) => void): Promise<string> => {
  const existing = await readAccountToken(email);
  if (existing) return existing;
  const token = generateToken();
  await writeAccountToken(email, token);
  onCreate?.(tokenPath(email));
  return token;
};

export const removeAccount = async (email: string): Promise<void> => {
  const target = normalizeEmail(email);
  const known = await listAccounts();
  if (!known.includes(target)) throw unknownAccountError(target, known);
  await fs.rm(accountPath(target), { force: true });
  await fs.rm(tokenPath(target), { force: true });
};

// Full mailbox (needed for messages.delete / batchDelete / insert / import) plus settings.
export const SCOPES = [
  "https://mail.google.com/",
  "https://www.googleapis.com/auth/gmail.settings.basic",
  "https://www.googleapis.com/auth/gmail.settings.sharing",
];

const AUTH_TIMEOUT_MS = 5 * 60_000;
/** Budget for post-consent network calls (profile lookup, token exchange) before giving up. */
export const PROFILE_TIMEOUT_MS = 30_000;

const readJson = async (file: string): Promise<Record<string, unknown>> =>
  JSON.parse(await fs.readFile(file, "utf8"));

/** Rejects with a `gmail-mcp auth`-actionable message if `p` doesn't settle within `ms`. */
const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${what} did not complete within ${ms / 1000}s; retry \`gmail-mcp auth\``)),
      ms
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });

/** Runs `profile(client)` (timed, so a hung request fails closed) and normalizes the result; wraps any failure with `wrap`. */
const resolveEmail = async (
  client: Auth.OAuth2Client,
  profile: (client: Auth.OAuth2Client) => Promise<string>,
  wrap: (msg: string) => string,
  timeoutMs: number = PROFILE_TIMEOUT_MS
): Promise<string> => {
  let raw: string;
  try {
    raw = await withTimeout(profile(client), timeoutMs, "Profile lookup");
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    throw new Error(wrap(msg));
  }
  return normalizeEmail(raw);
};

/** Refreshed tokens are persisted back to disk only when `tokenFile` is given; otherwise refreshes update the in-memory client only. */
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
  /** Budget for the post-consent exchange and profile lookup calls. Defaults to `PROFILE_TIMEOUT_MS`. */
  profileTimeoutMs?: number;
}

const fetchProfileEmail = async (client: Auth.OAuth2Client): Promise<string> => {
  const { data } = await google.gmail({ version: "v1", auth: client }).users.getProfile({ userId: "me" });
  if (!data.emailAddress) throw new Error("Gmail getProfile returned no emailAddress");
  return data.emailAddress;
};

export interface LoadedAccount { gmail: gmail_v1.Gmail; token: string }
export interface LoadedAccounts { accounts: Map<string, LoadedAccount> }
export interface LoadAccountsOptions {
  profile?: (client: Auth.OAuth2Client) => Promise<string>;
  legacyPaths?: string[];
  gmailFor?: (client: Auth.OAuth2Client) => gmail_v1.Gmail;
  profileTimeoutMs?: number;
}

/** Copy the first legacy token file into the account store. Returns the email and source file, or undefined when none exists. */
const migrateLegacy = async (
  legacyPaths: string[],
  profile: (client: Auth.OAuth2Client) => Promise<string>,
  profileTimeoutMs: number = PROFILE_TIMEOUT_MS
): Promise<{ email: string; file: string } | undefined> => {
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
    const email = await resolveEmail(
      client,
      profile,
      (msg) => `Could not migrate ${file} into the account store (${msg}). Run \`gmail-mcp auth\` to sign in.`,
      profileTimeoutMs
    );
    await saveAccountTokens(email, tokens);
    console.error(`gmail-mcp: migrated ${file} to ${accountPath(email)}`);
    return { email, file };
  }
  return undefined;
};

/** Every stored account as a ready Gmail client plus its bearer token. Undefined when nothing is signed in. */
export const loadAccounts = async ({
  profile = fetchProfileEmail,
  legacyPaths = [TOKEN_PATH, SEED_TOKEN_PATH],
  gmailFor = (auth) => google.gmail({ version: "v1", auth }),
  profileTimeoutMs = PROFILE_TIMEOUT_MS,
}: LoadAccountsOptions = {}): Promise<LoadedAccounts | undefined> => {
  let emails = await listAccounts();
  if (emails.length === 0) {
    const migrated = await migrateLegacy(legacyPaths, profile, profileTimeoutMs);
    if (!migrated) return undefined;
    if (migrated.file === TOKEN_PATH) {
      await fs.rm(migrated.file, { force: true });
      console.error(`gmail-mcp: removed legacy ${migrated.file}`);
    }
    emails = [migrated.email];
  }
  const accounts = new Map<string, LoadedAccount>();
  for (const email of emails) {
    const file = accountPath(email);
    try {
      const client = await createClient(undefined, file);
      client.setCredentials((await readJson(file)) as Auth.Credentials);
      const token = await ensureToken(email, (p) =>
        console.error(`gmail-mcp: generated a bearer token for ${email} at ${p}; print it with \`gmail-mcp token ${email}\``)
      );
      accounts.set(email, { gmail: gmailFor(client), token });
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      console.error(
        `gmail-mcp: skipping ${email}: ${msg}. Run \`gmail-mcp auth\` and sign in as ${email} to repair it.`
      );
    }
  }
  if (accounts.size === 0) return undefined;
  return { accounts };
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
  profileTimeoutMs = PROFILE_TIMEOUT_MS,
}: AuthorizeOptions = {}): Promise<{ email: string; token: string }> => {
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
    const tokens = await withTimeout(exchange(client, code), profileTimeoutMs, "Token exchange");
    client.setCredentials(tokens);
    const email = await resolveEmail(
      client,
      profile,
      (msg) => `Signed in, but could not determine the account email (${msg}). Retry \`gmail-mcp auth\`.`,
      profileTimeoutMs
    );
    await saveAccountTokens(email, tokens);
    const token = await ensureToken(email);
    console.error(
      `Signed in as ${email}; credentials saved to ${accountPath(email)}, bearer token in ${tokenPath(email)}.\n` +
        `Send it as \`Authorization: Bearer <token>\` on every /mcp request. The token is printed below:`
    );
    // The token IS this command's output; every other line went to stderr.
    console.log(token);
    return { email, token };
  } finally {
    server.close();
  }
};
