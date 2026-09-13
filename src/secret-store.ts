import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Every secret lives under one keyring service so `findCredentials` can enumerate it. */
export const SERVICE = "gmail-mcp";
const CLIENT = "client";
// Windows generic credentials cap the blob at 5 * 512 bytes.
const WIN32_MAX_BLOB_BYTES = 2560;

export type StoreKind = "keyring" | "file" | "memory";

/**
 * A minimal secret backend. Sync on purpose: `@napi-rs/keyring` is sync, the files are
 * tiny, and every caller is already async where it matters.
 */
export interface SecretStore {
  readonly kind: StoreKind;
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): boolean;
  /** Every stored key, e.g. `client`, `oauth:<email>`, `bearer:<email>`. */
  keys(): string[];
  /** Human-readable location, for diagnostics. */
  describe(key: string): string;
}

const accountOf = (key: string, kind: "oauth" | "bearer"): string => {
  const prefix = `${kind}:`;
  if (!key.startsWith(prefix)) throw new Error(`Unknown secret key "${key}"`);
  const email = key.slice(prefix.length);
  if (email.includes("/") || email.includes("\\") || email.includes("..")) {
    throw new Error(`Invalid account "${email}"`);
  }
  return email;
};

export interface FileStoreOptions {
  /** Account directory: `<email>.json` credentials and `<email>.token` bearer tokens. */
  dir: string;
  /** OAuth client JSON path. */
  clientPath: string;
}

/** The pre-keyring layout: 0700 directory, 0600 files, repaired on every write. */
export const fileStore = ({ dir, clientPath }: FileStoreOptions): SecretStore => {
  const fileFor = (key: string): string => {
    if (key === CLIENT) return clientPath;
    if (key.startsWith("oauth:")) return path.join(dir, `${accountOf(key, "oauth")}.json`);
    if (key.startsWith("bearer:")) return path.join(dir, `${accountOf(key, "bearer")}.token`);
    throw new Error(`Unknown secret key "${key}"`);
  };

  const writeSecure = (file: string, contents: string): void => {
    const parent = path.dirname(file);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    // mkdir's mode only applies when it creates the directory, and writeFileSync's mode
    // only when it creates the file; chmod explicitly so drifted permissions are repaired.
    chmodSync(parent, 0o700);
    writeFileSync(file, contents, { mode: 0o600 });
    chmodSync(file, 0o600);
  };

  const read = (file: string): string | undefined => {
    try {
      return readFileSync(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  };

  return {
    kind: "file",
    get: (key) => read(fileFor(key)),
    set: (key, value) => writeSecure(fileFor(key), value),
    delete: (key) => {
      const file = fileFor(key);
      const existed = existsSync(file);
      rmSync(file, { force: true });
      return existed;
    },
    keys: () => {
      const keys: string[] = [];
      if (existsSync(clientPath)) keys.push(CLIENT);
      let files: string[] = [];
      try {
        files = readdirSync(dir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      for (const file of files) {
        if (file.endsWith(".json")) keys.push(`oauth:${file.slice(0, -".json".length)}`);
        else if (file.endsWith(".token")) keys.push(`bearer:${file.slice(0, -".token".length)}`);
      }
      return keys;
    },
    describe: (key) => fileFor(key),
  };
};

export interface NativeEntry {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): boolean;
}

/** The subset of `@napi-rs/keyring` this module uses. */
export interface NativeKeyring {
  Entry: new (service: string, account: string, options?: unknown) => NativeEntry;
  findCredentials(service: string): { account: string; password: string }[];
}

// Without this the binding silently falls back to the RAM-only kernel keyring on Linux,
// which would lose every credential on reboot.
const LINUX_SECRET_SERVICE = { linux: { store: "secret-service" } } as const;

export const keyringStore = (native: NativeKeyring, platform: NodeJS.Platform = process.platform): SecretStore => {
  const entry = (key: string): NativeEntry => new native.Entry(SERVICE, key, LINUX_SECRET_SERVICE);
  return {
    kind: "keyring",
    get: (key) => entry(key).getPassword() ?? undefined,
    set: (key, value) => {
      const bytes = Buffer.byteLength(value, "utf8");
      if (platform === "win32" && bytes > WIN32_MAX_BLOB_BYTES) {
        throw new Error(
          `Secret "${key}" is ${bytes} bytes, over the Windows credential store limit of ${WIN32_MAX_BLOB_BYTES} bytes`
        );
      }
      entry(key).setPassword(value);
    },
    delete: (key) => entry(key).deletePassword(),
    keys: () => native.findCredentials(SERVICE).map((c) => c.account),
    describe: () => "the system keyring",
  };
};

/** Test backend: process-local, nothing touches the OS or disk. */
export const memoryStore = (): SecretStore => {
  const secrets = new Map<string, string>();
  return {
    kind: "memory",
    get: (key) => secrets.get(key),
    set: (key, value) => void secrets.set(key, value),
    delete: (key) => secrets.delete(key),
    keys: () => [...secrets.keys()],
    describe: () => "memory",
  };
};

export interface ResolveStoreOptions {
  env?: NodeJS.ProcessEnv;
  dir: string;
  clientPath: string;
  platform?: NodeJS.Platform;
  warn?: (msg: string) => void;
  importKeyring?: () => Promise<NativeKeyring>;
}

/** Dynamic on purpose: a static import of a native module with no binary for the running
 * platform throws while the module loads, before any fallback could run. */
const importNative = async (): Promise<NativeKeyring> =>
  (await import("@napi-rs/keyring")) as unknown as NativeKeyring;

/**
 * Picks the backend from `GMAIL_MCP_KEYRING`:
 * `file` / `memory` force a store; `auto` (default) prefers the OS keyring and falls back
 * to 0600 files with a warning; `keyring` requires the keyring and fails closed.
 */
export const resolveStore = async ({
  env = process.env,
  dir,
  clientPath,
  platform = process.platform,
  warn = (msg) => console.error(msg),
  importKeyring = importNative,
}: ResolveStoreOptions): Promise<SecretStore> => {
  const mode = (env.GMAIL_MCP_KEYRING || "auto").toLowerCase();
  if (mode === "file") return fileStore({ dir, clientPath });
  if (mode === "memory") return memoryStore();

  try {
    const native = await importKeyring();
    // Entries are created lazily; probing the service is what proves a store is reachable.
    native.findCredentials(SERVICE);
    return keyringStore(native, platform);
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    if (mode === "keyring") {
      throw new Error(
        `GMAIL_MCP_KEYRING=keyring but the OS keyring is unavailable (${message}). ` +
          "Install a Secret Service on Linux (e.g. gnome-keyring), or unset GMAIL_MCP_KEYRING to fall back to files."
      );
    }
    warn(
      `gmail-mcp: OS keyring unavailable (${message}); falling back to 0600 files under ${dir}. ` +
        "Set GMAIL_MCP_KEYRING=keyring to fail instead, or =file to silence this."
    );
    return fileStore({ dir, clientPath });
  }
};
