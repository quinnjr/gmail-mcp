import { describe, expect, it } from "vitest";
import { buildRaw, parseMessage } from "./mime.js";

const b64u = (s: string) => Buffer.from(s).toString("base64url");

describe("buildRaw", () => {
  it("emits multipart/mixed with text+html alternative and a named attachment", async () => {
    const raw = Buffer.from(
      await buildRaw({
        to: ["a@example.com"],
        subject: "Héllo\r\nX-Injected: yes",
        text: "hi",
        html: "<b>hi</b>",
        attachments: [{ data: Buffer.from("PDFDATA").toString("base64"), filename: "r.pdf" }],
      }),
      "base64url"
    ).toString();
    expect(raw).toMatch(/^To: a@example\.com\r\n/m);
    expect(raw).toContain("Subject: =?UTF-8?B?");
    expect(raw).not.toContain("X-Injected: yes\r\n");
    expect(raw).toContain("Content-Type: multipart/mixed;");
    expect(raw).toContain("Content-Type: multipart/alternative;");
    expect(raw).toContain('Content-Type: application/pdf; name="r.pdf"');
    expect(raw).toContain(Buffer.from("PDFDATA").toString("base64"));
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
          { mimeType: "image/png", filename: "i.png", body: { data: b64u("PNG"), size: 3 } },
        ],
      },
    });
    expect(parsed.subject).toBe("S");
    expect(parsed.text).toBe("part one\npart two");
    expect(parsed.html?.length).toBe(big.length + 7);
    expect(parsed.attachments).toEqual([
      expect.objectContaining({ filename: "a.pdf", attachmentId: "att1", size: 5 }),
      expect.objectContaining({ filename: "i.png", data: Buffer.from("PNG").toString("base64") }),
    ]);
  });
});
