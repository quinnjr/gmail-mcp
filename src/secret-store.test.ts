import { chmod, mkdtemp, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  fileStore,
  keyringStore,
  memoryStore,
  resolveStore,
  SERVICE,
  type NativeKeyring,
} from "./secret-store.js";

const tmp = () => mkdtemp(path.join(os.tmpdir(), "gmail-mcp-store-"));

interface FakeNative extends NativeKeyring {
  store: Map<string, Map<string, string>>;
  lastOptions: unknown;
}

const fakeNative = (): FakeNative => {
  const store = new Map<string, Map<string, string>>();
  const self = {
    store,
    lastOptions: undefined as unknown,
    Entry: class {
      constructor(
        readonly service: string,
        readonly account: string,
        readonly options?: unknown
      ) {
        self.lastOptions = options;
      }
      getPassword(): string | null {
        return store.get(this.service)?.get(this.account) ?? null;
      }
      setPassword(password: string): void {
        if (!store.has(this.service)) store.set(this.service, new Map());
        store.get(this.service)!.set(this.account, password);
      }
      deletePassword(): boolean {
        return store.get(this.service)?.delete(this.account) ?? false;
      }
    },
    findCredentials(service: string): { account: string; password: string }[] {
      return [...(store.get(service) ?? new Map())].map(([account, password]) => ({ account, password }));
    },
  };
  return self as unknown as FakeNative;
};

describe("fileStore", () => {
  it("round-trips client, oauth, and bearer keys and describes their paths", async () => {
    const dir = await tmp();
    const accounts = path.join(dir, "accounts");
    const s = fileStore({ dir: accounts, clientPath: path.join(dir, "credentials.json") });

    s.set("client", '{"installed":{}}');
    s.set("oauth:amy@example.com", '{"refresh_token":"r"}');
    s.set("bearer:amy@example.com", "tok");

    expect(s.get("client")).toBe('{"installed":{}}');
    expect(s.get("oauth:amy@example.com")).toBe('{"refresh_token":"r"}');
    expect(s.get("bearer:amy@example.com")).toBe("tok");
    expect(s.get("oauth:none@example.com")).toBeUndefined();
    expect(s.keys().sort()).toEqual(["bearer:amy@example.com", "client", "oauth:amy@example.com"]);
    expect(s.describe("client")).toBe(path.join(dir, "credentials.json"));
    expect(s.describe("oauth:amy@example.com")).toBe(path.join(accounts, "amy@example.com.json"));
    expect(s.describe("bearer:amy@example.com")).toBe(path.join(accounts, "amy@example.com.token"));
  });

  it("repairs drifted 0700/0600 permissions on every write", async () => {
    const dir = await tmp();
    const accounts = path.join(dir, "accounts");
    const s = fileStore({ dir: accounts, clientPath: path.join(dir, "credentials.json") });

    s.set("bearer:amy@example.com", "t1");
    await chmod(path.join(accounts, "amy@example.com.token"), 0o644);
    await chmod(accounts, 0o755);
    s.set("bearer:amy@example.com", "t2");

    expect((await stat(path.join(accounts, "amy@example.com.token"))).mode & 0o777).toBe(0o600);
    expect((await stat(accounts)).mode & 0o777).toBe(0o700);
  });

  it("deletes and reports whether the file existed", async () => {
    const dir = await tmp();
    const s = fileStore({ dir: path.join(dir, "accounts"), clientPath: path.join(dir, "credentials.json") });
    s.set("bearer:amy@example.com", "t");
    expect(s.delete("bearer:amy@example.com")).toBe(true);
    expect(s.delete("bearer:amy@example.com")).toBe(false);
    expect(s.get("bearer:amy@example.com")).toBeUndefined();
  });

  it("refuses traversal-shaped account keys", async () => {
    const dir = await tmp();
    const s = fileStore({ dir: path.join(dir, "accounts"), clientPath: path.join(dir, "credentials.json") });
    expect(() => s.get("oauth:../evil")).toThrow(/Invalid account/);
    expect(() => s.get("bearer:a/b")).toThrow(/Invalid account/);
  });
});

