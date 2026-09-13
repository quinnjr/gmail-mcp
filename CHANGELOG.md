# Changelog

## 0.3.0 — 2026-09-13

### Added

- Credentials in the OS keyring. The OAuth client, per-account OAuth tokens, and per-account bearer tokens are stored via `@napi-rs/keyring` — Secret Service on Linux, Keychain on macOS, Credential Manager on Windows — under one `gmail-mcp` service (`client`, `oauth:<email>`, `bearer:<email>`). On Linux entries are pinned to the Secret Service; the RAM-only kernel keyring is never used.
- `GMAIL_MCP_KEYRING`: `auto` (default) prefers the keyring and falls back to `0600` files with a stderr warning, `file` forces the old layout, `keyring` fails closed if no store is available, `memory` is test-only.
- `GMAIL_MCP_TOKEN_CACHE_MS` (default `5000`) bounds how long a bearer token is cached in memory before the keyring is re-read.
- Automatic migration: on first use, `credentials.json`, `ACCOUNTS_DIR/<email>.json`, and `<email>.token` are imported into the keyring and deleted. A file is only removed after its keyring write succeeds.

### Changed

- Bearer tokens are cached for `GMAIL_MCP_TOKEN_CACHE_MS`, so `gmail-mcp token <email> --rotate` takes effect within that window instead of on the very next request. Set it to `0` for read-through behavior.
- Adding `@napi-rs/keyring` introduces a native (prebuilt) dependency; on Linux a Secret Service must be running for keyring storage.

### Breaking

For library consumers:

- `createClient(redirectUri?, tokenFile?)` now takes `createClient(redirectUri?, persist?)`, a callback receiving refreshed credentials, instead of a token-file path.
- `TOKEN_PATH` / `ACCOUNTS_DIR` are now the file-fallback layout and migration source; the store is selected by `GMAIL_MCP_KEYRING`.

## 0.2.0 — 2026-09-08

### Added

- Multiple accounts: sign in more than one Gmail account from a single server; a request acts as whichever account its bearer token belongs to.
- Bearer authentication on `/mcp`: every request must send `Authorization: Bearer <token>`. Each signed-in account has its own token, and a request may only act on that account. Missing or unknown tokens get a 401; a session id that belongs to another account, or whose token has since rotated, gets the same 404 as an unknown session id. Rotating a token takes effect on the very next request (tokens are read from disk per request); adding a new account requires a server restart.
- An `account` input on every tool, accepted for compatibility — it must name the token's own account.
- `gmail_list_accounts` tool to list the accounts the calling token can act as.
- `gmail-mcp accounts` CLI command to list signed-in accounts.
- `gmail-mcp token <email>` to print an account's bearer token on stdout, minting one if needed; `--rotate` replaces it.
- `gmail-mcp auth --remove <email>` to remove a signed-in account and its token.
- `gmail-mcp auth` now prints the new account's bearer token on stdout (previously stdout was always empty); everything else stays on stderr.
- `GMAIL_MCP_ACCOUNTS_DIR` overrides the account store directory (default `$XDG_DATA_HOME/gmail-mcp/accounts`, holding `<email>.json` credentials and `<email>.token` bearer tokens).
- Automatic migration of an existing `tokens.json` and the google-mcp seed into the new multi-account store.

### Breaking

For library consumers:

- `loadTokens` has been removed in favour of `loadAccounts`.
- `registerTools(server, accounts)` now takes an `Accounts` object, `{ clients: Map<string, Gmail>; default: string }`, instead of a single Gmail client.
- `HandlerOptions.gmail` has been renamed to `HandlerOptions.accounts`, now a `Map<string, { gmail, token }>`.
- `loadAccounts` returns `{ accounts: Map<string, { gmail, token }> }`; there is no default account.
- The default-account machinery never shipped and is gone: no `gmail_set_default_account`, no `gmail-mcp auth --default`, no `readDefault`/`writeDefault`/`Accounts.setDefault`, no `default` marker file.
- `createClient` now persists refreshed tokens only when given a `tokenFile`.
