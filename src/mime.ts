import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { gmail_v1 } from "googleapis";

export interface AttachmentInput {
  /** Local file to attach. Either `path` or `data` is required. */
  path?: string;
  /** Base64 (or base64url) bytes, when not using `path`. */
  data?: string;
  /** Defaults to the basename of `path`. */
  filename?: string;
  /** Guessed from the extension when omitted. */
  mimeType?: string;
  /** Content-ID for inline images referenced from HTML as cid:... */
  contentId?: string;
}

export interface OutgoingMessage {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  from?: string;
  replyTo?: string;
  subject?: string;
  text?: string;
  html?: string;
  inReplyTo?: string;
  references?: string;
  headers?: Record<string, string>;
  attachments?: AttachmentInput[];
}

// ponytail: small extension map; anything else is octet-stream and Gmail sniffs it.
const MIME_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".txt": "text/plain",
  ".md": "text/markdown", ".csv": "text/csv", ".json": "application/json", ".html": "text/html",
  ".xml": "application/xml", ".zip": "application/zip", ".gz": "application/gzip",
  ".doc": "application/msword", ".xls": "application/vnd.ms-excel", ".ppt": "application/vnd.ms-powerpoint",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".mp3": "audio/mpeg", ".mp4": "video/mp4", ".ics": "text/calendar",
};

// Header values go into a raw RFC 822 message; a CR/LF would inject headers.
const clean = (v: string): string => v.replace(/[\r\n]+/g, " ").trim();
// RFC 2047 for non-ASCII header text.
const encodeWord = (v: string): string =>
  /^[\x20-\x7E]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`;
// RFC 2045: 76-char lines.
const b64Lines = (buf: Buffer): string => buf.toString("base64").replace(/(.{76})(?=.)/g, "$1\r\n");
const asciiName = (name: string): string => clean(name).replace(/["\\]/g, "_");
const filenameParams = (name: string): string => {
  const safe = asciiName(name);
  const ascii = safe.replace(/[^\x20-\x7E]/g, "_");
  return ascii === safe
    ? `filename="${ascii}"`
    : `filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
};

const loadAttachment = async (a: AttachmentInput) => {
  if (!a.path && !a.data) throw new Error("attachment needs `path` or `data`");
  const data = a.path ? await fs.readFile(a.path) : Buffer.from(a.data!, "base64");
  const filename = a.filename ?? (a.path ? path.basename(a.path) : "attachment");
  const mimeType =
    a.mimeType ?? MIME_BY_EXT[path.extname(filename).toLowerCase()] ?? "application/octet-stream";
  return { data, filename, mimeType, contentId: a.contentId };
};

const textPart = (type: string, body: string): string =>
  [
    `Content-Type: ${type}; charset="UTF-8"`,
    "Content-Transfer-Encoding: base64",
    "",
    b64Lines(Buffer.from(body, "utf8")),
  ].join("\r\n");

/** Build an RFC 822 message and return it base64url-encoded, as Gmail's `raw` expects. */
export const buildRaw = async (m: OutgoingMessage): Promise<string> => {
  const headers: string[] = [];
  const add = (name: string, value?: string) => value && headers.push(`${name}: ${clean(value)}`);
  add("From", m.from);
  add("To", m.to?.join(", "));
  add("Cc", m.cc?.join(", "));
  add("Bcc", m.bcc?.join(", "));
  add("Reply-To", m.replyTo);
  add("Subject", m.subject && encodeWord(clean(m.subject)));
  add("In-Reply-To", m.inReplyTo);
  add("References", m.references);
  for (const [k, v] of Object.entries(m.headers ?? {})) add(clean(k).replace(/:/g, ""), v);
  headers.push("MIME-Version: 1.0");

  // Body: text | html | multipart/alternative(text, html)
  let body: string;
  if (m.text && m.html) {
    const alt = `----=_alt_${randomUUID()}`;
    body = [
      `Content-Type: multipart/alternative; boundary="${alt}"`,
      "",
      `--${alt}`,
      textPart("text/plain", m.text),
      `--${alt}`,
      textPart("text/html", m.html),
      `--${alt}--`,
    ].join("\r\n");
  } else {
    body = textPart(m.html ? "text/html" : "text/plain", m.html ?? m.text ?? "");
  }

  const attachments = await Promise.all((m.attachments ?? []).map(loadAttachment));
  if (attachments.length === 0) return toBase64Url([...headers, body].join("\r\n"));

  const mixed = `----=_mixed_${randomUUID()}`;
  const parts = [
    ...headers,
    `Content-Type: multipart/${attachments.some((a) => a.contentId) ? "related" : "mixed"}; boundary="${mixed}"`,
    "",
    `--${mixed}`,
    body,
  ];
  for (const a of attachments) {
    parts.push(
      `--${mixed}`,
      `Content-Type: ${a.mimeType}; name="${asciiName(a.filename).replace(/[^\x20-\x7E]/g, "_")}"`,
      `Content-Disposition: ${a.contentId ? "inline" : "attachment"}; ${filenameParams(a.filename)}`,
      "Content-Transfer-Encoding: base64",
      ...(a.contentId ? [`Content-ID: <${clean(a.contentId)}>`] : []),
      "",
      b64Lines(a.data)
    );
  }
  parts.push(`--${mixed}--`);
  return toBase64Url(parts.join("\r\n"));
};

