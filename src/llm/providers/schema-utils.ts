import type { ToolParameterProperty } from "../types.js";

const GEMINI_SUPPORTED_SCHEMA_KEYS = new Set([
  "type",
  "properties",
  "required",
  "items",
  "enum",
  "description",
  "nullable"
]);

export function closeObjectSchemasForOpenAI(
  schema: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...schema };

  if (typeof out.type === "string") {
    const lowerType = out.type.toLowerCase();
    if (
      lowerType === "object" ||
      lowerType === "string" ||
      lowerType === "number" ||
      lowerType === "integer" ||
      lowerType === "boolean" ||
      lowerType === "array"
    ) {
      out.type = lowerType;
    }
  }

  const hasProperties =
    out.properties !== undefined &&
    out.properties !== null &&
    typeof out.properties === "object" &&
    !Array.isArray(out.properties);

  if (hasProperties) {
    const rawProps = out.properties as Record<string, unknown>;
    const closedProps: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(rawProps)) {
      closedProps[key] =
        val !== null && typeof val === "object" && !Array.isArray(val)
          ? closeObjectSchemasForOpenAI(val as Record<string, unknown>)
          : val;
    }
    out.properties = closedProps;
  }

  const isObjectSchema = out.type === "object" || hasProperties;
  if (isObjectSchema) {
    out.additionalProperties = false;
    if (Array.isArray(out.required)) {
      out.required = [...out.required];
    } else if (hasProperties) {
      out.required = Object.keys(out.properties as Record<string, unknown>);
    } else {
      out.required = [];
    }
  }

  if (
    out.items !== undefined &&
    out.items !== null &&
    typeof out.items === "object"
  ) {
    if (Array.isArray(out.items)) {
      out.items = out.items.map((item) =>
        item !== null && typeof item === "object" && !Array.isArray(item)
          ? closeObjectSchemasForOpenAI(item as Record<string, unknown>)
          : item
      );
    } else {
      out.items = closeObjectSchemasForOpenAI(
        out.items as Record<string, unknown>
      );
    }
  }

  for (const combinator of ["anyOf", "oneOf", "allOf"] as const) {
    if (Array.isArray(out[combinator])) {
      out[combinator] = (out[combinator] as unknown[]).map((sub) =>
        sub !== null && typeof sub === "object" && !Array.isArray(sub)
          ? closeObjectSchemasForOpenAI(sub as Record<string, unknown>)
          : sub
      );
    }
  }

  for (const defsKey of ["$defs", "definitions"] as const) {
    if (
      out[defsKey] !== undefined &&
      out[defsKey] !== null &&
      typeof out[defsKey] === "object" &&
      !Array.isArray(out[defsKey])
    ) {
      const rawDefs = out[defsKey] as Record<string, unknown>;
      const closedDefs: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rawDefs)) {
        closedDefs[k] =
          v !== null && typeof v === "object" && !Array.isArray(v)
            ? closeObjectSchemasForOpenAI(v as Record<string, unknown>)
            : v;
      }
      out[defsKey] = closedDefs;
    }
  }

  return out;
}

export function sanitizeSchemaForGemini(
  schema: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [key, val] of Object.entries(schema)) {
    if (!GEMINI_SUPPORTED_SCHEMA_KEYS.has(key) || val === undefined) {
      continue;
    }

    if (
      key === "properties" &&
      val !== null &&
      typeof val === "object" &&
      !Array.isArray(val)
    ) {
      const sanitizedProps: Record<string, unknown> = {};
      for (const [propKey, propVal] of Object.entries(
        val as Record<string, unknown>
      )) {
        sanitizedProps[propKey] =
          propVal !== null &&
          typeof propVal === "object" &&
          !Array.isArray(propVal)
            ? sanitizeSchemaForGemini(propVal as Record<string, unknown>)
            : propVal;
      }
      out.properties = sanitizedProps;
      continue;
    }

    if (
      key === "items" &&
      val !== null &&
      typeof val === "object" &&
      !Array.isArray(val)
    ) {
      out.items = sanitizeSchemaForGemini(val as Record<string, unknown>);
      continue;
    }

    if (key === "required" && Array.isArray(val)) {
      out.required = [...val];
      continue;
    }

    if (key === "enum" && Array.isArray(val)) {
      out.enum = [...val];
      continue;
    }

    out[key] = val;
  }

  return out;
}

export function normalizeToolParametersForJsonSchema(
  param?: ToolParameterProperty | undefined
): Record<string, unknown> {
  if (!param) {
    return {
      type: "object",
      properties: {}
    };
  }

  const out: Record<string, unknown> = {
    type: param.type.toLowerCase()
  };

  if (param.description !== undefined) {
    out.description = param.description;
  }

  if (param.properties) {
    const normalizedProps: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(param.properties)) {
      normalizedProps[k] = normalizeToolParametersForJsonSchema(v);
    }
    out.properties = normalizedProps;
  } else if (out.type === "object") {
    out.properties = {};
  }

  if (param.required && param.required.length > 0) {
    out.required = [...param.required];
  }

  if (param.items) {
    out.items = normalizeToolParametersForJsonSchema(param.items);
  }

  if (param.enum && param.enum.length > 0) {
    out.enum = [...param.enum];
  }

  return out;
}
