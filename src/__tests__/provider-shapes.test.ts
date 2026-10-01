import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  buildAnthropicStyleMessages,
  buildStructuredToolParams,
  createAnthropicClient,
  createBedrockClient,
  createOllamaClient,
  createOpenAiCompatibleClient,
  Gateway,
  InMemoryCacheStore,
  InMemoryInflightLedger,
} from "../index.js";

const request = { operation: "shape", prompt: "hello", maxTokens: 99 };
const response = (body: string) =>
  new Response(body, {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("provider request shapes", () => {
  it("testDirectStructuredAutoToolSelectsToolChoice (adapted from test_direct_structured_auto_tool_selects_client)", async () => {
    const calls: any[] = [];
    const client = createAnthropicClient({
      model: "m",
      anthropicClient: {
        messages: {
          create: async (params: unknown) => {
            calls.push(params);
            return {
              content: [{ type: "tool_use", input: { name: "X" } }],
            };
          },
        },
      },
    });
    const schemaRequest = {
      ...request,
      schema: z.object({ name: z.string() }),
    };
    await client.complete(schemaRequest);
    await client.complete({ ...schemaRequest, autoTool: true });
    expect(calls[0].tool_choice).toEqual({
      type: "tool",
      name: "emit_structured_result",
    });
    expect(calls[0].system).toBeUndefined();
    expect(calls[1].tool_choice).toEqual({ type: "auto" });
    expect(calls[1].system).toContain("Return only the tool call");
    expect(calls[1].tools).toEqual(calls[0].tools);
  });

  it("testBuildAnthropicStyleMessagesIncludesImages", () => {
    expect(
      buildAnthropicStyleMessages({
        ...request,
        images: [{ data: "abc", mediaType: "image/png" }],
      })[0]?.content,
    ).toEqual([
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "abc" },
      },
      { type: "text", text: "hello" },
    ]);
  });

  it("testBuildAnthropicStyleMessagesAttachesDocumentsToFirstUser", () => {
    const messages = buildAnthropicStyleMessages({
      operation: "shape",
      messages: [
        { role: "assistant", content: "earlier" },
        { role: "user", content: "inspect" },
      ],
      images: [{ data: "pdf-data", mediaType: "application/pdf" }],
      maxTokens: 1,
    });
    expect(messages[1]?.content).toEqual([
      {
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: "pdf-data",
        },
      },
      { type: "text", text: "inspect" },
    ]);
  });

  it("testNonObjectRootSchemaWrapsAndUnwraps", async () => {
    const schema = z.array(z.object({ a: z.number() }));
    const client = createAnthropicClient({
      model: "m",
      anthropicClient: {
        messages: {
          create: async () => ({
            content: [
              {
                type: "tool_use",
                input: { result: [{ a: 1 }, { a: 2 }] },
              },
            ],
          }),
        },
      },
    });
    const schemaRequest = { ...request, schema };
    expect((await client.complete(schemaRequest)).text).toBe(
      JSON.stringify([{ a: 1 }, { a: 2 }]),
    );
    expect(
      (buildStructuredToolParams(schemaRequest).tools?.[0] as any).input_schema,
    ).toEqual({
      type: "object",
      properties: {
        result: {
          type: "array",
          items: {
            type: "object",
            properties: { a: { type: "number" } },
            additionalProperties: false,
            required: ["a"],
          },
        },
      },
      required: ["result"],
    });
    const gateway = new Gateway({
      provider: client,
      model: "m",
      store: new InMemoryCacheStore(),
      ledger: new InMemoryInflightLedger(),
    });
    expect((await gateway.complete(schemaRequest)).parsed).toEqual([
      { a: 1 },
      { a: 2 },
    ]);
  });

  it("testBuildAnthropicStyleMessagesPreservesConversation", () => {
    const messages = buildAnthropicStyleMessages({
      operation: "shape",
      messages: [
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
      ],
      maxTokens: 1,
    });
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
  });

  it("testDirectStructuredTemperatureIsOptionalAnthropic", async () => {
    const calls: any[] = [];
    const client = createAnthropicClient({
      model: "m",
      anthropicClient: {
        messages: {
          create: async (params: unknown) => {
            calls.push(params);
            return { content: [{ type: "text", text: "ok" }] };
          },
        },
      },
    });
    await client.complete(request);
    await client.complete({ ...request, temperature: 0.5 });
    expect(calls[0]).not.toHaveProperty("temperature");
    expect(calls[1].temperature).toBe(0.5);
  });

  it("testDirectStructuredTemperatureIsOptionalBedrock", async () => {
    const bodies: any[] = [];
    const client = createBedrockClient({
      modelArn: "arn",
      client: {
        send: async (command: any) => {
          bodies.push(JSON.parse(command.input.body));
          return {
            body: new TextEncoder().encode(
              '{"content":[{"type":"text","text":"ok"}]}',
            ),
          };
        },
      },
    });
    await client.complete(request);
    await client.complete({ ...request, temperature: 0.25 });
    expect(bodies[0]).not.toHaveProperty("temperature");
    expect(bodies[1].temperature).toBe(0.25);
  });

  it("testDirectStructuredTemperatureIsOptionalOllama", async () => {
    const bodies: any[] = [];
    const client = createOllamaClient({
      model: "m",
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(String(init.body)));
        return response('{"message":{"content":"ok"}}');
      },
    });
    await client.complete(request);
    await client.complete({ ...request, temperature: 0.75 });
    expect(bodies[0].options).not.toHaveProperty("temperature");
    expect(bodies[1].options.temperature).toBe(0.75);
  });

  it("testDirectStructuredTemperatureIsOptionalOpenAiCompatible", async () => {
    const bodies: any[] = [];
    const client = createOpenAiCompatibleClient({
      baseUrl: "https://example.test",
      apiKey: "key",
      model: "m",
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(String(init.body)));
        return response('{"choices":[{"message":{"content":"ok"}}]}');
      },
    });
    await client.complete(request);
    await client.complete({ ...request, temperature: 0.1 });
    expect(bodies[0]).not.toHaveProperty("temperature");
    expect(bodies[1].temperature).toBe(0.1);
  });

  it("testOpenAiResponseFormatOnlyWithSchemaAndImagesUseDataUri", async () => {
    const bodies: any[] = [];
    const client = createOpenAiCompatibleClient({
      baseUrl: "https://example.test",
      apiKey: "key",
      model: "m",
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(String(init.body)));
        return response('{"choices":[{"message":{"content":"ok"}}]}');
      },
    });
    await client.complete(request);
    await client.complete({
      ...request,
      schema: z.object({ answer: z.string() }),
      images: [{ data: "abc", mediaType: "image/png" }],
    });
    expect(bodies[0]).not.toHaveProperty("response_format");
    expect(
      bodies[1].response_format.json_schema.schema.properties.answer,
    ).toEqual({ type: "string" });
    expect(bodies[1].messages[0].content[1].image_url.url).toBe(
      "data:image/png;base64,abc",
    );
  });

  it("testOllamaSystemAndImagesShape", async () => {
    let body: any;
    const client = createOllamaClient({
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init.body));
        return response('{"message":{"content":"ok"}}');
      },
    });
    await client.complete({
      ...request,
      system: "system",
      images: [{ data: "raw-base64", mediaType: "image/png" }],
    });
    expect(body.messages[0]).toEqual({ role: "system", content: "system" });
    expect(body.messages[1].images).toEqual(["raw-base64"]);
  });
});
