# Multiple Gmail Sign-ons Implementation Plan

> **Superseded 2026-09-08:** the default-account machinery this plan describes (the
> `default` marker file, `--default`, `gmail_set_default_account`) was replaced by
> per-account bearer tokens the same day. See the "Per-account authentication" section of
> `docs/superpowers/specs/2026-09-08-multi-account-design.md`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One running gmail-mcp server serves several signed-in Gmail accounts, chosen per tool call by an optional `account` input that falls back to a configurable default.

**Architecture:** Tokens move from one `tokens.json` to one file per account under an `accounts/` directory plus a `default` marker file. Startup builds one `gmail_v1.Gmail` client per file into a `Map<email, Gmail>`; the `tool` helper in `src/tools.ts` resolves `account` and hands the right client to each handler as a second argument. The auth CLI gains `accounts`, `--default`, and `--remove`.

**Tech Stack:** TypeScript (ESM, Node >= 20.19), `googleapis` OAuth2 + Gmail v1, `@modelcontextprotocol/sdk` McpServer, zod 4, vitest.

**Spec:** `docs/superpowers/specs/2026-09-08-multi-account-design.md`

## Global Constraints

- All diagnostics go to stderr; stdout stays quiet.
- No new runtime dependencies.
- Account file names are lower-cased email addresses: `accounts/<email>.json`.
- `account` is optional on every tool; omitted means the default account. Destructive tools follow the same rule.
- Single-account installs must keep working with no browser round-trip (legacy `tokens.json` and google-mcp seed migrate automatically).
- Version bumps to `0.2.0` (minor).
- Work happens in the git-flow feature worktree `.worktrees/multi-account` on branch `feature/multi-account`. Run every command from that directory.
- Commit messages end with:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01W8gAwAt7Eei8FXhi786GTA
  ```

## File map

| File | Responsibility after this plan |
|---|---|
| `src/auth.ts` | OAuth client construction, per-account token store (save/list/remove/default), consent flow, `loadAccounts` with legacy migration |
| `src/tools.ts` | Tool registration against an `Accounts` map; account resolution; two account tools |
| `src/index.ts` | CLI dispatch (`auth`, `accounts`), server startup with the account map, HTTP routing |
| `src/auth.test.ts`, `src/tools.test.ts`, `src/index.test.ts` | Tests for the above |
| `package.json` | version 0.2.0 |

Test commands: `pnpm test` (all), `pnpm vitest run src/auth.test.ts` (one file), `pnpm typecheck`.

---

### Task 1: Per-account token store in `src/auth.ts`

**Files:**
- Modify: `src/auth.ts:9-37` (paths, `saveTokens`) and `src/auth.ts:39-58` (`createClient`)
- Test: `src/auth.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  ```ts
  export const ACCOUNTS_DIR: string;                       // $GMAIL_MCP_ACCOUNTS_DIR || <dataDir>/gmail-mcp/accounts
  export const DEFAULT_PATH: string;                       // <ACCOUNTS_DIR>/../default
  export const accountPath: (email: string) => string;     // ACCOUNTS_DIR/<lowercased email>.json
  export const saveAccountTokens: (email: string, tokens: Auth.Credentials) => Promise<void>;
  export const listAccounts: () => Promise<string[]>;      // sorted lowercased emails, [] when dir missing
  export const readDefault: () => Promise<string | undefined>;
  export const writeDefault: (email: string) => Promise<void>;
  export const removeAccount: (email: string) => Promise<void>; // deletes file; repoints or clears default
  export const createClient: (redirectUri?: string, tokenFile?: string) => Promise<Auth.OAuth2Client>;
  ```
  `createClient` with no `tokenFile` writes refreshed tokens nowhere (it logs once to stderr). With `tokenFile` it writes there, merged with the existing refresh token, exactly as today's listener does for `TOKEN_PATH`.

- [ ] **Step 1: Write the failing tests**

Append to `src/auth.test.ts`. Also extend `freshAuth` so it stubs `GMAIL_MCP_ACCOUNTS_DIR`:

```ts
// in freshAuth, after the GMAIL_MCP_TOKENS stub:
  vi.stubEnv("GMAIL_MCP_ACCOUNTS_DIR", path.join(dir, "accounts"));
```