describe("keyringStore", () => {
  it("round-trips and lists through the pinned Linux Secret Service", () => {
    const native = fakeNative();
    const s = keyringStore(native, "linux");

    s.set("bearer:amy@example.com", "tok");
    s.set("oauth:amy@example.com", '{"r":1}');
    expect(s.kind).toBe("keyring");
    expect(s.get("bearer:amy@example.com")).toBe("tok");
    expect(s.keys().sort()).toEqual(["bearer:amy@example.com", "oauth:amy@example.com"]);
    expect(s.describe("oauth:amy@example.com")).toBe("the system keyring");
    expect(s.delete("bearer:amy@example.com")).toBe(true);
    expect(s.get("bearer:amy@example.com")).toBeUndefined();
    expect(native.lastOptions).toEqual({ linux: { store: "secret-service" } });
  });

  it("refuses a value over the Windows credential blob cap", () => {
    const s = keyringStore(fakeNative(), "win32");
    expect(() => s.set("oauth:amy@example.com", "x".repeat(2561))).toThrow(/2560/);
    expect(() => s.set("oauth:amy@example.com", "x".repeat(2560))).not.toThrow();
  });
});

describe("memoryStore", () => {
  it("round-trips and deletes", () => {
    const s = memoryStore();
    expect(s.kind).toBe("memory");
    s.set("a", "1");
    expect(s.get("a")).toBe("1");
    expect(s.keys()).toEqual(["a"]);
    expect(s.delete("a")).toBe(true);
    expect(s.get("a")).toBeUndefined();
  });
});

describe("resolveStore", () => {
  const base = { dir: "/tmp/gmail-mcp-store", clientPath: "/tmp/gmail-mcp-store/credentials.json" };

  it("honours GMAIL_MCP_KEYRING=file and =memory", async () => {
    expect((await resolveStore({ ...base, env: { GMAIL_MCP_KEYRING: "file" } })).kind).toBe("file");
    expect((await resolveStore({ ...base, env: { GMAIL_MCP_KEYRING: "memory" } })).kind).toBe("memory");
  });

  it("auto falls back to files and warns when the keyring is unavailable", async () => {
    const warn = vi.fn();
    const s = await resolveStore({
      ...base,
      env: {},
      warn,
      importKeyring: async () => {
        throw new Error("no service");
      },
    });
    expect(s.kind).toBe("file");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("no service"));
  });

  it("auto uses the keyring when the import and probe succeed", async () => {
    const s = await resolveStore({ ...base, env: {}, warn: vi.fn(), importKeyring: async () => fakeNative() });
    expect(s.kind).toBe("keyring");
  });

  it("fails closed under GMAIL_MCP_KEYRING=keyring", async () => {
    await expect(
      resolveStore({
        ...base,
        env: { GMAIL_MCP_KEYRING: "keyring" },
        importKeyring: async () => {
          throw new Error("nope");
        },
      })
    ).rejects.toThrow(/keyring.*unavailable.*nope/s);
  });
});

describe("keyringStore against the real Secret Service", () => {
  const available = async (): Promise<boolean> => {
    try {
      const native = (await import("@napi-rs/keyring")) as unknown as NativeKeyring;
      native.findCredentials(SERVICE);
      return true;
    } catch {
      return false;
    }
  };

  it("stores, lists, and deletes a probe entry when a store is present", async () => {
    if (!(await available())) return;
    const native = (await import("@napi-rs/keyring")) as unknown as NativeKeyring;
    const s = keyringStore(native, process.platform);
    const key = "probe:secret-store-test";
    try {
      s.set(key, "probe-value");
      expect(s.keys()).toContain(key);
      expect(s.get(key)).toBe("probe-value");
    } finally {
      s.delete(key);
    }
  });
});
