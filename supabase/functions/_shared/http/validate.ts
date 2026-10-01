// JSON Schema validation using the schemas generated from openapi/openapi.yaml.
import { Ajv2020 as Ajv } from "ajv";
import apiSchemas from "../generated/api-schemas.json" with { type: "json" };
import aiSchemas from "../generated/ai-schemas.json" with { type: "json" };
import { ApiError } from "./errors.ts";

type Validator = ((data: unknown) => boolean) & { errors?: Array<{ instancePath: string; keyword: string; message?: string }> | null };

const ajv = new Ajv({
  allErrors: true,
  strict: false,
  formats: { "date-time": /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/ },
});
ajv.addSchema(apiSchemas as unknown as object);
for (const s of Object.values(aiSchemas as Record<string, object>)) ajv.addSchema(s);

const cache = new Map<string, Validator>();

function validatorFor(ref: string): Validator {
  let v = cache.get(ref);
  if (!v) {
    v = ajv.compile({ $ref: ref }) as unknown as Validator;
    cache.set(ref, v);
  }
  return v;
}

export interface FieldError {
  path: string;
  rule: string;
  message: string;
}

export function schemaErrors(ref: string, data: unknown): FieldError[] {
  const v = validatorFor(ref);
  if (v(data)) return [];
  return (v.errors ?? []).slice(0, 20).map((e) => ({
    path: e.instancePath || "/",
    rule: e.keyword,
    message: e.message ?? "invalid",
  }));
}

/** Validates a request body against #/components/schemas/<name>; throws VALIDATION_ERROR. */
export function validateBody<T>(schemaName: string, body: unknown): T {
  const errors = schemaErrors(`conime-api#/$defs/${schemaName}`, body);
  if (errors.length) throw new ApiError("VALIDATION_ERROR", { fields: errors });
  return body as T;
}

/** Validates an API response (contract tests). */
export function responseErrors(schemaName: string, body: unknown): FieldError[] {
  return schemaErrors(`conime-api#/$defs/${schemaName}`, body);
}

/** Validates AI output against schemas/ai/<id>.json. */
export function aiOutputErrors(schemaId: string, output: unknown): FieldError[] {
  return schemaErrors(schemaId, output);
}

export function aiSchema(schemaId: string): Record<string, unknown> {
  const s = (aiSchemas as Record<string, Record<string, unknown>>)[schemaId];
  if (!s) throw new Error(`unknown AI schema ${schemaId}`);
  const { $schema: _s, $id: _i, title: _t, ...rest } = s;
  return rest;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseUuidParam(name: string, value: string | undefined): string {
  if (!value || !UUID_RE.test(value)) {
    throw new ApiError("VALIDATION_ERROR", { fields: [{ path: `/${name}`, rule: "format", message: "must be a UUID" }] });
  }
  return value.toLowerCase();
}

export function parseIntParam(name: string, value: string | undefined, min: number, max: number): number | null {
  if (value === undefined || value === "") return null;
  if (!/^-?\d+$/.test(value)) {
    throw new ApiError("VALIDATION_ERROR", { fields: [{ path: `/${name}`, rule: "type", message: "must be an integer" }] });
  }
  const n = Number(value);
  if (n < min || n > max) {
    throw new ApiError("VALIDATION_ERROR", {
      fields: [{ path: `/${name}`, rule: "range", message: `must be between ${min} and ${max}` }],
    });
  }
  return n;
}

export function parseEnumParam<T extends string>(name: string, value: string | undefined, allowed: readonly T[]): T | null {
  if (value === undefined || value === "") return null;
  if (!allowed.includes(value as T)) {
    throw new ApiError("VALIDATION_ERROR", {
      fields: [{ path: `/${name}`, rule: "enum", message: `must be one of ${allowed.join(", ")}` }],
    });
  }
  return value as T;
}

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}