```ts
describe("account store", () => {
  it("saves under the lower-cased email, lists sorted, and reads/writes the default", async () => {
    const dir = await tmp();
    const a = await freshAuth(dir);
    expect(await a.listAccounts()).toEqual([]);
    expect(await a.readDefault()).toBeUndefined();

    await a.saveAccountTokens("Zed@Example.com", { refresh_token: "z" });
    await a.saveAccountTokens("amy@example.com", { refresh_token: "a" });
    expect(a.accountPath("Zed@Example.com")).toBe(path.join(dir, "accounts", "zed@example.com.json"));
    expect(JSON.parse(await readFile(a.accountPath("zed@example.com"), "utf8"))).toEqual({ refresh_token: "z" });
    expect(await a.listAccounts()).toEqual(["amy@example.com", "zed@example.com"]);

    await a.writeDefault("Zed@Example.com");
    expect(await a.readDefault()).toBe("zed@example.com");
  });

  it("removeAccount deletes the file and repoints or clears the default", async () => {
    const dir = await tmp();
    const a = await freshAuth(dir);
    await a.saveAccountTokens("amy@example.com", { refresh_token: "a" });
    await a.saveAccountTokens("bob@example.com", { refresh_token: "b" });
    await a.writeDefault("amy@example.com");

    await a.removeAccount("amy@example.com");
    expect(await a.listAccounts()).toEqual(["bob@example.com"]);
    expect(await a.readDefault()).toBe("bob@example.com");

    await a.removeAccount("bob@example.com");
    expect(await a.listAccounts()).toEqual([]);
    expect(await a.readDefault()).toBeUndefined();

    await expect(a.removeAccount("nobody@example.com")).rejects.toThrow(/Unknown account "nobody@example.com"/);
  });
});
```

Replace the existing `createClient` refresh test with one that targets an explicit token file:

```ts
  it("persists refreshed tokens to the given file, merged with the existing refresh token", async () => {
    const dir = await tmp();
    await writeCredentials(dir);
    const { createClient } = await freshAuth(dir);
    const file = path.join(dir, "accounts", "amy@example.com.json");
    const c = await createClient(undefined, file);
    c.setCredentials({ refresh_token: "keep-me", access_token: "old" });
    c.emit("tokens", { access_token: "new", expiry_date: 123 });
    await vi.waitFor(async () =>
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ refresh_token: "keep-me", access_token: "new", expiry_date: 123 })
    );
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/auth.test.ts`
Expected: FAIL, `listAccounts is not a function` and similar.

- [ ] **Step 3: Implement the store**

In `src/auth.ts`, after `SEED_TOKEN_PATH`:

```ts
export const ACCOUNTS_DIR =
  process.env.GMAIL_MCP_ACCOUNTS_DIR || path.join(dataDir, "gmail-mcp", "accounts");
export const DEFAULT_PATH = path.join(ACCOUNTS_DIR, "..", "default");

const normalize = (email: string): string => email.trim().toLowerCase();
export const accountPath = (email: string): string => path.join(ACCOUNTS_DIR, `${normalize(email)}.json`);

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
    const v = normalize(await fs.readFile(DEFAULT_PATH, "utf8"));
    return v || undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
};

export const writeDefault = async (email: string): Promise<void> => {
  await fs.mkdir(path.dirname(DEFAULT_PATH), { recursive: true });
  await fs.writeFile(DEFAULT_PATH, `${normalize(email)}\n`, { mode: 0o600 });
};

export const removeAccount = async (email: string): Promise<void> => {
  const target = normalize(email);
  const known = await listAccounts();
  if (!known.includes(target)) throw new Error(`Unknown account "${target}". Signed-in accounts: ${known.join(", ") || "none"}`);
  await fs.rm(accountPath(target));
  if ((await readDefault()) === target) {
    const rest = known.filter((e) => e !== target);
    if (rest.length) await writeDefault(rest[0]);
    else await fs.rm(DEFAULT_PATH, { force: true });
  }
};
```

