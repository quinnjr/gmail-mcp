import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { google, type Auth, type gmail_v1 } from "googleapis";
import { assertValidAccount, CLIENT_KEY, fileStore, resolveStore, type SecretStore } from "./secret-store.js";

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
  assertValidAccount(v);
  return v;
};

/** Path helpers describing the file-fallback layout; used by tests and migration. */
export const accountPath = (email: string): string => path.join(ACCOUNTS_DIR, `${normalizeEmail(email)}.json`);
export const tokenPath = (email: string): string => path.join(ACCOUNTS_DIR, `${normalizeEmail(email)}.token`);

/** Key names within whichever store is active. */
export const oauthKey = (email: string): string => `oauth:${normalizeEmail(email)}`;
export const bearerKey = (email: string): string => `bearer:${normalizeEmail(email)}`;

export const unknownAccountError = (email: string, known: string[]): Error =>
  new Error(
    `Unknown account "${email}". Signed-in accounts: ${known.join(", ") || "none"}. Run \`gmail-mcp auth\` to add one.`
  );

let storePromise: Promise<SecretStore> | undefined;
let migration: Promise<void> | undefined;

const getStore = (): Promise<SecretStore> =>
  (storePromise ??= resolveStore({ dir: ACCOUNTS_DIR, clientPath: CREDENTIALS_PATH }));

/** Canonicalizes a file-store key so a mixed-case file lands under the same key lookups use. */
const canonicalKey = (key: string): string => {
  if (key.startsWith("oauth:")) return oauthKey(key.slice("oauth:".length));
  if (key.startsWith("bearer:")) return bearerKey(key.slice("bearer:".length));
  return key;
};

/**
 * One-time import of the plaintext layout into the keyring, then delete what moved.
 * Exported as a seam for tests; production always reaches it via `readyStore`.
 * A file is deleted only after its keyring write succeeds; a failed write is logged and
 * the file is left in place for `GMAIL_MCP_KEYRING=file`.
 */
export const migrateFilesToStore = async (store: SecretStore): Promise<void> => {
  if (store.kind !== "keyring") return;
  const source = fileStore({ dir: ACCOUNTS_DIR, clientPath: CREDENTIALS_PATH });
  for (const key of source.keys()) {
    const canonical = canonicalKey(key);
    try {
      if (store.get(canonical) === undefined) {
        const value = source.get(key);
        if (value === undefined) continue;
        store.set(canonical, value);
      }
      source.delete(key);
      console.error(`gmail-mcp: moved ${source.describe(key)} into ${store.describe(canonical)}`);
    } catch (err) {
      console.error(
        `gmail-mcp: could not migrate ${source.describe(key)} into the keyring (${(err as Error).message}); ` +
          "leaving it on disk. Set GMAIL_MCP_KEYRING=file to keep using it."
      );
    }
  }
};

const readyStore = async (): Promise<SecretStore> => {
  const store = await getStore();
  migration ??= migrateFilesToStore(store);
  await migration;
  return store;
};

export const saveAccountTokens = async (email: string, tokens: Auth.Credentials): Promise<void> => {
  (await readyStore()).set(oauthKey(email), JSON.stringify(tokens, null, 2));
};

export const readAccountTokens = async (email: string): Promise<Auth.Credentials | undefined> => {
  const raw = (await readyStore()).get(oauthKey(email));
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as Auth.Credentials;
  } catch (err) {
    throw new Error(
      `Stored credentials for ${email} are corrupt (${(err as Error).message}). ` +
        `Run \`gmail-mcp auth\` and sign in as ${email} to replace them.`
    );
  }
};

export const readClientCredentials = async (): Promise<string | undefined> => (await readyStore()).get(CLIENT_KEY);

export const listAccounts = async (): Promise<string[]> => {
  const store = await readyStore();
  return store
    .keys()
    .filter((key) => key.startsWith("oauth:"))
    .map((key) => key.slice("oauth:".length))
    .sort();
};

/** A caller's bearer secret: 32 random bytes, base64url. */
export const generateToken = (): string => randomBytes(32).toString("base64url");

export const readAccountToken = async (email: string): Promise<string | undefined> => {
  const store = await readyStore();
  return store.get(bearerKey(email))?.trim() || undefined;
};

export const writeAccountToken = async (email: string, token: string): Promise<void> => {
  (await readyStore()).set(bearerKey(email), token);
};

/**
 * A token reader that reuses a value for `ttlMs` (default `GMAIL_MCP_TOKEN_CACHE_MS`,
 * 5000), so a hot per-request auth check does not hit the synchronous keyring every time.
 * A rotation therefore takes effect within the TTL, not necessarily on the next request.
 * A TTL of 0 reads through on every call.
 */
