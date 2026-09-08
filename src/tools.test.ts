import { describe, expect, it } from "vitest";
import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { gmail_v1 } from "googleapis";
import { z } from "zod";
import { registerTools } from "./tools.js";
import type { Accounts } from "./tools.js";

// Records `users.messages.send` style paths and the single argument each call received.
const recordingGmail = () => {
  const calls: { path: string; args: unknown }[] = [];
  const make = (trail: string[]): unknown =>
    new Proxy(() => {}, {
      get: (_t, prop) => (typeof prop === "string" ? make([...trail, prop]) : undefined),
      apply: (_t, _this, [args]) => {
        calls.push({ path: trail.join("."), args });
        return Promise.resolve({ data: { ok: true, data: Buffer.from("bytes").toString("base64url") } });
      },
    });
  return { gmail: make([]) as unknown as gmail_v1.Gmail, calls };
};

type Registered = { shape: z.ZodRawShape; handler: ToolCallback<z.ZodRawShape> };
const collect = (accounts: Accounts) => {
  const tools = new Map<string, Registered>();
  const server = {
    registerTool: (name: string, config: { inputSchema: z.ZodRawShape }, handler: ToolCallback<z.ZodRawShape>) =>
      tools.set(name, { shape: config.inputSchema, handler }),
  } as unknown as McpServer;
  registerTools(server, accounts);
  return tools;
};

// Minimal valid input for a zod shape: required fields get a placeholder, optionals are left out.
const sample = (schema: z.ZodType): unknown => {
  const def = (schema as unknown as { _zod: { def: Record<string, unknown> } })._zod.def;
  switch (def.type) {
    case "optional": case "default": return sample(def.innerType as z.ZodType);
    case "string": return "x";
    case "number": return 1;
    case "boolean": return true;
    case "enum": return Object.values(def.entries as Record<string, string>)[0];
    case "array": return [sample(def.element as z.ZodType)];
    case "record": return {};
    case "object": return fill(def.shape as z.ZodRawShape);
    default: throw new Error(`unhandled zod type ${String(def.type)}`);
  }
};
const fill = (shape: z.ZodRawShape) =>
  Object.fromEntries(
    Object.entries(shape)
      .filter(([, s]) => (s as unknown as { _zod: { def: { type: string } } })._zod.def.type !== "optional")
      .map(([k, s]) => [k, sample(s as z.ZodType)])
  );

const invoke = async (t: Registered, args: Record<string, unknown>) =>
  t.handler(z.object(t.shape).parse(args), {} as never);

