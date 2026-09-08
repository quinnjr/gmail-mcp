# Multiple Gmail sign-ons

Date: 2026-09-08. Status: approved design.

## Goal

Let one running gmail-mcp server operate on several Gmail mailboxes. A single
conversation can read, send, label, and delete in any signed-in account by naming
it, and falls back to a default account when it does not.

## Constraint

A Google OAuth token addresses exactly one mailbox. The Gmail API's `userId`
parameter only accepts `me` or the token owner's own address, so it cannot be
reused to switch accounts. Multi-account therefore means several stored tokens,
one OAuth client per token, and a per-call choice of which client to use.

## Non-goals

- Per-session account selection (via URL or header). It would force a client to
  open one MCP session per mailbox; MCP clients configure one server per URL.
- Requiring an explicit account on destructive tools. The default account applies
  uniformly to every tool. (Decision by the owner, 2026-09-08.)
- Multiple OAuth client applications. All accounts share `credentials.json`.

## Design

### 1. Token store: one file per account

```
$XDG_DATA_HOME/gmail-mcp/accounts/<email>.json     # Auth.Credentials
$XDG_DATA_HOME/gmail-mcp/default                   # plain text: an email
```

`GMAIL_MCP_TOKENS` keeps its meaning as the legacy single-token path; it is now
only read for migration. A new `GMAIL_MCP_ACCOUNTS_DIR` overrides the directory.

The account file name is the address from `users.getProfile({ userId: "me" })`,
fetched once immediately after the consent code is exchanged. It is stored
lower-cased. Email characters are all safe in file names; no escaping needed.

**Migration.** On first `loadAccounts()` with an empty accounts directory, the
legacy file (`TOKEN_PATH`, then `SEED_TOKEN_PATH`) is loaded, its email is
looked up with `getProfile`, and it is written to `accounts/<email>.json` and
set as default. The legacy files are left in place. Existing installs therefore
start with no browser round-trip, exactly as today.

**Refresh write-back.** The `tokens` listener in `createClient` receives the
account's file path instead of the global `TOKEN_PATH`, so a refreshed access
token lands in the right file.

### 2. Auth CLI

| Command | Effect |
|---|---|
| `gmail-mcp auth` | Consent flow with `prompt: "consent select_account"` so the user can pick a second Google account. Saves `accounts/<email>.json`. If no default exists, sets it. Prints the email. |
| `gmail-mcp accounts` | Lists stored emails, marking the default with `*`. |
| `gmail-mcp auth --default <email>` | Sets the default. Errors if unknown, listing known emails. |
| `gmail-mcp auth --remove <email>` | Deletes the file. If it was the default, the default becomes the first remaining account or is cleared. |

All output goes to stderr, as today.

### 3. Server startup

`loadAccounts()` returns `{ accounts: Map<string, gmail_v1.Gmail>, default: string }`.
Each entry is built with `createClient(tokenFile)` plus `setCredentials`. Zero
accounts exits with `No accounts. Run: gmail-mcp auth`. The default is validated
against the map; a stale default file falls back to the first account with a
stderr warning.

`createRequestHandler` takes `accounts` and `defaultAccount` instead of `gmail`
and passes them to `registerTools`.

### 4. Tools

`registerTools(server, accounts: Accounts)` where

```ts
interface Accounts { clients: Map<string, Gmail>; default: string }
```

Every existing tool gains one optional input beside `userId`:

```ts
account: z.string().optional()
  .describe("Signed-in Gmail address to act as. Omit for the default account.")
```

The `tool` helper strips `account` from the arguments, resolves it (lower-cased;
missing means default), and passes the matching `Gmail` client to the handler.
Handler signatures change from closing over a module-level `gmail` to receiving
it as a second argument. An unknown account throws
`Unknown account "x". Signed-in accounts: a@…, b@…. Run \`gmail-mcp auth\` to add one.`
before any Google call.

Two new tools, both without `userId`:

- `gmail_list_accounts` returns `{ accounts: string[], default: string }`.
- `gmail_set_default_account({ account })` changes the in-process default and
  writes the `default` file so the choice survives a restart. Because
  `Accounts` is shared by every session, the change is server-wide.

### 5. Errors

`explain` gains the account email so an expired or under-scoped token names the
mailbox to re-authorize: `Gmail authorization for a@x expired … Run \`gmail-mcp auth\` …`.

### 6. Testing

- `auth.test.ts`: per-account save path, migration of a legacy file into the
  accounts directory with the profile-derived name, default file handling,
  remove semantics, refresh write-back to the account file.
- `tools.test.ts`: the existing "every tool reaches exactly one googleapis
  method" sweep runs against a two-account map and asserts the call hits the
  named account's client; omitted `account` hits the default; unknown account
  throws the listing error before any client call; the two new tools.
- `index.test.ts`: handler accepts the new options shape.
- Tool count assertion goes from 80 to 82.

## Compatibility

Single-account installs see no behavioural change: the legacy token is migrated
silently, `account` is optional, and every tool's other inputs are unchanged.
The `--version` bump is minor (0.2.0).
