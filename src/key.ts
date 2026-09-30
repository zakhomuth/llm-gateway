import { createHash } from "node:crypto";
import type { ZodTypeAny } from "zod";
import type { LlmRequest } from "./types.js";

export function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(object[k])}`)
    .join(",")}}`;
}

export function zodShape(schema: ZodTypeAny): unknown {
  const def = schema._def as Record<string, any>;
  const type = def.typeName as string;
  if (type === "ZodObject") {
    const raw = typeof def.shape === "function" ? def.shape() : def.shape;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, child] of Object.entries(
      raw as Record<string, ZodTypeAny>,
    )) {
      properties[key] = zodShape(child);
      if ((child._def as Record<string, unknown>).typeName !== "ZodOptional")
        required.push(key);
    }
    return {
      type: "object",
      properties,
      additionalProperties: false,
      ...(required.length ? { required } : {}),
    };
  }
  if (type === "ZodString")
    return {
      type: "string",
      ...(def.description ? { description: def.description } : {}),
    };
  if (type === "ZodNumber") return { type: "number" };
  if (type === "ZodBoolean") return { type: "boolean" };
  if (type === "ZodArray")
    return { type: "array", items: zodShape(def.type as ZodTypeAny) };
  if (type === "ZodEnum") return { type: "string", enum: def.values };
  if (type === "ZodNativeEnum")
    return {
      enum: [
        ...new Set(
          Object.values(def.values).filter((v) => typeof v === "string"),
        ),
      ],
    };
  if (type === "ZodOptional") return zodShape(def.innerType as ZodTypeAny);
  if (type === "ZodNullable")
    return { anyOf: [zodShape(def.innerType as ZodTypeAny), { type: "null" }] };
  if (type === "ZodLiteral") return { const: def.value };
  return { type: type.replace(/^Zod/, "").toLowerCase() };
}

const sha = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");
export function requestKey(
  req: LlmRequest,
  provider: string,
  model: string,
): string {
  const content =
    req.prompt !== undefined ? req.prompt : JSON.stringify(req.messages);
  const images = req.images?.map((image) => sha(image.data)).join(",") ?? "";
  const schema = req.schema ? stableStringify(zodShape(req.schema)) : "";
  const base = sha(
    [
      provider,
      model,
      req.system ?? "",
      schema,
      content ?? "",
      images,
      req.temperature !== undefined ? String(req.temperature) : "",
      String(req.maxTokens),
    ].join("\0"),
  );
  let key = base;
  if (req.autoTool) key = sha(`${key}\0autoTool=true`);
  if (req.sample && req.sample > 0) key = sha(`${key}\0sample=${req.sample}`);
  return key;
}
