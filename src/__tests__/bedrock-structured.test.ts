import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { createBedrockClient, Gateway, InMemoryCacheStore, InMemoryInflightLedger } from "../index.js";
const quiet = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
function fakeBedrock(content: unknown[]) {
  const bodies: any[] = [];
  const client = {
    send: vi.fn(async (cmd: any) => {
      bodies.push(JSON.parse(cmd.input.body));
      return {
        body: new TextEncoder().encode(
          JSON.stringify({ content, usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: "tool_use" }),
        ),
      };
    }),
  };
  return { client, bodies };
}
describe("bedrock structured output", () => {
  it("testBedrockSchemaSendsForcedToolAndReadsToolInput", async () => {
    const { client, bodies } = fakeBedrock([
      { type: "text", text: "Here you go" },
      { type: "tool_use", name: "emit_structured_result", input: { pick: 2 } },
    ]);
    const provider = createBedrockClient({ modelArn: "arn:test", client, logger: quiet });
    const g = new Gateway({ provider, model: "arn:test", store: new InMemoryCacheStore(), ledger: new InMemoryInflightLedger(), logger: quiet });
    const r = await g.complete({ operation: "pick", prompt: "P", system: "S", schema: z.object({ pick: z.number() }), maxTokens: 64 });
    expect(r.parsed).toEqual({ pick: 2 });
    expect(bodies[0].tool_choice).toEqual({ type: "tool", name: "emit_structured_result" });
    expect(bodies[0].tools[0].input_schema.type).toBe("object");
    expect(bodies[0]).not.toHaveProperty("system");
    expect(JSON.stringify(bodies[0].messages)).toContain("S");
  });
  it("testBedrockArrayRootSchemaUnwraps", async () => {
    const { client, bodies } = fakeBedrock([
      { type: "tool_use", name: "emit_structured_result", input: { result: [{ a: 1 }, { a: 2 }] } },
    ]);
    const provider = createBedrockClient({ modelArn: "arn:test", client, logger: quiet });
    const g = new Gateway({ provider, model: "arn:test", store: new InMemoryCacheStore(), ledger: new InMemoryInflightLedger(), logger: quiet });
    const r = await g.complete({ operation: "merge", prompt: "P", schema: z.array(z.object({ a: z.number() })), maxTokens: 64 });
    expect(r.parsed).toEqual([{ a: 1 }, { a: 2 }]);
    expect(bodies[0].tools[0].input_schema.required).toEqual(["result"]);
  });
  it("testBedrockPlainRequestSendsNoTools", async () => {
    const { client, bodies } = fakeBedrock([{ type: "text", text: "Y" }]);
    const provider = createBedrockClient({ modelArn: "arn:test", client, logger: quiet });
    const g = new Gateway({ provider, model: "arn:test", store: new InMemoryCacheStore(), ledger: new InMemoryInflightLedger(), logger: quiet });
    expect((await g.complete({ operation: "dedup", prompt: "P", maxTokens: 10 })).text).toBe("Y");
    expect(bodies[0]).not.toHaveProperty("tools");
  });
});
