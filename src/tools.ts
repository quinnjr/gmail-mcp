import { promises as fs } from "node:fs";
import path from "node:path";
import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import type { gmail_v1 } from "googleapis";
import { z } from "zod";
import { normalizeEmail, unknownAccountError } from "./auth.js";
import { buildRaw, parseMessage } from "./mime.js";

type Gmail = gmail_v1.Gmail;

export interface Accounts {
  clients: Map<string, Gmail>;
  default: string;
  /** Persist a new default. Called by gmail_set_default_account after validation. */
  setDefault: (email: string) => Promise<void>;
}

const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v ?? {}, null, 2) }] });

// Google's errors say what failed, not what to do about it. Prefix the fix.
const explain = (err: unknown, account: string): string => {
  const e = err as { code?: number | string; message?: string; response?: { status?: number } };
  const status = Number(e.response?.status ?? e.code);
  const msg = e.message ?? String(err);
  if (status === 401 || /invalid_grant/.test(msg))
    return `Gmail authorization for ${account} expired or was revoked. Run \`gmail-mcp auth\` and sign in as ${account}. (${msg})`;
  if (status === 403 && /scope|insufficient/i.test(msg))
    return `The stored token for ${account} lacks the scope for this call. Run \`gmail-mcp auth\` and sign in as ${account} to grant the full scope set. (${msg})`;
  if (status === 403) return `Gmail refused the request (permission or quota). (${msg})`;
  if (status === 404) return `Gmail could not find that resource; check the id. (${msg})`;
  if (status === 429) return `Gmail API rate limit hit; retry after a short delay. (${msg})`;
  return msg;
};
type Call = <T>(fn: () => Promise<{ data: T }>) => Promise<ReturnType<typeof json>>;
const caller = (account: string): Call => async (fn) => {
  try {
    return json((await fn()).data);
  } catch (err) {
    throw new Error(explain(err, account));
  }
};

const ids = {
  userId: z.string().default("me").describe("Mailbox; 'me' is the authenticated user"),
  account: z.string().optional().describe("Signed-in Gmail address to act as. Omit for the default account."),
};
const body = z.record(z.string(), z.unknown());
const attachment = z.object({
  path: z.string().optional().describe("Local file path"),
  data: z.string().optional().describe("Base64 bytes, when not using path"),
  filename: z.string().optional(),
  mimeType: z.string().optional(),
  contentId: z.string().optional().describe("Content-ID for inline images (cid:...)"),
});
const composeShape = {
  to: z.array(z.string()).optional(),
  cc: z.array(z.string()).optional(),
  bcc: z.array(z.string()).optional(),
  from: z.string().optional().describe("Must be the account or a verified send-as alias"),
  replyTo: z.string().optional(),
  subject: z.string().optional(),
  text: z.string().optional().describe("Plain-text body"),
  html: z.string().optional().describe("HTML body; with text, sent as multipart/alternative"),
  inReplyTo: z.string().optional().describe("Message-ID header of the message being replied to"),
  references: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional().describe("Extra RFC 822 headers"),
  attachments: z.array(attachment).optional(),
  threadId: z.string().optional().describe("Keep the message in an existing thread"),
};
type Compose = z.infer<z.ZodObject<typeof composeShape>>;
const rawMessage = async (c: Compose, labelIds?: string[]): Promise<gmail_v1.Schema$Message> => ({
  raw: await buildRaw(c),
  threadId: c.threadId,
  ...(labelIds ? { labelIds } : {}),
});

const fmt = z.enum(["minimal", "full", "raw", "metadata"]).default("full");
// Workspace classification labels (ModifyMessageRequest / BatchModifyMessagesRequest).
const classification = {
  addClassificationLabels: z.array(z.object({
    labelId: z.string(),
    fields: z.array(z.record(z.string(), z.unknown())).optional().describe("ClassificationLabelFieldValue objects"),
  })).optional(),
  removeClassificationLabelIds: z.array(z.string()).optional(),
};

