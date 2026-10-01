import { describe, expect, it } from "vitest";
import {
  createAnthropicClient,
  createBedrockClient,
  Gateway,
  InMemoryCacheStore,
  InMemoryInflightLedger,
} from "../index.js";

const request = { operation: "too-long", prompt: "P", maxTokens: 10 };
const gatewayFor = (provider: ReturnType<typeof createAnthropicClient>) =>
  new Gateway({
    provider,
    model: "m",
    store: new InMemoryCacheStore(),
    ledger: new InMemoryInflightLedger(),
    transportRetryBound: 0,
  });

describe("provider error passthrough", () => {
  it("testAnthropicErrorMessagePassesThroughGateway", async () => {
    const error = new Error("Input is too long for requested model.");
    const provider = createAnthropicClient({
      model: "m",
      anthropicClient: {
        messages: { create: async () => Promise.reject(error) },
      },
    });
    await expect(gatewayFor(provider).complete(request)).rejects.toBe(error);
  });

  it("testBedrockErrorMessagePassesThroughGateway", async () => {
    const error = new Error(
      "ValidationException: Input is too long for requested model.",
    );
    const provider = createBedrockClient({
      modelArn: "arn",
      client: { send: async () => Promise.reject(error) },
    });
    await expect(gatewayFor(provider).complete(request)).rejects.toBe(error);
  });
});
