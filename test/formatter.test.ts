import assert from "node:assert/strict";
import test from "node:test";
import { decodeOneLayer, formatSelection } from "../src/formatter";

test("formats escaped markdown newlines", () => {
  const result = formatSelection("# Title\\nbody");

  assert.equal(result.kind, "markdown");
  assert.equal(result.formatted, "# Title\nbody");
});

test("formats escaped json object", () => {
  const result = formatSelection("{\\\"cardFacts\\\":{\\\"metadata\\\":{\\\"id\\\":\\\"horror-escape\\\"},\\\"tags\\\":[\\\"恐怖逃脱\\\",\\\"调查\\\"]}}");

  assert.equal(result.kind, "json");
  assert.equal(
    result.formatted,
    [
      "{",
      "  \"cardFacts\": {",
      "    \"metadata\": {",
      "      \"id\": \"horror-escape\"",
      "    },",
      "    \"tags\": [",
      "      \"恐怖逃脱\",",
      "      \"调查\"",
      "    ]",
      "  }",
      "}"
    ].join("\n")
  );
});

test("formats quoted json string with one decoding pass", () => {
  const result = formatSelection("\"{\\\"ok\\\":true,\\\"items\\\":[1,2]}\"");

  assert.equal(result.kind, "json");
  assert.equal(result.formatted, "{\n  \"ok\": true,\n  \"items\": [\n    1,\n    2\n  ]\n}");
});

test("does not throw on incomplete json", () => {
  const result = formatSelection("{\\\"ok\\\": true,");

  assert.equal(result.kind, "json");
  assert.match(result.formatted, /"ok"/);
  assert.ok(result.warning);
});

test("does not throw on plain text", () => {
  const result = formatSelection("hello world");

  assert.equal(result.kind, "markdown");
  assert.equal(result.formatted, "hello world");
});

test("decodes only one common escape layer", () => {
  assert.equal(decodeOneLayer("a\\\\nb"), "a\\nb");
});
