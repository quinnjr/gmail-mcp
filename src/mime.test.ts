import { describe, expect, it } from "vitest";
import { b64Lines, buildRaw, parseMessage } from "./mime.js";

const b64u = (s: string | Buffer) => Buffer.from(s).toString("base64url");
const decodeRaw = async (m: Parameters<typeof buildRaw>[0]) =>
  Buffer.from(await buildRaw(m), "base64url").toString("latin1");

describe("buildRaw", () => {
  it("emits multipart/mixed with text+html alternative and a named attachment", async () => {
    const raw = await decodeRaw({
      to: ["a@example.com"],
      subject: "Héllo\r\nX-Injected: yes",
      text: "hi",
      html: "<b>hi</b>",
      attachments: [{ data: Buffer.from("PDFDATA").toString("base64"), filename: "r.pdf" }],
    });
    expect(raw).toMatch(/^To: a@example\.com\r\n/m);
    expect(raw).toContain("Subject: =?UTF-8?B?");
    expect(raw).not.toContain("X-Injected: yes\r\n");
    expect(raw).toContain("Content-Type: multipart/mixed;");
    expect(raw).toContain("Content-Type: multipart/alternative;");
    expect(raw).toContain('Content-Type: application/pdf; name="r.pdf"');
    expect(raw).toContain(Buffer.from("PDFDATA").toString("base64"));
  });

  it("strips CRLF from every header path, not only Subject", async () => {
    const raw = await decodeRaw({
      to: ["a@example.com\r\nBcc: evil@example.com"],
      headers: { "X-Custom": "ok\r\nBcc: evil@example.com" },
      text: "x",
    });
    expect(raw.match(/^Bcc:/gm)).toBeNull();
    expect(raw).toContain("To: a@example.com Bcc: evil@example.com\r\n");
    expect(raw).toContain("X-Custom: ok Bcc: evil@example.com\r\n");
  });

  it("rejects an attachment mimeType that is not a type/subtype token", async () => {
    await expect(
      buildRaw({ text: "x", attachments: [{ data: "AA==", filename: "a.bin", mimeType: "application/pdf\r\nX-Injected: 1" }] })
    ).rejects.toThrow(/mimeType/);
  });

  it("uses multipart/related with inline disposition and Content-ID for cid attachments", async () => {
    const raw = await decodeRaw({
      html: '<img src="cid:logo">',
      attachments: [{ data: b64u("PNG"), filename: "logo.png", contentId: "logo" }],
    });
    expect(raw).toContain("Content-Type: multipart/related;");
    expect(raw).toContain("Content-Disposition: inline;");
    expect(raw).toContain("Content-ID: <logo>\r\n");
  });

  it("nests related (body + cid parts) inside mixed when both kinds of attachment are present", async () => {
    const raw = await decodeRaw({
      html: '<img src="cid:logo">',
      attachments: [
        { data: b64u("PNG"), filename: "logo.png", contentId: "logo" },
        { data: b64u("PDF"), filename: "doc.pdf" },
      ],
    });
    const mixedAt = raw.indexOf("Content-Type: multipart/mixed;");
    const relatedAt = raw.indexOf("Content-Type: multipart/related;");
    const pdfAt = raw.indexOf('name="doc.pdf"');
    const relatedEnd = raw.indexOf(`--${raw.match(/multipart\/related; boundary="([^"]+)"/)![1]}--`);
    expect(mixedAt).toBeGreaterThan(-1);
    expect(relatedAt).toBeGreaterThan(mixedAt);
    expect(raw.indexOf("Content-ID: <logo>")).toBeLessThan(relatedEnd);
    expect(pdfAt).toBeGreaterThan(relatedEnd);
  });

  it("emits an ASCII filename plus RFC 2231 filename* for non-ASCII names", async () => {
    const raw = await decodeRaw({ text: "x", attachments: [{ data: "AA==", filename: "résumé.pdf" }] });
    expect(raw).toContain('name="r_sum_.pdf"');
    expect(raw).toContain(`filename="r_sum_.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf`);
  });

  it("wraps base64 at 76 columns with CRLF and no trailing break", () => {
    const wrapped = b64Lines(Buffer.alloc(300, 1));
    const lines = wrapped.split("\r\n");
    expect(lines.every((l) => l.length <= 76 && l.length > 0)).toBe(true);
    expect(lines.slice(0, -1).every((l) => l.length === 76)).toBe(true);
    expect(Buffer.from(wrapped.replace(/\r\n/g, ""), "base64")).toEqual(Buffer.alloc(300, 1));
  });
});

