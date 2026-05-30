export type JsonPathSegment = string | number;
export type JsonPath = JsonPathSegment[];
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type JsonlRow = EmptyJsonlRow | InvalidJsonlRow | ValidJsonlRow;

export interface EmptyJsonlRow {
  kind: "empty";
  lineIndex: number;
  lineNumber: number;
  raw: string;
  summary: string;
}

export interface InvalidJsonlRow {
  kind: "invalid";
  lineIndex: number;
  lineNumber: number;
  raw: string;
  summary: string;
  error: string;
}

export interface ValidJsonlRow {
  kind: "json";
  lineIndex: number;
  lineNumber: number;
  raw: string;
  summary: string;
  value: JsonValue;
  meta: ValueMeta;
}

export interface JsonlDocumentModel {
  rows: JsonlRow[];
}

export type JsonlEditResult = {
  ok: true;
  line: string;
  value: JsonValue;
} | {
  ok: false;
  error: string;
};

interface ValueMeta {
  kind: "plain" | "literalEscapedString" | "parsedJsonString";
  children?: Record<string, ValueMeta>;
}

interface TransformedValue {
  value: JsonValue;
  meta: ValueMeta;
}

const SUMMARY_LIMIT = 120;

export function parseJsonlText(text: string): JsonlDocumentModel {
  const lines = normalizeNewlines(text).split("\n");
  return {
    rows: lines.map((line, index) => parseJsonlLine(line, index))
  };
}

export function updateJsonlLineValue(
  text: string,
  lineIndex: number,
  path: JsonPath,
  nextValue: JsonPrimitive
): JsonlEditResult {
  const model = parseJsonlText(text);
  const row = model.rows[lineIndex];

  if (!row) {
    return { ok: false, error: `Line ${lineIndex + 1} does not exist.` };
  }

  if (row.kind !== "json") {
    return { ok: false, error: `Line ${row.lineNumber} is not editable.` };
  }

  const currentValue = getValueAtPath(row.value, path);
  if (!currentValue.ok) {
    return { ok: false, error: currentValue.error };
  }

  const validation = validatePrimitiveEdit(currentValue.value, nextValue);
  if (!validation.ok) {
    return validation;
  }

  const updatedDisplayValue = setValueAtPath(row.value, path, nextValue);
  const rawValue = serializeDisplayValue(updatedDisplayValue, row.meta);

  return {
    ok: true,
    line: JSON.stringify(rawValue),
    value: updatedDisplayValue
  };
}

function parseJsonlLine(raw: string, lineIndex: number): JsonlRow {
  const lineNumber = lineIndex + 1;
  if (raw.trim().length === 0) {
    return {
      kind: "empty",
      lineIndex,
      lineNumber,
      raw,
      summary: "Empty line"
    };
  }

  try {
    const parsed = JSON.parse(raw) as JsonValue;
    const transformed = transformValue(parsed);
    return {
      kind: "json",
      lineIndex,
      lineNumber,
      raw,
      summary: summarizeValue(transformed.value),
      value: transformed.value,
      meta: transformed.meta
    };
  } catch (error) {
    return {
      kind: "invalid",
      lineIndex,
      lineNumber,
      raw,
      summary: "Invalid JSON",
      error: error instanceof Error ? error.message : "Unable to parse JSON."
    };
  }
}

function transformValue(value: JsonValue): TransformedValue {
  if (typeof value === "string") {
    const parsedJsonString = parseNestedJsonString(value);
    if (parsedJsonString) {
      return {
        value: parsedJsonString.value,
        meta: {
          kind: "parsedJsonString",
          children: parsedJsonString.meta.children
        }
      };
    }

    if (hasLiteralNewlineEscape(value)) {
      return {
        value: decodeLiteralNewlineEscapes(value),
        meta: { kind: "literalEscapedString" }
      };
    }

    return {
      value,
      meta: { kind: "plain" }
    };
  }

  if (Array.isArray(value)) {
    const children: Record<string, ValueMeta> = {};
    const items = value.map((item, index) => {
      const transformed = transformValue(item);
      children[String(index)] = transformed.meta;
      return transformed.value;
    });

    return {
      value: items,
      meta: { kind: "plain", children }
    };
  }

  if (value && typeof value === "object") {
    const children: Record<string, ValueMeta> = {};
    const output: { [key: string]: JsonValue } = {};

    for (const [key, childValue] of Object.entries(value)) {
      const transformed = transformValue(childValue as JsonValue);
      children[key] = transformed.meta;
      output[key] = transformed.value;
    }

    return {
      value: output,
      meta: { kind: "plain", children }
    };
  }

  return {
    value,
    meta: { kind: "plain" }
  };
}

