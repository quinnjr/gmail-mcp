# Per-account bearer authentication on /mcp

Extends the multi-account design (2026-09-08-multi-account-design.md). Owner decision
2026-09-08: every request to `/mcp` must carry a bearer token, each token maps to exactly
one signed-in Gmail account, and a request may only act on that account.

## Model

- Each signed-in account gets a random secret: 32 bytes from `crypto.randomBytes`,
  base64url encoded. Stored at `ACCOUNTS_DIR/<email>.token` (plain text, one line, mode
  0o600, directory 0o700 via the existing `writeSecureFile`). `listAccounts` keeps
  filtering on `.json`, so `.token` files never appear as accounts.
- The token is the caller's identity. It replaces the "default account" concept: with a
  token there is always exactly one account in scope, so the `default` marker file,
  `readDefault`/`writeDefault`, `LoadedAccounts.default`, `Accounts.default`,
  `Accounts.setDefault`, the `gmail_set_default_account` tool, the `auth --default` CLI
  flag, and the `*` marker in `gmail-mcp accounts` are all REMOVED. Delete the code, do not
  leave shims. `isLoopback` and the multi-account startup warning are removed too; auth
  makes them moot.
- Requests without a valid token get HTTP 401 with header `WWW-Authenticate: Bearer` and
  a JSON-RPC error body `{ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null }`.
  Requests whose token is valid but does not match the account bound to the
  `mcp-session-id` they present get the same HTTP 404 `"Session not found"` body an unknown
  session id gets, so a live session owned by another account is indistinguishable from a
  dead one. Check auth BEFORE the session lookup so an unauthenticated probe cannot
  distinguish a live session id from a dead one.
- Token comparison is constant time: compare `sha256(candidate)` against `sha256(stored)`
  with `crypto.timingSafeEqual`, for every stored token (there are only a few accounts).

## auth.ts

```ts
export const tokenPath = (email: string): string;              // ACCOUNTS_DIR/<normalized>.token
export const generateToken = (): string;                        // randomBytes(32).toString("base64url")
export const readAccountToken = (email: string): Promise<string | undefined>;  // trimmed; undefined on ENOENT
export const writeAccountToken = (email: string, token: string): Promise<void>;
export interface LoadedAccount { gmail: gmail_v1.Gmail; token: string }
export interface LoadedAccounts { accounts: Map<string, LoadedAccount> }   // keyed by email
```

- `authorize` generates and writes a token after `saveAccountTokens` when none exists for
  that email (a re-authorization keeps the existing token). It resolves
  `{ email, token }` instead of a bare string. Its stderr line names the email and the
  path of the token file, then prints the token itself on stdout (the token IS the
  command's output; everything else stays on stderr).
- `loadAccounts` reads each account's token; an account with no token file gets one
  generated and written, with a stderr line saying so. It returns `{ accounts }`.
- `migrateLegacy` behaviour unchanged except the migrated account also gets a token.
- `removeAccount` deletes both the `.json` and the `.token` (force).

## tools.ts

```ts
export interface Accounts { clients: Map<string, Gmail>; default: string }
```
`default` is the email the session is bound to (still needed by `resolve` for the omitted
`account` case). Drop `setDefault`, drop `gmail_set_default_account` and its tests.
`gmail_list_accounts` returns `{ accounts: [...clients.keys()], default }`, which under
this model is the caller's one account. Tool count becomes 81. Tests in `tools.test.ts`
keep exercising a two-account map (routing logic is unchanged) and drop the
set_default tests; the `"  "`/`""` tests for set_default go away with the tool.

## index.ts

```ts
export interface HandlerOptions {
  accounts: Map<string, { gmail: gmail_v1.Gmail; token: string }>;
  host: string; port: number;
  sessions?: Map<string, Session>;
}
interface Session { transport; lastSeen; email: string }
export const authenticate = (header: string | undefined, accounts: HandlerOptions["accounts"]): string | undefined;
```
`authenticate` parses `Bearer <token>` (case-insensitive scheme, single space) and returns
the matching email or undefined, using the constant-time comparison above. Export it and
test it directly.

Handler order: path check → `authenticate` (401 on failure) → session lookup (404 as
today) → if the session exists and `session.email !== email`, or the presented token's
digest no longer matches the session's (the token rotated) → 404 "Session not found"
→ otherwise as today.
A new session registers tools with `{ clients: new Map([[email, gmail]]), default: email }`
and stores `email` on the session.

CLI:
- `gmail-mcp accounts` lists emails, no marker.
- `gmail-mcp token <email>` prints that account's token on stdout (creating one if
  missing). `gmail-mcp token <email> --rotate` generates a new one, writes it, prints it.
  Unknown email → `unknownAccountError`.
- `auth --default` removed. `auth --remove` unchanged in wording.
- `main` no longer needs `readDefault`/`writeDefault`/`isLoopback`. Startup stderr line
  lists the emails.

## Tests

- `auth.test.ts`: token generated on authorize, kept on re-authorize, generated on
  loadAccounts when missing, removed by removeAccount, `tokenPath` normalizes; adjust the
  existing default-related assertions (delete the default file assertions).
- `index.test.ts`: `authenticate` unit tests (missing header, wrong scheme, wrong token,
  right token, case-insensitive `bearer`); through the socket: 401 without a token, 401
  with a wrong token, 200 initialize with a right token, 403 when a second account's token
  reuses the first session's id, `tools/list` contains `gmail_list_accounts` and not
  `gmail_set_default_account`, and a `tools/call` of `gmail_list_accounts` returns only
  the caller's email.
- `cli.test.ts`: `token <email>` prints on stdout (spy on `console.log` or
  `process.stdout.write`, whichever `cli` uses; use `console.log`), `--rotate` changes it,
  unknown email rejects, `auth --default` now rejects as an unknown option.

## Docs

- Append a "Per-account authentication" section to
  `docs/superpowers/specs/2026-09-08-multi-account-design.md` summarising this model and
  noting that the default-account concept was superseded.
- CHANGELOG 0.2.0: add the bearer requirement, `gmail-mcp token`, and the removal of
  `gmail_set_default_account` / `auth --default` (they never shipped, so list them under
  the same 0.2.0 section, not as a separate break).