const toBase64Url = (s: string): string => Buffer.from(s, "utf8").toString("base64url");

export interface ParsedAttachment {
  partId?: string;
  filename: string;
  mimeType: string;
  size: number;
  /** Pass to gmail_get_attachment. Absent when Gmail inlined the bytes into `data`. */
  attachmentId?: string;
  contentId?: string;
  /** Base64 bytes for parts Gmail returned inline. */
  data?: string;
}

export interface ParsedMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  internalDate?: string;
  sizeEstimate?: number;
  headers: Record<string, string>;
  subject?: string;
  from?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  date?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string;
  /** Full plain-text body, every text/plain part concatenated. Never truncated. */
  text?: string;
  /** Full HTML body, every text/html part concatenated. Never truncated. */
  html?: string;
  attachments: ParsedAttachment[];
}

const decode = (data: string, charset?: string): string => {
  const buf = Buffer.from(data, "base64url");
  try {
    return new TextDecoder(charset || "utf-8").decode(buf);
  } catch {
    return buf.toString("utf8");
  }
};

const charsetOf = (part: gmail_v1.Schema$MessagePart): string | undefined =>
  part.headers?.find((h) => h.name?.toLowerCase() === "content-type")?.value
    ?.match(/charset="?([^";\s]+)"?/i)?.[1];

/** Flatten a Gmail `format: full` message into headers, complete bodies, and attachments. */
export const parseMessage = (msg: gmail_v1.Schema$Message): ParsedMessage => {
  const headers: Record<string, string> = {};
  for (const h of msg.payload?.headers ?? []) if (h.name && h.value != null) headers[h.name] = h.value;
  const hdr = (name: string) =>
    Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1];

  const texts: string[] = [];
  const htmls: string[] = [];
  const attachments: ParsedAttachment[] = [];
  // Iterative walk: nesting depth comes from inbound mail, not from us.
  const stack: gmail_v1.Schema$MessagePart[] = msg.payload ? [msg.payload] : [];
  while (stack.length) {
    const part = stack.pop()!;
    const mime = (part.mimeType ?? "").toLowerCase();
    const data = part.body?.data ?? undefined;
    const disposition = part.headers?.find((h) => h.name?.toLowerCase() === "content-disposition")?.value ?? "";
    const isAttachment = Boolean(part.filename) || /^attachment/i.test(disposition) || Boolean(part.body?.attachmentId);
    if (isAttachment) {
      attachments.push({
        partId: part.partId ?? undefined,
        filename: part.filename || "attachment",
        mimeType: part.mimeType || "application/octet-stream",
        size: part.body?.size ?? 0,
        attachmentId: part.body?.attachmentId ?? undefined,
        contentId: part.headers?.find((h) => h.name?.toLowerCase() === "content-id")?.value?.replace(/^<|>$/g, ""),
        data: part.body?.attachmentId ? undefined : (data && Buffer.from(data, "base64url").toString("base64")),
      });
    } else if (data && mime !== "message/rfc822") {
      if (mime === "text/html") htmls.push(decode(data, charsetOf(part)));
      else if (!mime || mime.startsWith("text/")) texts.push(decode(data, charsetOf(part)));
    }
    const children = part.parts ?? [];
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }

  return {
    id: msg.id!,
    threadId: msg.threadId ?? undefined,
    labelIds: msg.labelIds ?? undefined,
    snippet: msg.snippet ?? undefined,
    historyId: msg.historyId ?? undefined,
    internalDate: msg.internalDate ?? undefined,
    sizeEstimate: msg.sizeEstimate ?? undefined,
    headers,
    subject: hdr("subject"),
    from: hdr("from"),
    to: hdr("to"),
    cc: hdr("cc"),
    bcc: hdr("bcc"),
    date: hdr("date"),
    messageId: hdr("message-id"),
    inReplyTo: hdr("in-reply-to"),
    references: hdr("references"),
    text: texts.length ? texts.join("\n") : undefined,
    html: htmls.length ? htmls.join("\n") : undefined,
    attachments,
  };
};
