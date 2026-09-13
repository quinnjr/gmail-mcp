# Credentials in the OS keyring

Date: 2026-09-13. Status: approved design.

## Goal

Move every secret gmail-mcp stores — the shared OAuth client, each account's
OAuth tokens, and each account's MCP bearer token — out of plaintext files and
into the operating system's credential store, behind a small backend
abstraction that falls back to the existing 0600 files when no store is
available.

## Constraint

The server is published to npm and runs on Linux, macOS, and Windows. The
credential backend must therefore work on all three without a build step, and
must not silently degrade to a store that loses secrets.

## Non-goals

- A second secret-manager backend (Vault, 1Password, etc.). One module
  (`@napi-rs/keyring`) covers Secret Service, Keychain, and Credential Manager.
- Changing the bearer-auth protocol, the session model, or the tool surface.
- A DPAPI wrapper for the Windows file fallback. NTFS ACLs are accepted there.

## Design

### 1. Secret names

One keyring service, `gmail-mcp`, with namespaced account names:

| Secret | Account name | Value |
|---|---|---|
| OAuth client (`credentials.json`) | `client` | the file contents verbatim |
| Per-account OAuth tokens | `oauth:<email>` | `Auth.Credentials` as JSON |
| Per-account bearer token | `bearer:<email>` | the 43-char base64url token |

`<email>` is lower-cased by the existing `normalizeEmail`. `findCredentials`
enumerates a service's entries, so `listAccounts()` is the set of `oauth:`
names with the prefix stripped — no plaintext index file is required.

### 2. Backend abstraction

New `src/secret-store.ts`:

```ts
export interface SecretStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): boolean;
  keys(): string[];
  /** Human location for diagnostics (and, for the file store, the path). */
  describe(key: string): string;
}
```

Three implementations:

- `keyringStore()` — wraps `Entry`/`findCredentials` from `@napi-rs/keyring`.
  On Linux every entry is constructed with `{ linux: { store: "secret-service" } }`
  so the binding never falls back to the kernel keyring, which is RAM-only and
  would silently drop credentials on reboot.
- `fileStore(accountsDir)` — today's behavior: `<email>.json` and
  `<email>.token` under `accountsDir`, the client at `CREDENTIALS_PATH`, modes
  0700/0600 repaired on every write.
- `memoryStore()` — test-only, selected with `GMAIL_MCP_KEYRING=memory`.

Selection uses `GMAIL_MCP_KEYRING`:

| Value | Behavior |
|---|---|
| `auto` (default) | Dynamic `import("@napi-rs/keyring")`, probe `findCredentials("gmail-mcp")`. Any throw (no binary for the platform, no Secret Service, denied/locked Keychain, Credential Manager failure) selects the file store and prints one loud stderr warning. |
| `file` | Force the file store. |
| `keyring` | Require the keyring; throw an actionable error if the probe fails. |
| `memory` | In-memory store (tests). |

The dynamic import is required: a static import of a native module that has no
binary for the running platform throws during module load, before any fallback
could run.

`resolveStore()` is async (dynamic import) and memoized in a module-level
promise. Every auth function awaits it.

### 3. Platform matrix

| OS | Store | Notes |
|---|---|---|
| Linux | libsecret Secret Service (gnome-keyring, KWallet, KeePassXC) | Pinned to `secret-service`; keyutils deliberately excluded. |
| macOS | Keychain | A locked or denied Keychain fails the probe and triggers the file fallback. |
| Windows | Credential Manager (generic credential) | Generic-credential blobs are capped at 2560 bytes; see below. |
| Any, unavailable | `fileStore` + warning | On Windows the warning states the file relies on the user-profile ACL, not POSIX mode bits. |

**Windows blob cap.** `keyringStore.set` checks the UTF-8 byte length of the value
against 2560 on `win32` and throws a message naming the key and the cap rather
than letting `CredWrite` fail opaquely. In practice `Auth.Credentials` JSON is
well under the cap; a value that exceeds it leaves that account unreadable from
the keyring so the next run's probe/read fails closed rather than writing a
truncated secret. (The file fallback path is unaffected.)

### 4. Auth module

`src/auth.ts` routes every read/write through the resolved store:

- `saveAccountTokens(email, tokens)` → `set("oauth:<email>", JSON.stringify(tokens))`
- `readAccountToken` / `writeAccountToken` → `get`/`set("bearer:<email>")`
- `removeAccount` → `delete` both account keys
- `listAccounts` → `keys()` filtered to `oauth:`, sorted
- new `readClientCredentials()` → `get("client")`

`accountPath` / `tokenPath` stay exported as helpers describing the file-fallback
layout; the keyring does not use them.

`createClient(redirectUri?, persist?)` takes a `(creds: Auth.Credentials) => void`
callback instead of a token-file path. `loadAccounts` passes a callback that
writes `oauth:<email>`, preserving the existing `tokens`-listener write-back for
refreshed access tokens.

Diagnostic messages stop printing file paths and use
`store.describe(key)` — "the system keyring" or the fallback path.

### 5. Migration

Migration runs once per process, immediately after a **keyring** store is
resolved (the file and memory stores skip it):

1. **Account files** (`ACCOUNTS_DIR/<email>.json`, `<email>.token`): read, write
   to `oauth:<email>` / `bearer:<email>`, then delete the file.
2. **OAuth client** (`CREDENTIALS_PATH`): read, write `client`, then delete the
   file — always, even when it is the shared `google-mcp` default path. (Owner
   decision, 2026-09-13: the keyring becomes the single source and the shared
   file is removed.)
3. Legacy single-file migration (`TOKEN_PATH` then `SEED_TOKEN_PATH`, needing
   `users.getProfile`) stays in `loadAccounts`; `saveAccountTokens` now targets
   the keyring, and the existing "delete only our own `TOKEN_PATH`" rule is
   unchanged.

Each moved secret is announced on stderr. A file is deleted only after its
keyring write succeeded; a failed write leaves the file and logs the error, so
nothing is lost. If the active store is the file fallback, migration is a no-op.

### 6. Bearer-token cache

`cachedTokenReader()` keeps `Map<email, { value, expiresAt }>` with TTL
`GMAIL_MCP_TOKEN_CACHE_MS` (default 5000 ms). Misses are cached too, so a
deleted token is not re-read on every request. Consequence, documented in the
changelog and README: a `gmail-mcp token <email> --rotate` from the CLI takes
effect within the TTL, not necessarily on the literal next request. Setting the
TTL to `0` restores read-every-request behavior.

The per-account fail-closed behavior in `authenticate` is unchanged: a store
read that throws is caught for that account only.

### 7. Dependencies and packaging

Add `@napi-rs/keyring` (`^2.1.0`) to `dependencies`. It ships prebuilt N-API
binaries for x86_64/aarch64 darwin, x86_64/i686/aarch64 windows-msvc, and
linux gnu/musl via its own optional dependencies; there is no build step. The
package gains a native component, noted as an install consideration in the
README. Version bumps minor to `0.3.0`.

### 8. Testing

- Existing `auth`/`cli`/`index` tests set `GMAIL_MCP_KEYRING=file` and keep
  using `ACCOUNTS_DIR` paths unchanged, plus new assertions that a keyring-mode
  run migrates and deletes files.
- `secret-store.test.ts`: `fileStore` and `memoryStore` behavior directly;
  `keyringStore` guarded by a runtime availability probe
  (`describe.skipIf(!(await available()))`) so a CI box without a Secret Service
  skips instead of failing.
- Backend selection is tested with injected fakes for `process.platform` and
  import availability — no real keyring needed.
- `cachedTokenReader` TTL is tested with fake timers, including a `0`-TTL
  bypass; `index.disk.test.ts` uses an uncached reader for its
  rotation-is-immediate assertions.
- The Windows blob-cap check is unit-tested by invoking the guard with a faked
  `process.platform === "win32"`.

## Compatibility

- Existing installs migrate on first run with no browser round-trip: account
  files and the OAuth client are imported into the keyring and removed, and the
  legacy `tokens.json`/google-mcp seed still migrates through `getProfile`.
- `GMAIL_MCP_ACCOUNTS_DIR` now only affects the file fallback (and migration
  source); `GMAIL_MCP_CREDENTIALS` is the client-credentials import source.
- Headless/CI/Docker installs with no Secret Service keep working on the file
  fallback with a warning.
- Rotation visibility moves from "next request" to "within `GMAIL_MCP_TOKEN_CACHE_MS`".