Delete the old `saveTokens` helper. Rewrite `createClient`:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/auth.test.ts && pnpm typecheck`
Expected: auth tests PASS. Typecheck may fail in `index.ts` only if it referenced `saveTokens` (it does not); it still references `TOKEN_PATH`, which stays exported.

- [ ] **Step 5: Commit**

```bash
git add src/auth.ts src/auth.test.ts
git commit -m "feat(auth): per-account token store with default marker"
```

---

### Task 2: `authorize` saves per account and can pick a second Google account

**Files:**
- Modify: `src/auth.ts` (`AuthorizeOptions`, `authorize`)
- Test: `src/auth.test.ts` (`authorize` describe block)

**Interfaces:**
- Consumes: Task 1 `saveAccountTokens`, `listAccounts`, `readDefault`, `writeDefault`.
- Produces:
  ```ts
  export interface AuthorizeOptions {
    open?: (url: string) => void;
    exchange?: (client: Auth.OAuth2Client, code: string) => Promise<Auth.Credentials>;
    /** Look up the signed-in address. Defaults to gmail.users.getProfile({userId:"me"}). */
    profile?: (client: Auth.OAuth2Client) => Promise<string>;
    timeoutMs?: number;
  }
  export const authorize: (opts?: AuthorizeOptions) => Promise<string>; // resolves the email saved
  ```

- [ ] **Step 1: Update the failing test**

Change the first `authorize` test's tail. Keep everything up to `await done;` but capture the return and add a `profile` option:

```ts
    const done = authorize({
      open: (url) => void (consentUrl = url),
      exchange: async (_client, code) => ({ refresh_token: `rt-for-${code}` }),
      profile: async () => "Amy@Example.com",
    });
    // ... existing URL/callback assertions unchanged, plus:
    expect(u.searchParams.get("prompt")).toBe("consent select_account");
    // ... after the callbacks:
    expect(await done).toBe("amy@example.com");
    expect(JSON.parse(await readFile(path.join(dir, "accounts", "amy@example.com.json"), "utf8"))).toEqual({ refresh_token: "rt-for-good" });
    expect(await readFile(path.join(dir, "default"), "utf8")).toBe("amy@example.com\n");