export const cachedTokenReader = (ttlMs?: number): ((email: string) => Promise<string | undefined>) => {
  const configured = ttlMs ?? Number(process.env.GMAIL_MCP_TOKEN_CACHE_MS ?? 5000);
  // A non-numeric or negative override must not silently disable (NaN) or pin (Infinity) the cache.
  const ttl = Number.isFinite(configured) && configured >= 0 ? configured : 5000;
  const cache = new Map<string, { value: string | undefined; expiresAt: number }>();
  return async (email: string): Promise<string | undefined> => {
    const now = Date.now();
    const hit = cache.get(email);
    if (hit && hit.expiresAt > now) return hit.value;
    const value = await readAccountToken(email);
    cache.set(email, { value, expiresAt: now + ttl });
    return value;
  };
};

/** The account's token, minting and persisting one when it has none. */
const ensureToken = async (email: string, onCreate?: (location: string) => void): Promise<string> => {
  const existing = await readAccountToken(email);
  if (existing) return existing;
  const token = generateToken();
  await writeAccountToken(email, token);
  onCreate?.((await readyStore()).describe(bearerKey(email)));
  return token;
};

export const removeAccount = async (email: string): Promise<void> => {
  const target = normalizeEmail(email);
  const known = await listAccounts();
  if (!known.includes(target)) throw unknownAccountError(target, known);
  const store = await readyStore();
  store.delete(oauthKey(target));
  store.delete(bearerKey(target));
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

const notAnOAuthClient = (): Error =>
  new Error(
    `credentials.json is not an OAuth client file: expected {"installed": {"client_id", "client_secret", ...}} ` +
      `as downloaded from Google Cloud Console > Credentials > OAuth client ID (Desktop app). ` +
      `Provide it at ${CREDENTIALS_PATH} (or import it into the keyring).`
  );

/**
 * Builds an OAuth client from the stored client credentials. When `persist` is given,
 * refreshed access tokens are handed to it (the caller decides where they land). The
 * callback may be async; its rejection is logged so a refresh is never silently lost.
 */
export const createClient = async (
  redirectUri?: string,
  persist?: (creds: Auth.Credentials) => void | Promise<void>
): Promise<Auth.OAuth2Client> => {
  const raw = await readClientCredentials();
  if (!raw) {
    throw new Error(
      `No OAuth client credentials found. Provide ${CREDENTIALS_PATH} as {"installed": {"client_id", "client_secret", ...}}, ` +
        "downloaded from Google Cloud Console > Credentials > OAuth client ID (Desktop app)."
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw notAnOAuthClient();
  }
  if (parsed === null || typeof parsed !== "object") throw notAnOAuthClient();
  const app = ((parsed as Record<string, unknown>).installed ?? (parsed as Record<string, unknown>).web) as
    | { client_id?: string; client_secret?: string }
    | undefined;
  if (!app?.client_id || !app.client_secret) throw notAnOAuthClient();
  const client = new google.auth.OAuth2(app.client_id, app.client_secret, redirectUri);
  if (persist) {
    // Refreshes emit only the new access token; keep the refresh token alongside it.
    client.on("tokens", (t) => {
      const report = (err: unknown): void =>
        console.error(
          `gmail-mcp: could not persist refreshed tokens (${err}). ` +
            "This process keeps working; if auth fails after a restart, run `gmail-mcp auth`."
        );
      try {
        Promise.resolve(persist({ ...client.credentials, ...t })).catch(report);
      } catch (err) {
        report(err);
      }
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
    console.error(`gmail-mcp: migrated ${file} into ${(await readyStore()).describe(oauthKey(email))}`);
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
    try {
      const client = await createClient(undefined, (creds) => saveAccountTokens(email, creds));
      client.setCredentials((await readAccountTokens(email)) ?? {});
      const token = await ensureToken(email, (location) =>
        console.error(`gmail-mcp: generated a bearer token for ${email} in ${location}; print it with \`gmail-mcp token ${email}\``)
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
    let token: string;
    try {
      await saveAccountTokens(email, tokens);
      token = await ensureToken(email);
    } catch (err) {
      throw new Error(
        `Signed in as ${email}, but could not store its credentials (${(err as Error).message}). ` +
          "Unlock the system keyring, or set GMAIL_MCP_KEYRING=file, then retry `gmail-mcp auth`."
      );
    }
    const store = await readyStore();
    console.error(
      `Signed in as ${email}; credentials in ${store.describe(oauthKey(email))}, bearer token in ${store.describe(bearerKey(email))}.\n` +
        `Send it as \`Authorization: Bearer <token>\` on every /mcp request. The token is printed below:`
    );
    // The token IS this command's output; every other line went to stderr.
    console.log(token);
    return { email, token };
  } finally {
    server.close();
  }
};