export const registerTools = (server: McpServer, accounts: Accounts): void => {
  const known = () => [...accounts.clients.keys()].sort();
  const resolve = (account?: string): { email: string; gmail: Gmail } => {
    const email = normalizeEmail(account?.trim() || accounts.default);
    const gmail = accounts.clients.get(email);
    if (!gmail) throw unknownAccountError(email, known());
    return { email, gmail };
  };

  // Handlers receive the account's Gmail client and a `call` bound to that account's error messages.
  type Handler<S extends z.ZodRawShape> = (
    args: Omit<z.infer<z.ZodObject<S>>, "account">,
    gmail: Gmail,
    call: Call
  ) => ReturnType<ToolCallback<S>>;
  const tool = <S extends z.ZodRawShape>(name: string, description: string, shape: S, handler: Handler<S>) =>
    server.registerTool(name, { description, inputSchema: shape }, ((
      args: z.infer<z.ZodObject<S>>,
      _extra: RequestHandlerExtra<ServerRequest, ServerNotification>
    ) => {
      const { account, ...rest } = args as { account?: string };
      const { email, gmail } = resolve(account);
      return handler(rest as Omit<z.infer<z.ZodObject<S>>, "account">, gmail, caller(email));
      // Handler<S>'s return type (ReturnType<ToolCallback<S>>, reached through the generic `call`)
      // doesn't structurally overlap CallToolResult closely enough for a single `as ToolCallback<S>`;
      // TS requires routing through `unknown` first.
    }) as unknown as ToolCallback<S>);

  // ---- accounts ----
  server.registerTool("gmail_list_accounts", { description: "Signed-in Gmail accounts and which one is the default", inputSchema: {} },
    () => json({ accounts: known(), default: accounts.default }));
  server.registerTool("gmail_set_default_account",
    { description: "Change which signed-in account tools use when `account` is omitted (server-wide, persisted)",
      inputSchema: { account: z.string().min(1) } },
    async ({ account }) => {
      const email = normalizeEmail(account);
      if (!accounts.clients.has(email)) throw unknownAccountError(email, known());
      await accounts.setDefault(email);
      accounts.default = email;
      return json({ default: email });
    });

  // ---- users ----
  tool("gmail_get_profile", "Mailbox profile: email, message/thread totals, historyId", ids,
    (a, gmail, call) => call(() => gmail.users.getProfile(a)));
  tool("gmail_watch", "Set up Pub/Sub push notifications for the mailbox",
    { ...ids, topicName: z.string(), labelIds: z.array(z.string()).optional(),
      labelFilterBehavior: z.enum(["include", "exclude"]).optional() },
    ({ userId, ...requestBody }, gmail, call) => call(() => gmail.users.watch({ userId, requestBody })));
  tool("gmail_stop", "Stop push notifications", ids, (a, gmail, call) => call(() => gmail.users.stop(a)));

  // ---- messages ----
  tool("gmail_list_messages", "List message ids matching a Gmail search query",
    { ...ids, q: z.string().optional().describe("Gmail search syntax, e.g. 'from:x is:unread'"),
      labelIds: z.array(z.string()).optional(), maxResults: z.number().int().min(1).max(500).optional().describe("Defaults to the Gmail API default of 100"),
      pageToken: z.string().optional(), includeSpamTrash: z.boolean().optional() },
    (a, gmail, call) => call(() => gmail.users.messages.list(a)));
  tool("gmail_get_message", "Get one message. format=full returns decoded, untruncated text and html bodies plus attachment metadata; raw returns the whole RFC 822 source",
    { ...ids, id: z.string(), format: fmt, metadataHeaders: z.array(z.string()).optional() },
    (a, gmail, call) => call(async () => {
      const { data } = await gmail.users.messages.get(a);
      return { data: a.format === "full" ? parseMessage(data) : data };
    }));
  tool("gmail_send_message", "Compose and send an email with optional attachments", { ...ids, ...composeShape },
    ({ userId, ...c }, gmail, call) => call(async () => gmail.users.messages.send({ userId, requestBody: await rawMessage(c) })));
  tool("gmail_send_raw", "Send a pre-built RFC 822 message (base64url `raw`)",
    { ...ids, raw: z.string(), threadId: z.string().optional() },
    ({ userId, ...requestBody }, gmail, call) => call(() => gmail.users.messages.send({ userId, requestBody })));
  tool("gmail_insert_message", "Insert a message directly into the mailbox, bypassing scanning and classification",
    { ...composeShape, ...ids, labelIds: z.array(z.string()).optional(),
      internalDateSource: z.enum(["receivedTime", "dateHeader"]).optional(), deleted: z.boolean().optional() },
    ({ userId, labelIds, internalDateSource, deleted, ...c }, gmail, call) =>
      call(async () => gmail.users.messages.insert({ userId, internalDateSource, deleted,
        requestBody: await rawMessage(c, labelIds) })));
  tool("gmail_import_message", "Import a message with standard delivery scanning (like SMTP receipt)",
    { ...composeShape, ...ids, labelIds: z.array(z.string()).optional(),
      internalDateSource: z.enum(["receivedTime", "dateHeader"]).optional(),
      neverMarkSpam: z.boolean().optional(), processForCalendar: z.boolean().optional(), deleted: z.boolean().optional() },
    ({ userId, labelIds, internalDateSource, neverMarkSpam, processForCalendar, deleted, ...c }, gmail, call) =>
      call(async () => gmail.users.messages.import({ userId, internalDateSource, neverMarkSpam, processForCalendar, deleted,
        requestBody: await rawMessage(c, labelIds) })));
  tool("gmail_modify_message", "Add/remove labels on a message (read/unread, star, archive, custom and classification labels)",
    { ...ids, id: z.string(), addLabelIds: z.array(z.string()).optional(), removeLabelIds: z.array(z.string()).optional(), ...classification },
    ({ userId, id, ...requestBody }, gmail, call) => call(() => gmail.users.messages.modify({ userId, id, requestBody })));
  tool("gmail_batch_modify_messages", "Add/remove labels (and Workspace classification labels) on up to 1000 messages",
    { ...ids, ids: z.array(z.string()).min(1).max(1000), addLabelIds: z.array(z.string()).optional(), removeLabelIds: z.array(z.string()).optional(),
      ...classification },
    ({ userId, ...requestBody }, gmail, call) => call(() => gmail.users.messages.batchModify({ userId, requestBody })));
  tool("gmail_trash_message", "Move a message to Trash", { ...ids, id: z.string() }, (a, gmail, call) => call(() => gmail.users.messages.trash(a)));
  tool("gmail_untrash_message", "Restore a message from Trash", { ...ids, id: z.string() }, (a, gmail, call) => call(() => gmail.users.messages.untrash(a)));
  tool("gmail_delete_message", "Permanently delete a message (bypasses Trash; needs full mail scope)",
    { ...ids, id: z.string() }, (a, gmail, call) => call(() => gmail.users.messages.delete(a)));
  tool("gmail_batch_delete_messages", "Permanently delete many messages (bypasses Trash; needs full mail scope)",
    { ...ids, ids: z.array(z.string()).min(1).max(1000) },
    ({ userId, ids }, gmail, call) => call(() => gmail.users.messages.batchDelete({ userId, requestBody: { ids } })));
  tool("gmail_get_attachment", "Download an attachment. Returns base64 data, or writes to savePath and returns the path",
    { ...ids, messageId: z.string(), id: z.string().describe("attachmentId from gmail_get_message"),
      savePath: z.string().optional().describe("Write bytes here instead of returning them") },
    ({ userId, messageId, id, savePath }, gmail, call) => call(async (): Promise<{ data: { size: number; data?: string; path?: string } }> => {
      const { data } = await gmail.users.messages.attachments.get({ userId, messageId, id });
      const bytes = Buffer.from(data.data ?? "", "base64url");
      if (!savePath) return { data: { size: bytes.byteLength, data: bytes.toString("base64") } };
      const abs = path.resolve(savePath);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, bytes);
      return { data: { size: bytes.byteLength, path: abs } };
    }));

  // ---- threads ----
  tool("gmail_list_threads", "List threads matching a query",
    { ...ids, q: z.string().optional(), labelIds: z.array(z.string()).optional(),
      maxResults: z.number().int().min(1).max(500).optional().describe("Defaults to the Gmail API default of 100"), pageToken: z.string().optional(), includeSpamTrash: z.boolean().optional() },
    (a, gmail, call) => call(() => gmail.users.threads.list(a)));
  tool("gmail_get_thread", "Get a thread with every message fully decoded (untruncated bodies, attachment metadata)",
    { ...ids, id: z.string(), format: fmt, metadataHeaders: z.array(z.string()).optional() },
    (a, gmail, call) => call(async () => {
      const { data } = await gmail.users.threads.get(a);
      return { data: a.format === "full"
        ? { id: data.id, historyId: data.historyId, snippet: data.snippet, messages: (data.messages ?? []).map(parseMessage) }
        : data };
    }));
  tool("gmail_modify_thread", "Add/remove labels on every message in a thread",
    { ...ids, id: z.string(), addLabelIds: z.array(z.string()).optional(), removeLabelIds: z.array(z.string()).optional() },
    ({ userId, id, ...requestBody }, gmail, call) => call(() => gmail.users.threads.modify({ userId, id, requestBody })));
  tool("gmail_trash_thread", "Move a thread to Trash", { ...ids, id: z.string() }, (a, gmail, call) => call(() => gmail.users.threads.trash(a)));
  tool("gmail_untrash_thread", "Restore a thread from Trash", { ...ids, id: z.string() }, (a, gmail, call) => call(() => gmail.users.threads.untrash(a)));
  tool("gmail_delete_thread", "Permanently delete a thread (needs full mail scope)", { ...ids, id: z.string() }, (a, gmail, call) => call(() => gmail.users.threads.delete(a)));

  // ---- drafts ----
  tool("gmail_list_drafts", "List drafts",
    { ...ids, q: z.string().optional(), maxResults: z.number().int().min(1).max(500).optional().describe("Defaults to the Gmail API default of 100"), pageToken: z.string().optional(), includeSpamTrash: z.boolean().optional() },
    (a, gmail, call) => call(() => gmail.users.drafts.list(a)));
  tool("gmail_get_draft", "Get a draft with its message fully decoded", { ...ids, id: z.string(), format: fmt },
    (a, gmail, call) => call(async () => {
      const { data } = await gmail.users.drafts.get(a);
      return { data: a.format === "full" && data.message ? { id: data.id, message: parseMessage(data.message) } : data };
    }));
  tool("gmail_create_draft", "Create a draft with optional attachments", { ...ids, ...composeShape },
    ({ userId, ...c }, gmail, call) => call(async () => gmail.users.drafts.create({ userId, requestBody: { message: await rawMessage(c) } })));
  tool("gmail_update_draft", "Replace a draft's content", { ...ids, id: z.string(), ...composeShape },
    ({ userId, id, ...c }, gmail, call) => call(async () => gmail.users.drafts.update({ userId, id, requestBody: { message: await rawMessage(c) } })));
  tool("gmail_send_draft", "Send an existing draft", { ...ids, id: z.string() },
    ({ userId, id }, gmail, call) => call(() => gmail.users.drafts.send({ userId, requestBody: { id } })));
  tool("gmail_delete_draft", "Discard a draft", { ...ids, id: z.string() }, (a, gmail, call) => call(() => gmail.users.drafts.delete(a)));

  // ---- labels ----
  const labelShape = {
    name: z.string().optional(), messageListVisibility: z.enum(["show", "hide"]).optional(),
    labelListVisibility: z.enum(["labelShow", "labelShowIfUnread", "labelHide"]).optional(),
    color: z.object({ textColor: z.string(), backgroundColor: z.string() }).optional(),
  };
  tool("gmail_list_labels", "List labels", ids, (a, gmail, call) => call(() => gmail.users.labels.list(a)));
  tool("gmail_get_label", "Get a label with message/thread counts", { ...ids, id: z.string() }, (a, gmail, call) => call(() => gmail.users.labels.get(a)));
  tool("gmail_create_label", "Create a label", { ...ids, ...labelShape, name: z.string() },
    ({ userId, ...requestBody }, gmail, call) => call(() => gmail.users.labels.create({ userId, requestBody })));
  tool("gmail_update_label", "Replace a label", { ...ids, id: z.string(), ...labelShape },
    ({ userId, id, ...requestBody }, gmail, call) => call(() => gmail.users.labels.update({ userId, id, requestBody })));
  tool("gmail_patch_label", "Partially update a label", { ...ids, id: z.string(), ...labelShape },
    ({ userId, id, ...requestBody }, gmail, call) => call(() => gmail.users.labels.patch({ userId, id, requestBody })));
  tool("gmail_delete_label", "Delete a label (removed from all messages)", { ...ids, id: z.string() }, (a, gmail, call) => call(() => gmail.users.labels.delete(a)));

  // ---- history ----
  tool("gmail_list_history", "Mailbox changes since a historyId",
    { ...ids, startHistoryId: z.string(), historyTypes: z.array(z.enum(["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"])).optional(),
      labelId: z.string().optional(), maxResults: z.number().int().min(1).max(500).optional(), pageToken: z.string().optional() },
    (a, gmail, call) => call(() => gmail.users.history.list(a)));

  // ---- settings ----
  tool("gmail_get_auto_forwarding", "Auto-forwarding setting", ids, (a, gmail, call) => call(() => gmail.users.settings.getAutoForwarding(a)));
  tool("gmail_update_auto_forwarding", "Set auto-forwarding (address must be a verified forwarding address)",
    { ...ids, enabled: z.boolean(), emailAddress: z.string().optional(), disposition: z.enum(["leaveInInbox", "archive", "trash", "markRead"]).optional() },
    ({ userId, ...requestBody }, gmail, call) => call(() => gmail.users.settings.updateAutoForwarding({ userId, requestBody })));
  tool("gmail_get_imap", "IMAP settings", ids, (a, gmail, call) => call(() => gmail.users.settings.getImap(a)));
  tool("gmail_update_imap", "Update IMAP settings", { ...ids, settings: body.describe("ImapSettings: enabled, autoExpunge, expungeBehavior, maxFolderSize") },
    ({ userId, settings }, gmail, call) => call(() => gmail.users.settings.updateImap({ userId, requestBody: settings })));
  tool("gmail_get_pop", "POP settings", ids, (a, gmail, call) => call(() => gmail.users.settings.getPop(a)));
  tool("gmail_update_pop", "Update POP settings", { ...ids, settings: body.describe("PopSettings: accessWindow, disposition") },
    ({ userId, settings }, gmail, call) => call(() => gmail.users.settings.updatePop({ userId, requestBody: settings })));
  tool("gmail_get_vacation", "Vacation responder settings", ids, (a, gmail, call) => call(() => gmail.users.settings.getVacation(a)));
  tool("gmail_update_vacation", "Update vacation responder",
    { ...ids, enableAutoReply: z.boolean(), responseSubject: z.string().optional(), responseBodyPlainText: z.string().optional(),
      responseBodyHtml: z.string().optional(), restrictToContacts: z.boolean().optional(), restrictToDomain: z.boolean().optional(),
      startTime: z.string().optional().describe("epoch ms"), endTime: z.string().optional().describe("epoch ms") },
    ({ userId, ...requestBody }, gmail, call) => call(() => gmail.users.settings.updateVacation({ userId, requestBody })));
  tool("gmail_get_language", "Display language", ids, (a, gmail, call) => call(() => gmail.users.settings.getLanguage(a)));
  tool("gmail_update_language", "Set display language", { ...ids, displayLanguage: z.string() },
    ({ userId, ...requestBody }, gmail, call) => call(() => gmail.users.settings.updateLanguage({ userId, requestBody })));

  tool("gmail_list_delegates", "List delegates", ids, (a, gmail, call) => call(() => gmail.users.settings.delegates.list(a)));
  tool("gmail_get_delegate", "Get a delegate", { ...ids, delegateEmail: z.string() }, (a, gmail, call) => call(() => gmail.users.settings.delegates.get(a)));
  tool("gmail_create_delegate", "Add a delegate (Workspace only)", { ...ids, delegateEmail: z.string() },
    ({ userId, delegateEmail }, gmail, call) => call(() => gmail.users.settings.delegates.create({ userId, requestBody: { delegateEmail } })));
  tool("gmail_delete_delegate", "Remove a delegate", { ...ids, delegateEmail: z.string() }, (a, gmail, call) => call(() => gmail.users.settings.delegates.delete(a)));

  tool("gmail_list_filters", "List filters", ids, (a, gmail, call) => call(() => gmail.users.settings.filters.list(a)));
  tool("gmail_get_filter", "Get a filter", { ...ids, id: z.string() }, (a, gmail, call) => call(() => gmail.users.settings.filters.get(a)));
  tool("gmail_create_filter", "Create a filter",
    { ...ids,
      criteria: z.object({ from: z.string().optional(), to: z.string().optional(), subject: z.string().optional(), query: z.string().optional(),
        negatedQuery: z.string().optional(), hasAttachment: z.boolean().optional(), excludeChats: z.boolean().optional(),
        size: z.number().optional(), sizeComparison: z.enum(["larger", "smaller"]).optional() }),
      action: z.object({ addLabelIds: z.array(z.string()).optional(), removeLabelIds: z.array(z.string()).optional(), forward: z.string().optional() }) },
    ({ userId, ...requestBody }, gmail, call) => call(() => gmail.users.settings.filters.create({ userId, requestBody })));
  tool("gmail_delete_filter", "Delete a filter", { ...ids, id: z.string() }, (a, gmail, call) => call(() => gmail.users.settings.filters.delete(a)));

  tool("gmail_list_forwarding_addresses", "List forwarding addresses", ids, (a, gmail, call) => call(() => gmail.users.settings.forwardingAddresses.list(a)));
  tool("gmail_get_forwarding_address", "Get a forwarding address", { ...ids, forwardingEmail: z.string() }, (a, gmail, call) => call(() => gmail.users.settings.forwardingAddresses.get(a)));
  tool("gmail_create_forwarding_address", "Add a forwarding address (triggers verification mail)", { ...ids, forwardingEmail: z.string() },
    ({ userId, forwardingEmail }, gmail, call) => call(() => gmail.users.settings.forwardingAddresses.create({ userId, requestBody: { forwardingEmail } })));
  tool("gmail_delete_forwarding_address", "Remove a forwarding address", { ...ids, forwardingEmail: z.string() }, (a, gmail, call) => call(() => gmail.users.settings.forwardingAddresses.delete(a)));

  tool("gmail_list_send_as", "List send-as aliases", ids, (a, gmail, call) => call(() => gmail.users.settings.sendAs.list(a)));
  tool("gmail_get_send_as", "Get a send-as alias", { ...ids, sendAsEmail: z.string() }, (a, gmail, call) => call(() => gmail.users.settings.sendAs.get(a)));
  tool("gmail_create_send_as", "Create a send-as alias", { ...ids, sendAs: body.describe("SendAs resource: sendAsEmail, displayName, replyToAddress, signature, smtpMsa, treatAsAlias, isDefault") },
    ({ userId, sendAs }, gmail, call) => call(() => gmail.users.settings.sendAs.create({ userId, requestBody: sendAs })));
  tool("gmail_update_send_as", "Replace a send-as alias (e.g. set signature)", { ...ids, sendAsEmail: z.string(), sendAs: body },
    ({ userId, sendAsEmail, sendAs }, gmail, call) => call(() => gmail.users.settings.sendAs.update({ userId, sendAsEmail, requestBody: sendAs })));
  tool("gmail_patch_send_as", "Partially update a send-as alias", { ...ids, sendAsEmail: z.string(), sendAs: body },
    ({ userId, sendAsEmail, sendAs }, gmail, call) => call(() => gmail.users.settings.sendAs.patch({ userId, sendAsEmail, requestBody: sendAs })));
  tool("gmail_delete_send_as", "Delete a send-as alias", { ...ids, sendAsEmail: z.string() }, (a, gmail, call) => call(() => gmail.users.settings.sendAs.delete(a)));
  tool("gmail_verify_send_as", "Re-send verification for a send-as alias", { ...ids, sendAsEmail: z.string() }, (a, gmail, call) => call(() => gmail.users.settings.sendAs.verify(a)));

  tool("gmail_list_smime_info", "List S/MIME configs for an alias", { ...ids, sendAsEmail: z.string() }, (a, gmail, call) => call(() => gmail.users.settings.sendAs.smimeInfo.list(a)));
  tool("gmail_get_smime_info", "Get an S/MIME config", { ...ids, sendAsEmail: z.string(), id: z.string() }, (a, gmail, call) => call(() => gmail.users.settings.sendAs.smimeInfo.get(a)));
  tool("gmail_insert_smime_info", "Upload an S/MIME config", { ...ids, sendAsEmail: z.string(), smimeInfo: body.describe("SmimeInfo: pkcs12 (base64), encryptedKeyPassword, isDefault") },
    ({ userId, sendAsEmail, smimeInfo }, gmail, call) => call(() => gmail.users.settings.sendAs.smimeInfo.insert({ userId, sendAsEmail, requestBody: smimeInfo })));
  tool("gmail_set_default_smime_info", "Set the default S/MIME config", { ...ids, sendAsEmail: z.string(), id: z.string() }, (a, gmail, call) => call(() => gmail.users.settings.sendAs.smimeInfo.setDefault(a)));
  tool("gmail_delete_smime_info", "Delete an S/MIME config", { ...ids, sendAsEmail: z.string(), id: z.string() }, (a, gmail, call) => call(() => gmail.users.settings.sendAs.smimeInfo.delete(a)));

  tool("gmail_list_cse_identities", "List client-side encryption identities", { ...ids, pageSize: z.number().optional(), pageToken: z.string().optional() },
    (a, gmail, call) => call(() => gmail.users.settings.cse.identities.list(a)));
  tool("gmail_get_cse_identity", "Get a CSE identity", { ...ids, cseEmailAddress: z.string() }, (a, gmail, call) => call(() => gmail.users.settings.cse.identities.get(a)));
  tool("gmail_create_cse_identity", "Create a CSE identity", { ...ids, identity: body.describe("CseIdentity: emailAddress, primaryKeyPairId or signAndEncryptKeyPairs") },
    ({ userId, identity }, gmail, call) => call(() => gmail.users.settings.cse.identities.create({ userId, requestBody: identity })));
  tool("gmail_patch_cse_identity", "Update a CSE identity", { ...ids, emailAddress: z.string(), identity: body },
    ({ userId, emailAddress, identity }, gmail, call) => call(() => gmail.users.settings.cse.identities.patch({ userId, emailAddress, requestBody: identity })));
  tool("gmail_delete_cse_identity", "Delete a CSE identity", { ...ids, cseEmailAddress: z.string() }, (a, gmail, call) => call(() => gmail.users.settings.cse.identities.delete(a)));

  tool("gmail_list_cse_keypairs", "List CSE key pairs", { ...ids, pageSize: z.number().optional(), pageToken: z.string().optional() },
    (a, gmail, call) => call(() => gmail.users.settings.cse.keypairs.list(a)));
  tool("gmail_get_cse_keypair", "Get a CSE key pair", { ...ids, keyPairId: z.string() }, (a, gmail, call) => call(() => gmail.users.settings.cse.keypairs.get(a)));
  tool("gmail_create_cse_keypair", "Upload a CSE key pair", { ...ids, keyPair: body.describe("CseKeyPair: pkcs7, privateKeyMetadata") },
    ({ userId, keyPair }, gmail, call) => call(() => gmail.users.settings.cse.keypairs.create({ userId, requestBody: keyPair })));
  tool("gmail_enable_cse_keypair", "Enable a CSE key pair", { ...ids, keyPairId: z.string() }, (a, gmail, call) => call(() => gmail.users.settings.cse.keypairs.enable({ ...a, requestBody: {} })));
  tool("gmail_disable_cse_keypair", "Disable a CSE key pair", { ...ids, keyPairId: z.string() }, (a, gmail, call) => call(() => gmail.users.settings.cse.keypairs.disable({ ...a, requestBody: {} })));
  tool("gmail_obliterate_cse_keypair", "Permanently delete a disabled CSE key pair", { ...ids, keyPairId: z.string() }, (a, gmail, call) => call(() => gmail.users.settings.cse.keypairs.obliterate({ ...a, requestBody: {} })));
};
