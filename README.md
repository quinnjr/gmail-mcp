# gmail-mcp

A Streamable HTTP [Model Context Protocol](https://modelcontextprotocol.io) server covering the full Gmail API v1 surface — messages, threads, drafts, labels, filters, history, and every settings resource (send-as, forwarding, vacation, IMAP/POP, delegates, S/MIME, and client-side encryption).

Unlike the broader [`google-mcp`](https://github.com/quinnjr/google-mcp) server, this one does Gmail only, supports **multiple signed-in accounts** behind a single long-lived worker, and gates every request with a per-account **bearer token**.

## Features

- **Complete Gmail v1 coverage** — 81 tools spanning `users.messages`, `threads`, `drafts`, `labels`, `history`, and the entire `users.settings.*` tree (send-as, forwarding addresses, auto-forwarding, vacation responder, IMAP/POP, language, delegates, S/MIME, and CSE identities/keypairs).
- **Multiple accounts, one worker** — sign in any number of Gmail accounts. A request acts as whichever account its bearer token belongs to; it can only touch that account's mailbox.
- **Bearer authentication** — every `/mcp` request must carry `Authorization: Bearer <token>`. Each account has its own token, stored separately from its OAuth credentials.
- **Streamable HTTP transport** — the current MCP transport at `/mcp`, one MCP session per client, with DNS-rebinding protection.
- **Seeds from google-mcp** — reuses `google-mcp`'s OAuth client and refresh token on first run, so a common setup needs no separate browser consent (tools outside the seeded scopes 403 until you run `gmail-mcp auth`).

## Installation

```bash
cd gmail-mcp
pnpm install
pnpm build
```

Requires Node.js >= 20.19.0 and pnpm.

## Google Cloud setup

This server reuses `google-mcp`'s OAuth client by default, so if you already run `google-mcp` you can skip straight to [Authentication](#authentication).

Otherwise, create OAuth 2.0 credentials:

1. In the [Google Cloud Console](https://console.cloud.google.com/), create/select a project and enable the **Gmail API**.
2. Go to **APIs & Services > Credentials > Create Credentials > OAuth client ID**, choose **Desktop app**, and download the JSON.
3. Save it as `credentials.json` at `$XDG_CONFIG_HOME/google-mcp/credentials.json` (Linux default: `~/.config/google-mcp/credentials.json`).

The file must be an installed-app OAuth client:

```json
{
  "installed": {
    "client_id": "YOUR_CLIENT_ID.apps.googleusercontent.com",
    "client_secret": "YOUR_CLIENT_SECRET",
    "auth_uri": "https://accounts.google.com/o/oauth2/auth",
    "token_uri": "https://oauth2.googleapis.com/token",
    "redirect_uris": ["http://127.0.0.1/oauth2callback"]
  }
}
```

Override the location with `GMAIL_MCP_CREDENTIALS`.

### Scopes

`gmail-mcp auth` requests the full mailbox plus settings, so every tool works:

- `https://mail.google.com/`
- `https://www.googleapis.com/auth/gmail.settings.basic`
- `https://www.googleapis.com/auth/gmail.settings.sharing`

## Authentication

Sign in interactively (opens a browser for consent):

```bash
pnpm auth
# or, after building:
node dist/index.js auth
```

On success it prints that account's **bearer token** to stdout (everything else goes to stderr, so the token can be piped straight into a client config). Send that token as `Authorization: Bearer <token>` on every `/mcp` request.

Add more accounts by running `auth` again and signing in as a different address.

### Account CLI

```bash
gmail-mcp accounts                 # list signed-in accounts
gmail-mcp token <email>            # print an account's bearer token (mints one if missing)
gmail-mcp token <email> --rotate   # replace the token (existing clients must update)
gmail-mcp auth --remove <email>    # remove an account and its token
```

Tokens are read from disk on every request, so a rotation takes effect on the next call. **Adding a new account requires a server restart.**

## Running the server

```bash
pnpm start
# or:
node dist/index.js
```

It listens on `http://127.0.0.1:3016/mcp` by default. Override with:

| Variable | Default | Purpose |
|---|---|---|
| `GMAIL_MCP_HOST` | `127.0.0.1` | Bind host |
| `GMAIL_MCP_PORT` / `PORT` | `3016` | Bind port |
| `GMAIL_MCP_CREDENTIALS` | `~/.config/google-mcp/credentials.json` | OAuth client file |
| `GMAIL_MCP_TOKENS` | `~/.local/share/gmail-mcp/tokens.json` | Legacy single-account token (migrated on first run) |
| `GMAIL_MCP_SEED_TOKENS` | `~/.local/share/google-mcp/tokens.json` | google-mcp refresh token to seed from |
| `GMAIL_MCP_ACCOUNTS_DIR` | `~/.local/share/gmail-mcp/accounts` | Per-account store (`<email>.json` credentials, `<email>.token` bearer tokens) |

Paths honor `XDG_CONFIG_HOME` / `XDG_DATA_HOME` when set.

## MCP client configuration

```json
{
  "mcpServers": {
    "gmail": {
      "url": "http://127.0.0.1:3016/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_TOKEN_HERE"
      }
    }
  }
}
```

Get the token with `gmail-mcp token <email>`.

## The `account` argument

Every tool accepts an optional `account` argument. It exists for compatibility and **must name the bearer token's own account** — a token cannot act on any other mailbox. Omit it to use the token's account. Call `gmail_list_accounts` to see which account a token maps to.

## Security model

- **Token binds to one account.** A session is opened by a token; only that token, for that account, can use the session. A session id belonging to another account — or one whose token has since rotated — returns the same `404` as an unknown session, so a probe can't distinguish live sessions from dead ones. Missing/unknown tokens get `401`.
- **Constant-time comparison.** Bearer tokens are compared by SHA-256 digest with `timingSafeEqual`, hiding both value and length.
- **Secrets on disk are locked down.** The accounts directory and token/credential files are written `0700`/`0600`, with permissions repaired on every write.
- **DNS-rebinding protection** is on; only `127.0.0.1`, `localhost`, and the configured host (with and without port) are accepted as `Host`.

## Available tools

### Accounts & profile
`gmail_list_accounts`, `gmail_get_profile`, `gmail_stop`, `gmail_watch`

### Messages
`gmail_list_messages`, `gmail_get_message`, `gmail_send_message`, `gmail_send_raw`, `gmail_modify_message`, `gmail_batch_modify_messages`, `gmail_trash_message`, `gmail_untrash_message`, `gmail_delete_message`, `gmail_batch_delete_messages`, `gmail_import_message`, `gmail_insert_message`, `gmail_get_attachment`

### Threads
`gmail_list_threads`, `gmail_get_thread`, `gmail_modify_thread`, `gmail_trash_thread`, `gmail_untrash_thread`, `gmail_delete_thread`

### Drafts
`gmail_list_drafts`, `gmail_get_draft`, `gmail_create_draft`, `gmail_update_draft`, `gmail_send_draft`, `gmail_delete_draft`

### Labels
`gmail_list_labels`, `gmail_get_label`, `gmail_create_label`, `gmail_update_label`, `gmail_patch_label`, `gmail_delete_label`

### History
`gmail_list_history`

### Filters
`gmail_list_filters`, `gmail_get_filter`, `gmail_create_filter`, `gmail_delete_filter`

### Send-as aliases
`gmail_list_send_as`, `gmail_get_send_as`, `gmail_create_send_as`, `gmail_update_send_as`, `gmail_patch_send_as`, `gmail_verify_send_as`, `gmail_delete_send_as`

### Forwarding
`gmail_list_forwarding_addresses`, `gmail_get_forwarding_address`, `gmail_create_forwarding_address`, `gmail_delete_forwarding_address`, `gmail_get_auto_forwarding`, `gmail_update_auto_forwarding`

### Vacation, IMAP/POP, language
`gmail_get_vacation`, `gmail_update_vacation`, `gmail_get_imap`, `gmail_update_imap`, `gmail_get_pop`, `gmail_update_pop`, `gmail_get_language`, `gmail_update_language`

### Delegates
`gmail_list_delegates`, `gmail_get_delegate`, `gmail_create_delegate`, `gmail_delete_delegate`

### S/MIME
`gmail_list_smime_info`, `gmail_get_smime_info`, `gmail_insert_smime_info`, `gmail_set_default_smime_info`, `gmail_delete_smime_info`

### Client-side encryption (CSE)
`gmail_list_cse_identities`, `gmail_get_cse_identity`, `gmail_create_cse_identity`, `gmail_patch_cse_identity`, `gmail_delete_cse_identity`, `gmail_list_cse_keypairs`, `gmail_get_cse_keypair`, `gmail_create_cse_keypair`, `gmail_enable_cse_keypair`, `gmail_disable_cse_keypair`, `gmail_obliterate_cse_keypair`

## Development

```bash
pnpm dev        # watch mode (tsx)
pnpm build      # compile to dist/
pnpm typecheck  # tsc --noEmit
pnpm test       # vitest run
```

## License

MIT License — see [LICENSE](LICENSE).
