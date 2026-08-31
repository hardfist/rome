import { Ajv, type ValidateFunction, type ErrorObject } from "ajv";

export interface CompiledOutputSchema {
  validate: ValidateFunction;
}

const ajv = new Ajv({ allErrors: true, strict: false });

const ALLOWED_TYPES = new Set([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
]);
const ALLOWED_KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "description",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
]);
const MAX_SCHEMA_DEPTH = 10;
const MAX_SCHEMA_PROPERTIES = 5_000;
const MAX_ENUM_VALUES = 1_000;
const MAX_SCHEMA_CHARACTERS = 120_000;

export class PortableOutputSchemaError extends Error {
  constructor(readonly issues: string[]) {
    super(`outputSchema is not portable-v1:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
    this.name = "PortableOutputSchemaError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pathProperty(path: string, key: string): string {
  return `${path}.properties[${JSON.stringify(key)}]`;
}

/**
 * Validate Rome's portable-v1 provider-output profile. This is the lossless
 * intersection sent unchanged to Claude Agent SDK and Codex app-server.
 */
export function validatePortableOutputSchema(schema: unknown): string[] {
  const issues: string[] = [];
  let propertyCount = 0;
  let enumValueCount = 0;
  let constrainedCharacterCount = 0;

  try {
    if (JSON.stringify(schema) === undefined) return ["$ must be JSON-serializable"];
  } catch {
    return ["$ must be JSON-serializable"];
  }

  const valueCharacterCount = (value: unknown): number => {
    if (typeof value === "string") return value.length;
    return JSON.stringify(value)?.length ?? 0;
  };

  const visit = (node: unknown, path: string, depth: number, root: boolean): void => {
    if (!isRecord(node)) {
      issues.push(`${path} must be a schema object`);
      return;
    }
    if (depth > MAX_SCHEMA_DEPTH) {
      issues.push(`${path} exceeds the maximum schema depth of ${MAX_SCHEMA_DEPTH}`);
      return;
    }

    for (const keyword of Object.keys(node)) {
      if (!ALLOWED_KEYWORDS.has(keyword)) {
        issues.push(`${path}.${keyword} is not supported by portable-v1`);
      }
    }

    const rawType = node.type;
    let baseType: string | undefined;
    let nullable = false;
    if (typeof rawType === "string") {
      baseType = rawType;
    } else if (
      Array.isArray(rawType) &&
      rawType.length === 2 &&
      rawType.every((item): item is string => typeof item === "string") &&
      rawType.includes("null")
    ) {
      const nonNull = rawType.filter((item) => item !== "null");
      if (nonNull.length === 1) {
        [baseType] = nonNull;
        nullable = true;
      }
    }
    if (!baseType || !ALLOWED_TYPES.has(baseType)) {
      issues.push(
        `${path}.type must be one supported type or a two-item nullable union with "null"`,
      );
      return;
    }
    if (root && (baseType !== "object" || nullable)) {
      issues.push('$.type must be the non-nullable type "object"');
    }

    if (node.enum !== undefined) {
      if (!Array.isArray(node.enum) || node.enum.length === 0) {
        issues.push(`${path}.enum must be a non-empty array`);
      } else {
        enumValueCount += node.enum.length;
        for (const value of node.enum) constrainedCharacterCount += valueCharacterCount(value);
      }
    }
    if (node.const !== undefined) constrainedCharacterCount += valueCharacterCount(node.const);

    const objectKeywords = ["properties", "required", "additionalProperties"] as const;
    if (baseType !== "object") {
      for (const keyword of objectKeywords) {
        if (node[keyword] !== undefined) {
          issues.push(`${path}.${keyword} is only valid for object schemas`);
        }
      }
    }
    const arrayKeywords = ["items", "minItems", "maxItems"] as const;
    if (baseType !== "array") {
      for (const keyword of arrayKeywords) {
        if (node[keyword] !== undefined) {
          issues.push(`${path}.${keyword} is only valid for array schemas`);
        }
      }
    }
    const numericKeywords = [
      "minimum",
      "maximum",
      "exclusiveMinimum",
      "exclusiveMaximum",
      "multipleOf",
    ] as const;
    if (baseType !== "number" && baseType !== "integer") {
      for (const keyword of numericKeywords) {
        if (node[keyword] !== undefined) {
          issues.push(`${path}.${keyword} is only valid for numeric schemas`);
        }
      }
    }

    if (baseType === "object") {
      if (!isRecord(node.properties)) {
        issues.push(`${path}.properties must be an object`);
        return;
      }
      const keys = Object.keys(node.properties);
      propertyCount += keys.length;
      for (const key of keys) constrainedCharacterCount += key.length;
      if (node.additionalProperties !== false) {
        issues.push(`${path}.additionalProperties must be false`);
      }
      if (!Array.isArray(node.required) || !node.required.every((key) => typeof key === "string")) {
        issues.push(`${path}.required must list every property`);
      } else {
        const required = node.required as string[];
        const requiredSet = new Set(required);
        if (
          requiredSet.size !== required.length ||
          requiredSet.size !== keys.length ||
          keys.some((key) => !requiredSet.has(key))
        ) {
          issues.push(
            `${path}.required must contain every property exactly once; optional values must be required and nullable`,
          );
        }
      }
      for (const [key, child] of Object.entries(node.properties)) {
        visit(child, pathProperty(path, key), depth + 1, false);
      }
    } else if (baseType === "array") {
      if (!isRecord(node.items)) {
        issues.push(`${path}.items must be a single schema object`);
      } else {
        visit(node.items, `${path}.items`, depth + 1, false);
      }
    }
  };

  visit(schema, "$", 1, true);
  if (propertyCount > MAX_SCHEMA_PROPERTIES) {
    issues.push(`$ contains ${propertyCount} properties; maximum is ${MAX_SCHEMA_PROPERTIES}`);
  }
  if (enumValueCount > MAX_ENUM_VALUES) {
    issues.push(`$ contains ${enumValueCount} enum values; maximum is ${MAX_ENUM_VALUES}`);
  }
  if (constrainedCharacterCount > MAX_SCHEMA_CHARACTERS) {
    issues.push(
      `$ contains ${constrainedCharacterCount} characters across property names, enum values, and constants; maximum is ${MAX_SCHEMA_CHARACTERS}`,
    );
  }
  return issues;
}

export function assertPortableOutputSchema(
  schema: unknown,
): asserts schema is Record<string, unknown> {
  const issues = validatePortableOutputSchema(schema);
  if (issues.length > 0) throw new PortableOutputSchemaError(issues);
}

/** Compile a general JSON Schema used by Rome's UI-only handback contract. */
export function compileJsonSchema(schema: Record<string, unknown>): CompiledOutputSchema {
  return { validate: ajv.compile(schema) };
}

export function compileOutputSchema(schema: Record<string, unknown>): CompiledOutputSchema {
  assertPortableOutputSchema(schema);
  return compileJsonSchema(schema);
}

export function formatOutputSchemaErrors(errors: ErrorObject[] | null | undefined): string[] {
  if (!errors || errors.length === 0) return [];
  return errors.map((e) => {
    const path = e.instancePath || "/";
    return `${path} ${e.message ?? "invalid"}`.trim();
  });
}
