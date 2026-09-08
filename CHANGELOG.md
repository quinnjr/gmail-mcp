# Changelog

## 0.2.0 — 2026-09-08

### Added

- Multiple accounts: sign in more than one Gmail account and select which one each request uses.
- An `account` input on every tool, so a call can target a specific signed-in account instead of the default.
- `gmail_list_accounts` tool to list signed-in accounts and the current default.
- `gmail_set_default_account` tool to change the default account.
- `gmail-mcp accounts` CLI command to list signed-in accounts and the current default.
- `gmail-mcp auth --default <email>` to set the default account.
- `gmail-mcp auth --remove <email>` to remove a signed-in account.
- Automatic migration of an existing `tokens.json` and the google-mcp seed into the new multi-account store.

### Breaking

For library consumers:

- `loadTokens` has been removed in favour of `loadAccounts`.
- `registerTools(server, accounts)` now takes an `Accounts` map instead of a single Gmail client.
- `HandlerOptions.gmail` has been renamed to `HandlerOptions.accounts`.
- `createClient` now persists refreshed tokens only when given a `tokenFile`.
