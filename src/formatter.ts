export type FormatKind = "json" | "markdown";

export interface FormatResult {
  kind: FormatKind;
  language: "json" | "markdown";
  formatted: string;
  warning?: string;
}

interface JsonCandidate {
  text: string;
  label: string;
}

const MAX_REPAIR_PASSES = 2;

export function formatSelection(input: string): FormatResult {
  try {
    const raw = normalizeNewlines(input ?? "");
    const candidates = buildCandidates(raw);
    const jsonResult = tryFormatJson(candidates);

    if (jsonResult) {
      return jsonResult;
    }

    const markdownText = chooseMarkdownText(raw, candidates);
    return {
      kind: "markdown",
      language: "markdown",
      formatted: markdownText
    };
  } catch (error) {
    return {
      kind: "markdown",
      language: "markdown",
      formatted: input ?? "",
      warning: `Preview fallback: ${error instanceof Error ? error.message : "unknown error"}`
    };
  }
}

export function decodeOneLayer(input: string): string {
  const text = normalizeNewlines(input);
  const trimmed = text.trim();

  if (looksLikeDoubleQuotedString(trimmed)) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "string") {
        return normalizeNewlines(parsed);
      }
    } catch {
      // Fall through to targeted escape replacement.
    }
  }

  const unwrapped = unwrapLikelyStringLiteral(text);
  return normalizeNewlines(unescapeCommonSequences(unwrapped));
}

function buildCandidates(raw: string): JsonCandidate[] {
  const decoded = decodeOneLayer(raw);
  const repairedRaw = repairJsonish(raw);
  const repairedDecoded = repairJsonish(decoded);

  return uniqueCandidates([
    { text: raw, label: "raw" },
    { text: decoded, label: "decoded" },
    { text: stripCodeFence(raw), label: "raw without fence" },
    { text: stripCodeFence(decoded), label: "decoded without fence" },
    { text: repairedRaw, label: "repaired raw" },
    { text: repairedDecoded, label: "repaired decoded" }
  ]);
}

function tryFormatJson(candidates: JsonCandidate[]): FormatResult | undefined {
  for (const candidate of candidates) {
    const parsed = parseJsonObjectOrArray(candidate.text);
    if (parsed.ok) {
      return {
        kind: "json",
        language: "json",
        formatted: JSON.stringify(parsed.value, null, 2)
      };
    }
  }

  const jsonish = candidates.find((candidate) => looksJsonish(candidate.text));
  if (!jsonish) {
    return undefined;
  }

  let repaired = jsonish.text;
  for (let index = 0; index < MAX_REPAIR_PASSES; index += 1) {
    repaired = repairJsonish(repaired);
    const parsed = parseJsonObjectOrArray(repaired);
    if (parsed.ok) {
      return {
        kind: "json",
        language: "json",
        formatted: JSON.stringify(parsed.value, null, 2)
      };
    }
  }

  return {
    kind: "json",
    language: "json",
    formatted: repaired.trim() || jsonish.text,
    warning: "JSON is incomplete or invalid; showing the safest repaired preview."
  };
}

function chooseMarkdownText(raw: string, candidates: JsonCandidate[]): string {
  const decoded = candidates.find((candidate) => candidate.label === "decoded")?.text ?? decodeOneLayer(raw);
  return decoded.length > 0 ? decoded : raw;
}

function parseJsonObjectOrArray(text: string): { ok: true; value: unknown } | { ok: false } {
  const trimmed = text.trim();
  if (!looksJsonish(trimmed)) {
    return { ok: false };
  }

  try {
    const value = JSON.parse(trimmed);
    if (value !== null && (Array.isArray(value) || typeof value === "object")) {
      return { ok: true, value };
    }
  } catch {
    return { ok: false };
  }

  return { ok: false };
}

function repairJsonish(input: string): string {
  const unfenced = stripCodeFence(decodeOneLayer(input)).trim();
  const sliced = sliceOuterJson(unfenced);
  return removeTrailingCommas(sliced).trim();
}

function stripCodeFence(input: string): string {
  const trimmed = input.trim();
  const match = trimmed.match(/^```(?:json|javascript|js)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1] : input;
}

function sliceOuterJson(input: string): string {
  const firstObject = input.indexOf("{");
  const firstArray = input.indexOf("[");
  const starts: number[] = [firstObject, firstArray].filter((index) => index >= 0);

  if (starts.length === 0) {
    return input;
  }

  const start = Math.min(...starts);
  const endObject = input.lastIndexOf("}");
  const endArray = input.lastIndexOf("]");
  const end = Math.max(endObject, endArray);

  if (end > start) {
    return input.slice(start, end + 1);
  }

  return input.slice(start);
}

function removeTrailingCommas(input: string): string {
  let output = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const nextNonWhitespace = input.slice(index + 1).match(/\S/)?.[0];

    if (escaped) {
      output += char;
      escaped = false;
      continue;
    }

    if (char === "\\" && inString) {
      output += char;
      escaped = true;
      continue;
    }

    if (char === "\"") {
      inString = !inString;
      output += char;
      continue;
    }

    if (!inString && char === "," && (nextNonWhitespace === "}" || nextNonWhitespace === "]")) {
      continue;
    }

    output += char;
  }

  return output;
}

function uniqueCandidates(candidates: JsonCandidate[]): JsonCandidate[] {
  const seen = new Set<string>();
  const unique: JsonCandidate[] = [];

  for (const candidate of candidates) {
    if (!seen.has(candidate.text)) {
      seen.add(candidate.text);
      unique.push(candidate);
    }
  }

  return unique;
}

function looksJsonish(input: string): boolean {
  const trimmed = input.trim();
  return (trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length > 1;
}

function looksLikeDoubleQuotedString(input: string): boolean {
  return input.length >= 2 && input.startsWith("\"") && input.endsWith("\"");
}

function unwrapLikelyStringLiteral(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length < 2) {
    return input;
  }

  const quote = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((quote === "\"" || quote === "'") && last === quote) {
    return trimmed.slice(1, -1);
  }

  return input;
}

function unescapeCommonSequences(input: string): string {
  let output = "";

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];

    if (char !== "\\" || next === undefined) {
      output += char;
      continue;
    }

    if (next === "r" && input[index + 2] === "\\" && input[index + 3] === "n") {
      output += "\n";
      index += 3;
      continue;
    }

    switch (next) {
      case "n":
        output += "\n";
        break;
      case "r":
        output += "\n";
        break;
      case "t":
        output += "\t";
        break;
      case "\"":
        output += "\"";
        break;
      case "'":
        output += "'";
        break;
      case "\\":
        output += "\\";
        break;
      default:
        output += char + next;
        break;
    }

    index += 1;
  }

  return output;
}

function normalizeNewlines(input: string): string {
  return input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}
