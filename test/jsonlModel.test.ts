import assert from "node:assert/strict";
import test from "node:test";
import { parseJsonlText, updateJsonlLineValue } from "../src/jsonlModel";

test("parses jsonl rows independently", () => {
  const model = parseJsonlText("{\"a\":1}\n[1,2]\ntrue");

  assert.equal(model.rows.length, 3);
  assert.equal(model.rows[0]?.kind, "json");
  assert.equal(model.rows[1]?.kind, "json");
  assert.equal(model.rows[2]?.kind, "json");
});

test("preserves empty and invalid lines as non-editable rows", () => {
  const model = parseJsonlText("{\"ok\":true}\n\n{\"broken\":");

  assert.equal(model.rows[0]?.kind, "json");
  assert.equal(model.rows[1]?.kind, "empty");
  assert.equal(model.rows[2]?.kind, "invalid");
});

test("shows literal backslash-n strings as newlines and restores them on write", () => {
  const source = "{\"text\":\"a\\\\nb\"}";
  const model = parseJsonlText(source);
  const row = model.rows[0];

  assert.equal(row?.kind, "json");
  if (row?.kind !== "json") {
    return;
  }
  assert.deepEqual(row.value, { text: "a\nb" });

  const result = updateJsonlLineValue(source, 0, ["text"], "x\ny");

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.line, "{\"text\":\"x\\\\ny\"}");
});

test("recursively parses object and array strings and stringifies them back", () => {
  const source = JSON.stringify({
    payload: JSON.stringify({ count: 1, items: ["a"] })
  });
  const model = parseJsonlText(source);
  const row = model.rows[0];

  assert.equal(row?.kind, "json");
  if (row?.kind !== "json") {
    return;
  }
  assert.deepEqual(row.value, { payload: { count: 1, items: ["a"] } });

  const result = updateJsonlLineValue(source, 0, ["payload", "count"], 2);

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  const written = JSON.parse(result.line) as { payload: string };
  assert.equal(written.payload, "{\"count\":2,\"items\":[\"a\"]}");
});

test("handles multiple nested parsed json string layers", () => {
  const source = JSON.stringify({
    outer: JSON.stringify({
      inner: JSON.stringify({ ok: true })
    })
  });
  const model = parseJsonlText(source);
  const row = model.rows[0];

  assert.equal(row?.kind, "json");
  if (row?.kind !== "json") {
    return;
  }
  assert.deepEqual(row.value, { outer: { inner: { ok: true } } });

  const result = updateJsonlLineValue(source, 0, ["outer", "inner", "ok"], false);

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  const written = JSON.parse(result.line) as { outer: string };
  const outer = JSON.parse(written.outer) as { inner: string };
  assert.deepEqual(JSON.parse(outer.inner), { ok: false });
});

test("rejects invalid primitive edits", () => {
  const result = updateJsonlLineValue("{\"count\":1}", 0, ["count"], "oops");

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /Expected number/);
  }
});