function parseNestedJsonString(value: string): TransformedValue | undefined {
  const trimmed = value.trim();
  if (!looksLikeObjectOrArray(trimmed)) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(trimmed) as JsonValue;
    if (parsed !== null && (Array.isArray(parsed) || typeof parsed === "object")) {
      return transformValue(parsed);
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function serializeDisplayValue(value: JsonValue, meta: ValueMeta): JsonValue {
  if (meta.kind === "parsedJsonString") {
    const innerValue = serializeContainerChildren(value, meta.children);
    return JSON.stringify(innerValue);
  }

  if (typeof value === "string") {
    return meta.kind === "literalEscapedString" ? encodeLiteralNewlineEscapes(value) : value;
  }

  return serializeContainerChildren(value, meta.children);
}

function serializeContainerChildren(value: JsonValue, children: Record<string, ValueMeta> | undefined): JsonValue {
  if (Array.isArray(value)) {
    return value.map((item, index) => serializeDisplayValue(item, children?.[String(index)] ?? { kind: "plain" }));
  }

  if (value && typeof value === "object") {
    const output: { [key: string]: JsonValue } = {};
    for (const [key, childValue] of Object.entries(value)) {
      output[key] = serializeDisplayValue(childValue as JsonValue, children?.[key] ?? { kind: "plain" });
    }
    return output;
  }

  return value;
}

function getValueAtPath(value: JsonValue, path: JsonPath): { ok: true; value: JsonValue } | { ok: false; error: string } {
  let current: JsonValue = value;

  for (const segment of path) {
    if (Array.isArray(current) && typeof segment === "number") {
      if (segment < 0 || segment >= current.length) {
        return { ok: false, error: `Array index ${segment} does not exist.` };
      }
      current = current[segment];
      continue;
    }

    if (current && !Array.isArray(current) && typeof current === "object" && typeof segment === "string") {
      if (!Object.prototype.hasOwnProperty.call(current, segment)) {
        return { ok: false, error: `Property "${segment}" does not exist.` };
      }
      current = current[segment];
      continue;
    }

    return { ok: false, error: "Edit path does not match the JSON structure." };
  }

  return { ok: true, value: current };
}

function setValueAtPath(value: JsonValue, path: JsonPath, nextValue: JsonPrimitive): JsonValue {
  if (path.length === 0) {
    return nextValue;
  }

  const [segment, ...rest] = path;
  if (Array.isArray(value) && typeof segment === "number") {
    return value.map((item, index) => (index === segment ? setValueAtPath(item, rest, nextValue) : item));
  }

  if (value && !Array.isArray(value) && typeof value === "object" && typeof segment === "string") {
    return {
      ...value,
      [segment]: setValueAtPath(value[segment], rest, nextValue)
    };
  }

  return value;
}

function validatePrimitiveEdit(
  currentValue: JsonValue,
  nextValue: JsonPrimitive
): { ok: true } | { ok: false; error: string } {
  if (Array.isArray(currentValue) || (currentValue !== null && typeof currentValue === "object")) {
    return { ok: false, error: "Only existing primitive values can be edited." };
  }

  if (currentValue === null) {
    return nextValue === null ? { ok: true } : { ok: false, error: "This value must stay null." };
  }

  if (typeof currentValue !== typeof nextValue) {
    return { ok: false, error: `Expected ${typeof currentValue}, received ${nextValue === null ? "null" : typeof nextValue}.` };
  }

  if (typeof nextValue === "number" && !Number.isFinite(nextValue)) {
    return { ok: false, error: "Number values must be finite." };
  }

  return { ok: true };
}

function summarizeValue(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.length} items] ${truncate(JSON.stringify(value))}`;
  }

  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    return `{${keys.length} keys} ${truncate(JSON.stringify(value))}`;
  }

  return truncate(JSON.stringify(value));
}

function truncate(value: string): string {
  return value.length <= SUMMARY_LIMIT ? value : `${value.slice(0, SUMMARY_LIMIT - 1)}...`;
}

function hasLiteralNewlineEscape(value: string): boolean {
  return /\\r\\n|\\n|\\r/.test(value);
}

function decodeLiteralNewlineEscapes(value: string): string {
  return value.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n").replace(/\\r/g, "\n");
}

function encodeLiteralNewlineEscapes(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n/g, "\\n");
}

function looksLikeObjectOrArray(value: string): boolean {
  return (value.startsWith("{") && value.endsWith("}")) || (value.startsWith("[") && value.endsWith("]"));
}

function normalizeNewlines(input: string): string {
  return input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}
