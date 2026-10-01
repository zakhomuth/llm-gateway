import { describe, it, expect } from "vitest";
import { z } from "zod";
import { zodShape } from "../key.js";
describe("zodShape", () => {
  it("testZodShapeCoversCompositeTypes", () => {
    const schema = z.object({
      kind: z.union([z.literal("a"), z.literal("b")]),
      amount: z.number().int().describe("cents"),
      tags: z.array(z.string()).default([]),
      meta: z.record(z.string()),
      when: z.string().refine((v) => v.length > 0),
      note: z.string().nullish(),
      anything: z.unknown(),
      items: z.array(z.object({ q: z.number() })).describe("line items"),
    });
    const shape = zodShape(schema) as any;
    expect(shape.properties.kind).toEqual({ anyOf: [{ const: "a" }, { const: "b" }] });
    expect(shape.properties.amount).toEqual({ type: "integer", description: "cents" });
    expect(shape.properties.tags).toEqual({ type: "array", items: { type: "string" } });
    expect(shape.properties.meta).toEqual({ type: "object", additionalProperties: { type: "string" } });
    expect(shape.properties.when).toEqual({ type: "string" });
    expect(shape.properties.note).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] });
    expect(shape.properties.anything).toEqual({});
    expect(shape.properties.items.description).toBe("line items");
    expect(shape.required).toEqual(["kind", "amount", "meta", "when", "items"]);
    expect(JSON.stringify(shape)).not.toMatch(/"type":"(union|default|effects|record|unknown|any)"/);
  });
  it("testZodShapeDiscriminatedUnion", () => {
    const s = z.discriminatedUnion("t", [z.object({ t: z.literal("x") }), z.object({ t: z.literal("y"), n: z.number() })]);
    expect((zodShape(s) as any).anyOf).toHaveLength(2);
  });
});

import { logSafe } from "../logger.js";
describe("logSafe", () => {
  it("testLogSafeTruncatesBase64KeepsPrompt", () => {
    const big = "A".repeat(20_000);
    const out = logSafe({ messages: [{ content: [{ source: { data: big } }, { text: "the prompt" }] }] }) as any;
    expect(out.messages[0].content[0].source.data).toMatch(/^A{200}…\[20000 chars truncated\]$/);
    expect(out.messages[0].content[1].text).toBe("the prompt");
  });
});
