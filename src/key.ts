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
  const shape = zodShapeBare(schema);
  // .describe() text guides the model for every type, not only strings.
  return def.description && shape && typeof shape === "object"
    ? { ...(shape as object), description: def.description }
    : shape;
}

function zodShapeBare(schema: ZodTypeAny): unknown {
  const def = schema._def as Record<string, any>;
  const type = def.typeName as string;
  const inner = (s: unknown) => zodShape(s as ZodTypeAny);
  if (type === "ZodObject") {
    const raw = typeof def.shape === "function" ? def.shape() : def.shape;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, child] of Object.entries(
      raw as Record<string, ZodTypeAny>,
    )) {
      properties[key] = zodShape(child);
      if (!child.isOptional()) required.push(key);
    }
    return {
      type: "object",
      properties,
      additionalProperties: false,
      ...(required.length ? { required } : {}),
    };
  }
  if (type === "ZodString" || type === "ZodDate") return { type: "string" };
  if (type === "ZodNumber")
    return {
      type: (def.checks as Array<{ kind: string }> | undefined)?.some(
        (c) => c.kind === "int",
      )
        ? "integer"
        : "number",
    };
  if (type === "ZodBigInt") return { type: "integer" };
  if (type === "ZodBoolean") return { type: "boolean" };
  if (type === "ZodNull") return { type: "null" };
  if (type === "ZodArray") return { type: "array", items: inner(def.type) };
  if (type === "ZodTuple")
    return { type: "array", items: { anyOf: (def.items as unknown[]).map(inner) } };
  if (type === "ZodSet") return { type: "array", items: inner(def.valueType) };
  if (type === "ZodRecord" || type === "ZodMap")
    return { type: "object", additionalProperties: inner(def.valueType) };
  if (type === "ZodEnum") return { type: "string", enum: def.values };
  if (type === "ZodNativeEnum")
    return {
      enum: [
        ...new Set(
          Object.values(def.values).filter((v) => typeof v === "string"),
        ),
      ],
    };
  if (type === "ZodUnion" || type === "ZodDiscriminatedUnion")
    return {
      anyOf: [...(def.options as Iterable<unknown>)].map(inner),
    };
  if (type === "ZodIntersection")
    return { allOf: [inner(def.left), inner(def.right)] };
  if (type === "ZodNullable")
    return { anyOf: [inner(def.innerType), { type: "null" }] };
  if (type === "ZodLiteral") return { const: def.value };
  // Wrappers: the JSON shape is the wrapped schema's.
  if (
    type === "ZodOptional" ||
    type === "ZodDefault" ||
    type === "ZodCatch" ||
    type === "ZodReadonly" ||
    type === "ZodBranded"
  )
    return inner(def.innerType ?? def.type);
  if (type === "ZodEffects") return inner(def.schema);
  if (type === "ZodLazy") return inner(def.getter());
  if (type === "ZodPipeline") return inner(def.in);
  // ZodAny / ZodUnknown and anything else: accept any JSON value.
  return {};
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
