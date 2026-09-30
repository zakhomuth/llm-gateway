import { mkdtemp, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { cacheable, FileCacheStore, requestKey } from "../index.js";
// SKIPPED: test_text_key_ignores_system_and_schema — unified keys always include system/schema.
// SKIPPED: test_batch_params_text_uses_web_search — generic batches have no research web-search tools.
// SKIPPED: test_batch_params_normalize_cli_model_alias — this package has no CLI alias layer.
// SKIPPED: test_text_kind_reproduces_legacy_responses_keys — this package has no legacy text-kind layout.
const req = (extra: Record<string, unknown> = {}) => ({
  operation: "op",
  prompt: "P",
  maxTokens: 10,
  ...extra,
});
describe("key and gate ports", () => {
  it("testAutoToolIsPartOfStructuredCacheKey", () => {
    expect(requestKey(req({ autoTool: true }), "p", "m")).not.toBe(
      requestKey(req(), "p", "m"),
    );
  });

  it("testKeyPerturbsOnEachStructuredAxis and testStructuredKeyPerturbedByEveryPart", () => {
    const s = z.object({ x: z.string() }),
      base = requestKey(req({ system: "a", schema: s }), "p", "m");
    expect(requestKey(req({ system: "a", schema: s }), "q", "m")).not.toBe(
      base,
    );
    expect(requestKey(req({ system: "a", schema: s }), "p", "n")).not.toBe(
      base,
    );
    expect(requestKey(req({ system: "b", schema: s }), "p", "m")).not.toBe(
      base,
    );
    expect(
      requestKey(
        req({ system: "a", schema: z.object({ y: z.number() }) }),
        "p",
        "m",
      ),
    ).not.toBe(base);
    expect(
      requestKey(req({ system: "a", schema: s, prompt: "Q" }), "p", "m"),
    ).not.toBe(base);
  });
  it("testTextKindPreservesLegacyKey adapted: operation is ignored", () =>
    expect(requestKey(req(), "p", "m")).toBe(
      requestKey(req({ operation: "other" }), "p", "m"),
    ));
  it("sample zero preserves base and positive samples differ", () => {
    expect(requestKey(req({ sample: 0 }), "p", "m")).toBe(
      requestKey(req(), "p", "m"),
    );
    expect(requestKey(req({ sample: 1 }), "p", "m")).not.toBe(
      requestKey(req(), "p", "m"),
    );
  });
  it("temperature is part of key", () =>
    expect(requestKey(req({ temperature: 0.7 }), "p", "m")).not.toBe(
      requestKey(req(), "p", "m"),
    ));
  it("testCacheableGate", () => {
    expect(cacheable(req(), { text: " " }).ok).toBe(false);
    expect(cacheable(req(), { text: "Credit balance is too low" }).ok).toBe(
      false,
    );
    expect(cacheable(req(), { text: "ok" }).ok).toBe(true);
  });
  it("testCacheableStructuredValidatesAgainstTheResponseModel", () => {
    const r = req({ schema: z.object({ x: z.string() }) });
    expect(cacheable(r, { text: '{"x":"yes"}' }).parsed).toEqual({ x: "yes" });
    expect(cacheable(r, { text: '{"x":2}' }).ok).toBe(false);
    expect(cacheable(r, { text: "bad" }).ok).toBe(false);
  });
});
describe("file store ports", () => {
  it("round trips full prompt and leaves no temp files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-store-"));
    const store = new FileCacheStore(root);
    const prompt = "p".repeat(500);
    await store.put("k", { text: "answer", prompt, meta: { a: 1 } });
    expect(await store.get("k")).toMatchObject({
      text: "answer",
      prompt,
      meta: { a: 1 },
    });
    expect((await readdir(root)).some((n) => n.includes(".tmp-"))).toBe(false);
    expect(
      JSON.parse(await readFile(path.join(root, "k.json"), "utf8")).prompt,
    ).toBe(prompt);
  });
});
