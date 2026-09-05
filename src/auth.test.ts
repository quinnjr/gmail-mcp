import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadTokens } from "./auth.js";

const client = () => {
  const calls: unknown[] = [];
  return { calls, setCredentials: (c: unknown) => void calls.push(c) };
};

describe("loadTokens", () => {
  it("prefers the first path, falls back to the seed, and reports when neither exists", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gmail-mcp-"));
    const own = path.join(dir, "own.json");
    const seed = path.join(dir, "seed.json");
    await writeFile(seed, JSON.stringify({ refresh_token: "seed" }));

    const c1 = client();
    expect(await loadTokens(c1, [own, seed])).toBe(true);
    expect(c1.calls).toEqual([{ refresh_token: "seed" }]);

    await writeFile(own, JSON.stringify({ refresh_token: "own" }));
    const c2 = client();
    expect(await loadTokens(c2, [own, seed])).toBe(true);
    expect(c2.calls).toEqual([{ refresh_token: "own" }]);

    const c3 = client();
    expect(await loadTokens(c3, [path.join(dir, "missing.json")])).toBe(false);
    expect(c3.calls).toEqual([]);
  });

  it("rethrows anything other than a missing file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gmail-mcp-"));
    const bad = path.join(dir, "bad.json");
    await writeFile(bad, "{not json");
    await expect(loadTokens(client(), [bad])).rejects.toThrow(SyntaxError);
  });
});