describe("registerTools", () => {
  const amy = recordingGmail();
  const bob = recordingGmail();
  const accounts: Accounts = {
    clients: new Map([["amy@example.com", amy.gmail], ["bob@example.com", bob.gmail]]),
    default: "amy@example.com",
  };
  const tools = collect(accounts);
  const accountTools = new Set(["gmail_list_accounts"]);

  it("registers all 80 users.* endpoints plus 1 account tool", () => {
    expect(tools.size).toBe(81);
    expect(tools.has("gmail_set_default_account")).toBe(false);
  });

  it("every tool reaches exactly one googleapis method with its required input and returns JSON text", async () => {
    for (const [name, t] of tools) {
      if (accountTools.has(name)) continue;
      amy.calls.length = 0;
      const result = await invoke(t, fill(t.shape));
      expect(amy.calls, name).toHaveLength(1);
      expect(amy.calls[0].path, name).toMatch(/^users\./);
      expect(() => JSON.parse((result.content[0] as { text: string }).text), name).not.toThrow();
    }
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

  it("treats a blank account as omitted and routes to the default account", async () => {
    amy.calls.length = 0;
    await invoke(tools.get("gmail_get_profile")!, { account: "  " });
    expect(amy.calls.map((c) => c.path)).toEqual(["users.getProfile"]);
  });

  it("rejects an unknown account before touching Google, listing what is signed in", async () => {
    amy.calls.length = 0;
    await expect(invoke(tools.get("gmail_get_profile")!, { account: "zed@example.com" }))
      .rejects.toThrow(/Unknown account "zed@example.com".*amy@example.com, bob@example.com.*gmail-mcp auth/);
    expect(amy.calls.length).toBe(0);
  });

  it.each([
    ["gmail_send_message", { to: ["a@b"], text: "hi" }, "users.messages.send", (a: any) => a.userId === "me" && typeof a.requestBody.raw === "string"],
    ["gmail_insert_message", { text: "hi", labelIds: ["INBOX"], deleted: false }, "users.messages.insert", (a: any) => a.requestBody.labelIds[0] === "INBOX" && a.deleted === false],
    ["gmail_modify_message", { id: "m", addLabelIds: ["STARRED"] }, "users.messages.modify", (a: any) => a.id === "m" && a.requestBody.addLabelIds[0] === "STARRED"],
    ["gmail_batch_delete_messages", { ids: ["a", "b"] }, "users.messages.batchDelete", (a: any) => a.requestBody.ids.length === 2],
    ["gmail_send_draft", { id: "d" }, "users.drafts.send", (a: any) => a.requestBody.id === "d"],
    ["gmail_update_draft", { id: "d", userId: "u@x", text: "t" }, "users.drafts.update", (a: any) => a.userId === "u@x" && a.id === "d" && typeof a.requestBody.message.raw === "string"],
    ["gmail_create_filter", { criteria: { from: "x" }, action: { addLabelIds: ["L"] } }, "users.settings.filters.create", (a: any) => a.requestBody.criteria.from === "x"],
    ["gmail_patch_cse_identity", { emailAddress: "e", identity: { primaryKeyPairId: "k" } }, "users.settings.cse.identities.patch", (a: any) => a.emailAddress === "e" && a.requestBody.primaryKeyPairId === "k"],
    ["gmail_enable_cse_keypair", { keyPairId: "k" }, "users.settings.cse.keypairs.enable", (a: any) => a.keyPairId === "k" && typeof a.requestBody === "object"],
    ["gmail_watch", { topicName: "projects/p/topics/t" }, "users.watch", (a: any) => a.requestBody.topicName.endsWith("/t")],
  ])("%s places its parameters where googleapis expects", async (name, args, path, check) => {
    amy.calls.length = 0;
    await invoke(tools.get(name)!, args);
    expect(amy.calls[0].path).toBe(path);
    expect(check(amy.calls[0].args)).toBe(true);
  });

  it("gmail_get_message decodes format=full and passes other formats through", async () => {
    const parsed = await invoke(tools.get("gmail_get_message")!, { id: "m" });
    expect(JSON.parse((parsed.content[0] as { text: string }).text)).toMatchObject({ headers: {}, attachments: [] });
    const raw = await invoke(tools.get("gmail_get_message")!, { id: "m", format: "raw" });
    expect(JSON.parse((raw.content[0] as { text: string }).text)).toMatchObject({ ok: true });
  });

  it("gmail_get_attachment returns standard base64 of the base64url payload", async () => {
    const r = await invoke(tools.get("gmail_get_attachment")!, { messageId: "m", id: "a" });
    expect(JSON.parse((r.content[0] as { text: string }).text)).toEqual({ size: 5, data: Buffer.from("bytes").toString("base64") });
  });

  it("gmail_list_accounts reports the signed-in accounts and the bound one", async () => {
    const list = await invoke(tools.get("gmail_list_accounts")!, {});
    expect(JSON.parse((list.content[0] as { text: string }).text)).toEqual({ accounts: ["amy@example.com", "bob@example.com"], default: "amy@example.com" });
  });

  it("wraps Google auth errors with the account and the command that fixes them", async () => {
    const failing = { users: { getProfile: () => Promise.reject(Object.assign(new Error("invalid_grant"), { code: 400 })), settings: {} } } as unknown as gmail_v1.Gmail;
    const t = collect({ clients: new Map([["amy@example.com", failing]]), default: "amy@example.com" }).get("gmail_get_profile")!;
    await expect(invoke(t, {})).rejects.toThrow(/amy@example\.com.*gmail-mcp auth/);
  });

  it("wraps a 403 insufficient-scope error on gmail_get_profile with the account and the fix", async () => {
    const failing = {
      users: { getProfile: () => Promise.reject(Object.assign(new Error("insufficient scope"), { code: 403 })), settings: {} },
    } as unknown as gmail_v1.Gmail;
    const t = collect({ clients: new Map([["amy@example.com", failing]]), default: "amy@example.com" }).get("gmail_get_profile")!;
    // explain()'s 403-scope message puts the raw Google error last, after the `gmail-mcp auth` fix
    // instruction, so this checks the account + fix + raw error text in the order they actually appear.
    await expect(invoke(t, {})).rejects.toThrow(/amy@example\.com.*gmail-mcp auth.*insufficient scope/);
  });

  it("wraps a failing messages.get on gmail_get_message with the account and the fix", async () => {
    const failing = {
      users: { messages: { get: () => Promise.reject(Object.assign(new Error("invalid_grant"), { code: 400 })) }, settings: {} },
    } as unknown as gmail_v1.Gmail;
    const t = collect({ clients: new Map([["amy@example.com", failing]]), default: "amy@example.com" }).get("gmail_get_message")!;
    await expect(invoke(t, { id: "m" })).rejects.toThrow(/amy@example\.com.*gmail-mcp auth/);
  });
});
