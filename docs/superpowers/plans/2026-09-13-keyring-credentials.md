# Keyring Credentials Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store every gmail-mcp secret (OAuth client, per-account OAuth tokens, per-account bearer tokens) in the OS credential store, falling back to the current 0600 files when no store is available.

**Architecture:** A new `src/secret-store.ts` defines a tiny sync `SecretStore` interface with three backends — `@napi-rs/keyring` (Secret Service/Keychain/Credential Manager), the existing 0600 file store, and an in-memory store for tests. `src/auth.ts` routes all reads/writes through the resolved store and migrates existing files into the keyring on first use. `src/index.ts` switches its per-request token reader to a TTL cache.

**Tech Stack:** TypeScript (ESM, Node >= 20.19), `@napi-rs/keyring` 2.1, `googleapis`, `@modelcontextprotocol/sdk`, zod 4, vitest.

**Spec:** `docs/superpowers/specs/2026-09-13-keyring-credentials-design.md`

## Global Constraints

- All diagnostics go to stderr; stdout carries only the bearer token.
- No change to the bearer-auth protocol, session model, or tool surface.
- Secrets are never deleted from disk unless the keyring write succeeded.
- File fallback stays 0700 dir / 0600 file, repaired on every write.
- Tests never touch the real keyring: they set `GMAIL_MCP_KEYRING=file` or `=memory`.
- Version bumps to `0.3.0` (minor).
- Run every command from `.worktrees/keyring-credentials`.

## File map

| File | Responsibility after this plan |
|---|---|
| `src/secret-store.ts` (new) | `SecretStore` interface; `fileStore`, `keyringStore`, `memoryStore`; `resolveStore` with `GMAIL_MCP_KEYRING` selection and fallback |
| `src/secret-store.test.ts` (new) | Backend behavior + selection logic |
| `src/auth.ts` | Paths/keys; store-backed account + token accessors; `createClient` persist callback; migration; TTL `cachedTokenReader` |
| `src/index.ts` | Unchanged routing; CLI messages now use `store.describe` through auth |
| `src/auth.test.ts`, `src/cli.test.ts`, `src/index.disk.test.ts` | Force `GMAIL_MCP_KEYRING=file`; new memory/migration/TTL cases |
| `README.md`, `CHANGELOG.md`, `package.json` | Docs and 0.3.0 |

---

### Task 1: Secret store backends

**Files:** Create `src/secret-store.ts`, `src/secret-store.test.ts`; modify `package.json`.

**Interfaces (produced):**
```ts
export const SERVICE = "gmail-mcp";
export type StoreKind = "keyring" | "file" | "memory";
export interface SecretStore {
  readonly kind: StoreKind;
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): boolean;
  keys(): string[];
  describe(key: string): string;
}
export const fileStore: (opts: { dir: string; clientPath: string }) => SecretStore;
export const keyringStore: (native: NativeKeyring, platform?: NodeJS.Platform) => SecretStore;
export const memoryStore: () => SecretStore;
export interface ResolveStoreOptions {
  env?: NodeJS.ProcessEnv;
  dir: string;
  clientPath: string;
  platform?: NodeJS.Platform;
  warn?: (msg: string) => void;
  importKeyring?: () => Promise<NativeKeyring>;
}
export const resolveStore: (opts: ResolveStoreOptions) => Promise<SecretStore>;
```

- Test: fileStore round-trips `client`, `oauth:<email>`, `bearer:<email>`; repairs 0700/0600; `keys()` sorted-input order preserved.
- Test: keyringStore against a fake `NativeKeyring` (in-memory Map) — get/set/delete/keys/describe; `platform: "win32"` set > 2560 chars throws.
- Test: memoryStore round-trip.
- Test: resolveStore picks `file`/`memory` by env; `auto` + failing importer → file + `warn` called; `auto` + working fake → keyring; `keyring` + failing importer → throws.

---

### Task 2: auth.ts on the store

**Files:** Modify `src/auth.ts`, `src/auth.test.ts`.

**Interfaces (produced/changed):**
```ts
export const oauthKey = (email: string) => string;   // "oauth:<normalized>"
export const bearerKey = (email: string) => string;  // "bearer:<normalized>"
export const CLIENT_KEY = "client";
export const readClientCredentials: () => Promise<string | undefined>;
export const readAccountTokens: (email: string) => Promise<Auth.Credentials | undefined>;
export const getStore: () => Promise<SecretStore>;  // exported for tests/diagnostics
export const createClient: (redirectUri?: string, persist?: (creds: Auth.Credentials) => void) => Promise<Auth.OAuth2Client>;
export const cachedTokenReader: (ttlMs?: number) => (email: string) => Promise<string | undefined>;
```

- `freshAuth` stubs `GMAIL_MCP_KEYRING=file`; existing path-based assertions keep working.
- New memory-mode tests: save/list/read/remove; client creds round-trip.
- New migration tests (memory store): `ACCOUNTS_DIR/<email>.json` + `<email>.token` and `CREDENTIALS_PATH` are imported then deleted.
- `createClient` test switches from a token file to a `persist` callback.
- `cachedTokenReader` test uses fake timers for TTL and asserts a `0` TTL bypasses the cache.

---

### Task 3: index.ts and its tests

**Files:** Modify `src/index.disk.test.ts`, `src/cli.test.ts`, `src/index.ts` (only if messages need `describe`).

- `freshCli` stubs `GMAIL_MCP_KEYRING=file`.
- CLI `auth` no-credentials expectation matches the new "No OAuth client credentials" message.
- `index.disk.test.ts` stubs `GMAIL_MCP_KEYRING=file`, keeps using `tokenPath` for file manipulation, and uses `readAccountToken` (uncached) so rotation stays immediate.
- Add a CLI-visible migration smoke test: with memory mode and a pre-seeded account file, `cli(["accounts"])` lists the account and the file is gone.

---

### Task 4: Docs and version

**Files:** Modify `README.md`, `CHANGELOG.md`, `package.json`.

- README: keyring as the store, `GMAIL_MCP_KEYRING` in the env table, TTL note on rotation, install note about the native module, fallback caveat.
- CHANGELOG: 0.3.0 added/changed/breaking-for-library-consumers.
- `package.json`: `"version": "0.3.0"`, add `@napi-rs/keyring`.

---

## Self-review

- **Spec coverage.** §1 names → Task 2 keys. §2 backends/selection → Task 1. §3 platform/cap → Task 1. §4 auth module → Task 2. §5 migration → Task 2 (+ Task 3 smoke). §6 cache → Task 2/3. §7 deps → Tasks 1/4. §8 tests → each task.
- **Placeholders.** None; every task names files and exact signatures.
- **Type consistency.** `SecretStore` is defined once in `secret-store.ts` and consumed by `auth.ts`; `oauthKey`/`bearerKey`/`CLIENT_KEY` are defined in `auth.ts` and used by migration and tests.