```

Add a second-account test:

```ts
  it("adding a second account keeps the existing default", async () => {
    const dir = await tmp();
    await writeCredentials(dir);
    const a = await freshAuth(dir);
    await a.saveAccountTokens("first@example.com", { refresh_token: "f" });
    await a.writeDefault("first@example.com");

    let consentUrl = "";
    const done = a.authorize({
      open: (url) => void (consentUrl = url),
      exchange: async () => ({ refresh_token: "s" }),
      profile: async () => "second@example.com",
    });
    await vi.waitFor(() => expect(consentUrl).not.toBe(""));
    const u = new URL(consentUrl);
    await fetch(new URL(`/oauth2callback?code=c&state=${u.searchParams.get("state")}`, new URL(u.searchParams.get("redirect_uri")!)));
    expect(await done).toBe("second@example.com");
    expect(await a.listAccounts()).toEqual(["first@example.com", "second@example.com"]);
    expect(await a.readDefault()).toBe("first@example.com");
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/auth.test.ts`
Expected: FAIL on `prompt` value and on the missing `accounts/` file.

- [ ] **Step 3: Implement**

In `src/auth.ts`:

```ts
export interface AuthorizeOptions {
  open?: (url: string) => void;
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
```

Change the signature to `authorize = async ({ open = openInBrowser, exchange = ..., profile = fetchProfileEmail, timeoutMs = AUTH_TIMEOUT_MS }: AuthorizeOptions = {}): Promise<string>`.

Change the auth URL line to:

```ts
  const url = client.generateAuthUrl({ access_type: "offline", prompt: "consent select_account", scope: SCOPES, state });
```

Replace the two lines after the code promise (`await saveTokens(...)` and the `console.error`) with:

```ts
    const tokens = await exchange(client, code);
    client.setCredentials(tokens);
    const email = (await profile(client)).trim().toLowerCase();
    await saveAccountTokens(email, tokens);
    if (!(await readDefault())) await writeDefault(email);
    console.error(`Signed in as ${email}; tokens saved to ${accountPath(email)}`);
    return email;
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/auth.test.ts && pnpm typecheck`
Expected: PASS. `index.ts` still compiles because it only calls `authorize()` and ignores the result.

- [ ] **Step 5: Commit**

```bash
git add src/auth.ts src/auth.test.ts
git commit -m "feat(auth): consent flow saves per-account tokens and allows account choice"
```

---

### Task 3: `loadAccounts` with legacy migration

**Files:**
- Modify: `src/auth.ts` (replace `loadTokens`)
- Test: `src/auth.test.ts` (replace the `loadTokens` describe block)

**Interfaces:**
- Consumes: Task 1 store functions, `createClient(undefined, tokenFile)`.
- Produces:
  ```ts
  export interface LoadedAccounts { clients: Map<string, gmail_v1.Gmail>; default: string }
  export interface LoadAccountsOptions {
    profile?: (client: Auth.OAuth2Client) => Promise<string>;   // for migration; default fetchProfileEmail
    legacyPaths?: string[];                                       // default [TOKEN_PATH, SEED_TOKEN_PATH]
    gmailFor?: (client: Auth.OAuth2Client) => gmail_v1.Gmail;    // default google.gmail({version:"v1", auth})
  }
  /** Returns undefined when no account is stored and nothing could be migrated. */
  export const loadAccounts: (opts?: LoadAccountsOptions) => Promise<LoadedAccounts | undefined>;
  ```

- [ ] **Step 1: Write the failing tests**

Delete the `loadTokens` describe block and add:

```ts
describe("loadAccounts", () => {
  const gmailFor = (client: { credentials: unknown }) => ({ marker: client.credentials }) as unknown as import("googleapis").gmail_v1.Gmail;

  it("returns undefined when nothing is stored and no legacy file exists", async () => {
    const dir = await tmp();
    await writeCredentials(dir);
    const a = await freshAuth(dir);
    expect(await a.loadAccounts({ legacyPaths: [path.join(dir, "missing.json")], gmailFor })).toBeUndefined();
  });

  it("builds one client per account and honours the default file", async () => {
    const dir = await tmp();
    await writeCredentials(dir);
    const a = await freshAuth(dir);
    await a.saveAccountTokens("amy@example.com", { refresh_token: "a" });
    await a.saveAccountTokens("bob@example.com", { refresh_token: "b" });
    await a.writeDefault("bob@example.com");
    const loaded = (await a.loadAccounts({ gmailFor }))!;
    expect([...loaded.clients.keys()]).toEqual(["amy@example.com", "bob@example.com"]);
    expect((loaded.clients.get("bob@example.com") as unknown as { marker: unknown }).marker).toEqual({ refresh_token: "b" });
    expect(loaded.default).toBe("bob@example.com");
  });

  it("falls back to the first account when the default file is stale", async () => {
    const dir = await tmp();
    await writeCredentials(dir);
    const a = await freshAuth(dir);
    await a.saveAccountTokens("amy@example.com", { refresh_token: "a" });
    await a.writeDefault("gone@example.com");
    expect((await a.loadAccounts({ gmailFor }))!.default).toBe("amy@example.com");
  });

  it("migrates a legacy token file into the store under the profile email and sets it default", async () => {
    const dir = await tmp();
    await writeCredentials(dir);
    const legacy = path.join(dir, "tokens.json");
    await writeFile(legacy, JSON.stringify({ refresh_token: "old" }));
    const a = await freshAuth(dir);
    const loaded = (await a.loadAccounts({ legacyPaths: [legacy], profile: async () => "Legacy@Example.com", gmailFor }))!;
    expect(loaded.default).toBe("legacy@example.com");
    expect(await a.listAccounts()).toEqual(["legacy@example.com"]);
    expect(JSON.parse(await readFile(a.accountPath("legacy@example.com"), "utf8"))).toEqual({ refresh_token: "old" });
    expect(JSON.parse(await readFile(legacy, "utf8"))).toEqual({ refresh_token: "old" }); // left in place
  });

  it("rethrows anything other than a missing legacy file", async () => {
    const dir = await tmp();
    await writeCredentials(dir);
    const bad = path.join(dir, "bad.json");
    await writeFile(bad, "{not json");
    const a = await freshAuth(dir);
    await expect(a.loadAccounts({ legacyPaths: [bad], gmailFor })).rejects.toThrow(SyntaxError);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/auth.test.ts`
Expected: FAIL, `loadAccounts is not a function`.

- [ ] **Step 3: Implement**

Add `import { google, type Auth, type gmail_v1 } from "googleapis";` at the top (extend the existing import). Delete `loadTokens`. Add:

```ts
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
    const email = (await profile(client)).trim().toLowerCase();
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
```

`fetchProfileEmail` must be defined above `migrateLegacy`; move it if needed.

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run src/auth.test.ts && pnpm typecheck`
Expected: auth tests PASS. Typecheck FAILS in `src/index.ts` because `loadTokens` no longer exists. That is fixed in Task 5; do not patch it here.

- [ ] **Step 5: Commit**

```bash
git add src/auth.ts src/auth.test.ts
git commit -m "feat(auth): loadAccounts builds a client per stored account and migrates legacy tokens"
```

---

### Task 4: Tools take an `account` input and resolve the client per call

**Files:**
- Modify: `src/tools.ts` (whole file: `explain`, `call`, `ids`, `registerTools`, every handler)
- Test: `src/tools.test.ts`

**Interfaces:**
- Consumes: nothing from auth (keeps `tools.ts` free of filesystem concerns except through the injected `setDefault` callback).
- Produces:
  ```ts
  export interface Accounts {
    clients: Map<string, gmail_v1.Gmail>;
    default: string;
    /** Persist a new default. Called by gmail_set_default_account after validation. */
    setDefault?: (email: string) => Promise<void>;
  }
  export const registerTools: (server: McpServer, accounts: Accounts) => void;
  ```
  Every tool's input shape gains `account: z.string().optional()`. Two new tools: `gmail_list_accounts` (no inputs) and `gmail_set_default_account({ account: string })`.

- [ ] **Step 1: Write the failing tests**

Rewrite the harness portion of `src/tools.test.ts` so `collect` takes an `Accounts` object, then update and add tests:

```ts
import type { Accounts } from "./tools.js";

const collect = (accounts: Accounts) => {
  const tools = new Map<string, Registered>();
  const server = {
    registerTool: (name: string, config: { inputSchema: z.ZodRawShape }, handler: ToolCallback<z.ZodRawShape>) =>
      tools.set(name, { shape: config.inputSchema, handler }),
  } as unknown as McpServer;
  registerTools(server, accounts);
  return tools;
};

describe("registerTools", () => {
  const amy = recordingGmail();
  const bob = recordingGmail();
  const setDefaults: string[] = [];
  const accounts: Accounts = {
    clients: new Map([["amy@example.com", amy.gmail], ["bob@example.com", bob.gmail]]),
    default: "amy@example.com",
    setDefault: async (e) => void setDefaults.push(e),
  };
  const tools = collect(accounts);
  const accountTools = new Set(["gmail_list_accounts", "gmail_set_default_account"]);

  it("registers all 80 users.* endpoints plus 2 account tools", () => {
    expect(tools.size).toBe(82);
  });

  it("every Gmail tool accepts an optional account and, when omitted, calls the default account's client", async () => {
    for (const [name, t] of tools) {
      if (accountTools.has(name)) continue;
      expect(t.shape.account, name).toBeDefined();
      amy.calls.length = 0;
      bob.calls.length = 0;
      await invoke(t, fill(t.shape));
      expect(amy.calls.length, name).toBe(1);
      expect(bob.calls.length, name).toBe(0);
      expect(amy.calls[0].args, name).not.toHaveProperty("account");
    }
  });

  it("routes to the named account, case-insensitively", async () => {
    bob.calls.length = 0;
    await invoke(tools.get("gmail_get_profile")!, { account: "Bob@Example.com" });
    expect(bob.calls.map((c) => c.path)).toEqual(["users.getProfile"]);
  });

  it("rejects an unknown account before touching Google, listing what is signed in", async () => {
    amy.calls.length = 0;
    await expect(invoke(tools.get("gmail_get_profile")!, { account: "zed@example.com" }))
      .rejects.toThrow(/Unknown account "zed@example.com".*amy@example.com, bob@example.com.*gmail-mcp auth/);
    expect(amy.calls.length).toBe(0);
  });

  it("gmail_list_accounts and gmail_set_default_account", async () => {
    const list = await invoke(tools.get("gmail_list_accounts")!, {});
    expect(JSON.parse((list.content[0] as { text: string }).text)).toEqual({ accounts: ["amy@example.com", "bob@example.com"], default: "amy@example.com" });

    await invoke(tools.get("gmail_set_default_account")!, { account: "bob@example.com" });
    expect(accounts.default).toBe("bob@example.com");
    expect(setDefaults).toEqual(["bob@example.com"]);
    bob.calls.length = 0;
    await invoke(tools.get("gmail_get_profile")!, {});
    expect(bob.calls.length).toBe(1);

    await expect(invoke(tools.get("gmail_set_default_account")!, { account: "nope@example.com" })).rejects.toThrow(/Unknown account/);
  });
```

Keep the existing "every tool reaches exactly one googleapis method" test but read calls from `amy.calls` after resetting it, and skip the two account tools. Keep `gmail_get_message`, `gmail_get_attachment` tests, changing `invoke(...)` inputs as needed (they hit `amy`). Update the auth-error test to name the account:

```ts
  it("wraps Google auth errors with the account and the command that fixes them", async () => {
    const failing = { users: { getProfile: () => Promise.reject(Object.assign(new Error("invalid_grant"), { code: 400 })), settings: {} } } as unknown as gmail_v1.Gmail;
    const t = collect({ clients: new Map([["amy@example.com", failing]]), default: "amy@example.com" }).get("gmail_get_profile")!;
    await expect(invoke(t, {})).rejects.toThrow(/amy@example\.com.*gmail-mcp auth/);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/tools.test.ts`
Expected: FAIL, type/shape errors on `registerTools(server, accounts)` and `tools.size` 80.

- [ ] **Step 3: Implement**

Top of `src/tools.ts`:

```ts
export interface Accounts {
  clients: Map<string, Gmail>;
  default: string;
  setDefault?: (email: string) => Promise<void>;
}

const explain = (err: unknown, account: string): string => {
  const e = err as { code?: number | string; message?: string; response?: { status?: number } };
  const status = Number(e.response?.status ?? e.code);
  const msg = e.message ?? String(err);
  if (status === 401 || /invalid_grant/.test(msg))
    return `Gmail authorization for ${account} expired or was revoked. Run \`gmail-mcp auth\` and sign in as ${account}. (${msg})`;
  if (status === 403 && /scope|insufficient/i.test(msg))
    return `The stored token for ${account} lacks the scope for this call. Run \`gmail-mcp auth\` and sign in as ${account} to grant the full scope set. (${msg})`;
  if (status === 403) return `Gmail refused the request (permission or quota). (${msg})`;
  if (status === 404) return `Gmail could not find that resource; check the id. (${msg})`;
  if (status === 429) return `Gmail API rate limit hit; retry after a short delay. (${msg})`;
  return msg;
};
```

`call` needs the account for the message. Make it a factory created per call inside the `tool` helper. Replace the module-level `call` with:

```ts
type Call = <T>(fn: () => Promise<{ data: T }>) => Promise<ReturnType<typeof json>>;
const caller = (account: string): Call => async (fn) => {
  try {
    return json((await fn()).data);
  } catch (err) {
    throw new Error(explain(err, account));
  }
};
```

`ids` gains the account input:

```ts
const ids = {
  userId: z.string().default("me").describe("Mailbox; 'me' is the authenticated user"),
  account: z.string().optional().describe("Signed-in Gmail address to act as. Omit for the default account."),
};
```

`registerTools` becomes:

```ts
export const registerTools = (server: McpServer, accounts: Accounts): void => {
  const known = () => [...accounts.clients.keys()].sort();
  const resolve = (account?: string): { email: string; gmail: Gmail } => {
    const email = (account ?? accounts.default).trim().toLowerCase();
    const gmail = accounts.clients.get(email);
    if (!gmail)
      throw new Error(`Unknown account "${email}". Signed-in accounts: ${known().join(", ")}. Run \`gmail-mcp auth\` to add one.`);
    return { email, gmail };
  };

  // Handlers receive the account's Gmail client and a `call` bound to that account's error messages.
  type Handler<S extends z.ZodRawShape> = (
    args: Omit<z.infer<z.ZodObject<S>>, "account">,
    gmail: Gmail,
    call: Call
  ) => ReturnType<ToolCallback<S>>;
  const tool = <S extends z.ZodRawShape>(name: string, description: string, shape: S, handler: Handler<S>) =>
    server.registerTool(name, { description, inputSchema: shape }, ((args: z.infer<z.ZodObject<S>>) => {
      const { account, ...rest } = args as { account?: string };
      const { email, gmail } = resolve(account);
      return handler(rest as Omit<z.infer<z.ZodObject<S>>, "account">, gmail, caller(email));
    }) as ToolCallback<S>);

  // ---- accounts ----
  server.registerTool("gmail_list_accounts", { description: "Signed-in Gmail accounts and which one is the default", inputSchema: {} },
    () => json({ accounts: known(), default: accounts.default }));
  server.registerTool("gmail_set_default_account",
    { description: "Change which signed-in account tools use when `account` is omitted (server-wide, persisted)",
      inputSchema: { account: z.string() } },
    async ({ account }) => {
      const { email } = resolve(account);
      accounts.default = email;
      await accounts.setDefault?.(email);
      return json({ default: email });
    });

  // ---- users ----
  ...
```

Then convert every existing handler mechanically. Each one changes from `(a) => call(() => gmail.…)` to `(a, gmail, call) => call(() => gmail.…)`, and destructuring forms from `({ userId, ...requestBody }) => call(…)` to `({ userId, ...requestBody }, gmail, call) => call(…)`. The two `async (a) =>` handlers (`gmail_get_message`, `gmail_get_draft`) and the attachment handler become `async (a, gmail) =>`. The settings shortcut `const s = gmail.users.settings;` goes away; those handlers use `gmail.users.settings.…` directly. A sed pass gets most of it:

```bash
sed -i -E \
  -e 's/\(a\) => call\(/(a, gmail, call) => call(/g' \
  -e 's/\((\{[^}]*\})\) => call\(/(\1, gmail, call) => call(/g' \
  -e 's/async \(a\) =>/async (a, gmail) =>/g' \
  -e 's/\bs\.(getAutoForwarding|updateAutoForwarding|getImap|updateImap|getPop|updatePop|getVacation|updateVacation|getLanguage|updateLanguage|delegates|filters|forwardingAddresses|sendAs|cse)\b/gmail.users.settings.\1/g' \
  src/tools.ts
```

Then delete the `const s = gmail.users.settings;` line and inspect `git diff` for any handler the regexes missed (multi-line destructuring). Every handler must now take `gmail` as its second argument; the compiler will flag any that still reference an undefined `gmail`.

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run src/tools.test.ts && pnpm typecheck`
Expected: tools tests PASS (82 tools). Typecheck still fails only in `src/index.ts` (fixed in Task 5).

- [ ] **Step 5: Commit**

```bash
git add src/tools.ts src/tools.test.ts
git commit -m "feat(tools): optional account input routes each call to a signed-in mailbox"
```

---

### Task 5: Server startup and CLI subcommands in `src/index.ts`

**Files:**
- Modify: `src/index.ts` (`HandlerOptions`, `createRequestHandler`, `main`)
- Test: `src/index.test.ts`

**Interfaces:**
- Consumes: `loadAccounts`, `authorize`, `listAccounts`, `readDefault`, `writeDefault`, `removeAccount` from `src/auth.ts`; `registerTools`, `Accounts` from `src/tools.ts`.
- Produces:
  ```ts
  export interface HandlerOptions { accounts: Accounts; host: string; port: number; sessions?: Map<string, Session> }
  ```

- [ ] **Step 1: Update the failing test**

In `src/index.test.ts` `beforeAll`, replace the `gmail:` option:

```ts
  const gmail = { users: { settings: {} } } as unknown as gmail_v1.Gmail;
  const { handler } = createRequestHandler({
    accounts: { clients: new Map([["amy@example.com", gmail]]), default: "amy@example.com" },
    host: "127.0.0.1", port,
  });
```

Add one test that the account tools are listed through a real session:

```ts
  it("lists gmail_list_accounts through a session", async () => {
    const init = await fetch(`${base}/mcp`, { method: "POST", headers, body: JSON.stringify(initialize) });
    const sid = init.headers.get("mcp-session-id")!;
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: { ...headers, "mcp-session-id": sid },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) });
    const text = await res.text();
    expect(text).toContain("gmail_list_accounts");
  });
```

(If the SDK answers `tools/list` as SSE, `text` contains the JSON inside a `data:` line; `toContain` still works.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/index.test.ts`
Expected: FAIL on the `accounts` option type / missing tool.

- [ ] **Step 3: Implement**

Imports:

```ts
import { authorize, listAccounts, loadAccounts, readDefault, removeAccount, writeDefault } from "./auth.js";
import { registerTools, type Accounts } from "./tools.js";
```

Remove the `google` import (no longer used). `HandlerOptions` and the handler:

```ts
export interface HandlerOptions {
  accounts: Accounts;
  host: string;
  port: number;
  sessions?: Map<string, Session>;
}

export const createRequestHandler = ({ accounts, host, port, sessions = new Map() }: HandlerOptions) => {
  // ... unchanged until:
      registerTools(server, accounts);
```

CLI and startup:

```ts
const cli = async (argv: string[]): Promise<boolean> => {
  const [cmd, flag, value] = argv;
  const known = async () => (await listAccounts()).join(", ") || "none";
  if (cmd === "accounts") {
    const def = await readDefault();
    const all = await listAccounts();
    if (all.length === 0) console.error("No accounts. Run: gmail-mcp auth");
    for (const e of all) console.error(`${e === def ? "*" : " "} ${e}`);
    return true;
  }
  if (cmd !== "auth") return false;
  if (flag === "--default") {
    if (!value) throw new Error("Usage: gmail-mcp auth --default <email>");
    const email = value.toLowerCase();
    if (!(await listAccounts()).includes(email)) throw new Error(`Unknown account "${email}". Signed-in accounts: ${await known()}`);
    await writeDefault(email);
    console.error(`Default account: ${email}`);
    return true;
  }
  if (flag === "--remove") {
    if (!value) throw new Error("Usage: gmail-mcp auth --remove <email>");
    await removeAccount(value);
    console.error(`Removed ${value.toLowerCase()}. Signed-in accounts: ${await known()}`);
    return true;
  }
  if (flag) throw new Error(`Unknown option ${flag}. Usage: gmail-mcp auth [--default <email> | --remove <email>]`);
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
  const accounts: Accounts = { ...loaded, setDefault: writeDefault };
  console.error(`gmail-mcp accounts: ${[...accounts.clients.keys()].join(", ")} (default ${accounts.default})`);

  const host = process.env.GMAIL_MCP_HOST || "127.0.0.1";
  const port = Number(process.env.GMAIL_MCP_PORT || process.env.PORT || 3016);
  const { handler, sweep } = createRequestHandler({ accounts, host, port });
  setInterval(sweep, SESSION_IDLE_MS / 4).unref();
  createServer(handler).listen(port, host, () =>
    console.error(`gmail-mcp ${version} listening on http://${host}:${port}/mcp`)
  );
};
```

- [ ] **Step 4: Run the full suite and typecheck**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: all PASS, clean typecheck, `dist/` built.

- [ ] **Step 5: Smoke the CLI without credentials**

Run: `GMAIL_MCP_ACCOUNTS_DIR=$(mktemp -d)/accounts node dist/index.js accounts`
Expected: stderr `No accounts. Run: gmail-mcp auth`, exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts src/index.test.ts
git commit -m "feat: multi-account startup and auth CLI subcommands"
```

---

### Task 6: Version bump and self-check

**Files:**
- Modify: `package.json` (`"version": "0.2.0"`)

- [ ] **Step 1: Bump the version**

```bash
sed -i 's/"version": "0.1.0"/"version": "0.2.0"/' package.json
```

- [ ] **Step 2: Verify the whole branch**

Run: `pnpm test && pnpm typecheck && pnpm build && git status --short`
Expected: green, and only `package.json` modified.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore: bump to 0.2.0 for multi-account support"
```

- [ ] **Step 4: Stop before merging**

Do not run `git flow feature finish`. Report the branch as ready and wait for the owner's go-ahead.

---

## Self-review

- **Spec coverage.** §1 store and migration: Tasks 1 and 3. §2 CLI: Tasks 2 and 5. §3 startup: Tasks 3 and 5. §4 tools, `account` input, two new tools, unknown-account error: Task 4. §5 errors name the account: Task 4. §6 tests: each task; tool count 82 in Task 4. Compatibility and version: Tasks 3 and 6.
- **Placeholders.** None; every step has code or an exact command.
- **Type consistency.** `Accounts` is defined in `tools.ts` and consumed by `index.ts`; `LoadedAccounts` from `auth.ts` is structurally assignable to it (same `clients` and `default` fields) and Task 5 spreads it plus `setDefault`. `createClient(redirectUri?, tokenFile?)` is used with `(undefined, file)` in Tasks 1 and 3 and with `(redirectUri)` in `authorize`, which in Task 2 saves through `saveAccountTokens` rather than the listener, so the consent client needs no `tokenFile`.