describe("parseMessage", () => {
  it("collects every nested text part, html, and attachments without truncation", () => {
    const big = "x".repeat(200_000);
    const parsed = parseMessage({
      id: "1",
      payload: {
        mimeType: "multipart/mixed",
        headers: [{ name: "Subject", value: "S" }, { name: "From", value: "f@x" }],
        parts: [
          {
            mimeType: "multipart/alternative",
            parts: [
              { mimeType: "text/plain", body: { data: b64u("part one") } },
              { mimeType: "text/html", body: { data: b64u("<p>" + big + "</p>") } },
            ],
          },
          { mimeType: "text/plain", body: { data: b64u("part two") } },
          { mimeType: "application/pdf", filename: "a.pdf", body: { attachmentId: "att1", size: 5 } },
          { mimeType: "image/png", filename: "i.png", headers: [{ name: "Content-ID", value: "<img1>" }], body: { data: b64u("PNG"), size: 3 } },
        ],
      },
    });
    expect(parsed.subject).toBe("S");
    expect(parsed.text).toBe("part one\npart two");
    expect(parsed.html).toBe("<p>" + big + "</p>");
    expect(parsed.decodeWarnings).toBeUndefined();
    expect(parsed.attachments).toEqual([
      expect.objectContaining({ filename: "a.pdf", attachmentId: "att1", size: 5 }),
      expect.objectContaining({ filename: "i.png", contentId: "img1", data: Buffer.from("PNG").toString("base64") }),
    ]);
  });

  it("keeps unnamed non-text parts as attachments instead of dropping them", () => {
    const parsed = parseMessage({
      id: "2",
      payload: {
        mimeType: "multipart/signed",
        parts: [
          { mimeType: "text/plain", body: { data: b64u("signed body") } },
          { mimeType: "application/pgp-signature", body: { data: b64u("SIG"), size: 3 } },
        ],
      },
    });
    expect(parsed.text).toBe("signed body");
    expect(parsed.attachments).toEqual([
      expect.objectContaining({ filename: "attachment", mimeType: "application/pgp-signature", data: b64u("SIG").replace(/-/g, "+") }),
    ]);
  });

  it("keeps an inline message/rfc822 part as a .eml attachment", () => {
    const parsed = parseMessage({
      id: "4",
      payload: {
        mimeType: "multipart/mixed",
        parts: [
          { mimeType: "text/plain", body: { data: b64u("fwd") } },
          { mimeType: "message/rfc822", body: { data: b64u("Subject: inner\r\n\r\nbody"), size: 22 } },
        ],
      },
    });
    expect(parsed.text).toBe("fwd");
    expect(parsed.attachments).toEqual([expect.objectContaining({ filename: "message.eml", mimeType: "message/rfc822" })]);
  });

  it("honours the part charset and flags charsets TextDecoder rejects", () => {
    const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9]); // "café" in ISO-8859-1
    const parsed = parseMessage({
      id: "3",
      payload: {
        mimeType: "multipart/alternative",
        parts: [
          { mimeType: "text/plain", headers: [{ name: "Content-Type", value: 'text/plain; charset="ISO-8859-1"' }], body: { data: b64u(latin1) } },
          { mimeType: "text/html", headers: [{ name: "Content-Type", value: "text/html; charset=bogus-1" }], body: { data: b64u("<p>ok</p>") } },
        ],
      },
    });
    expect(parsed.text).toBe("café");
    expect(parsed.html).toBe("<p>ok</p>");
    expect(parsed.decodeWarnings).toEqual([expect.stringContaining("bogus-1")]);
  });
});
