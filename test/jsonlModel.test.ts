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

test("restores eval-style nested request content after editing inside stringified JSON layers", () => {
  const source = JSON.stringify({
    seq: 1,
    rawRequest: JSON.stringify({
      model: "kimi-k2.6:cloud",
      messages: [
        {
          role: "user",
          content: JSON.stringify({
            prompt: "hello\\nworld",
            options: { stream: true }
          })
        }
      ]
    })
  });
  const model = parseJsonlText(source);
  const row = model.rows[0];

  assert.equal(row?.kind, "json");
  if (row?.kind !== "json") {
    return;
  }
  assert.deepEqual(row.value, {
    seq: 1,
    rawRequest: {
      model: "kimi-k2.6:cloud",
      messages: [
        {
          role: "user",
          content: {
            prompt: "hello\nworld",
            options: { stream: true }
          }
        }
      ]
    }
  });

  const result = updateJsonlLineValue(
    source,
    0,
    ["rawRequest", "messages", 0, "content", "prompt"],
    "updated\nprompt"
  );

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }

  const written = JSON.parse(result.line) as { rawRequest: string };
  assert.equal(typeof written.rawRequest, "string");
  const rawRequest = JSON.parse(written.rawRequest) as {
    model: string;
    messages: Array<{ role: string; content: string }>;
  };
  assert.equal(rawRequest.model, "kimi-k2.6:cloud");
  assert.equal(typeof rawRequest.messages[0]?.content, "string");
  const content = JSON.parse(rawRequest.messages[0]?.content ?? "") as {
    prompt: string;
    options: { stream: boolean };
  };
  assert.deepEqual(content, {
    prompt: "updated\\nprompt",
    options: { stream: true }
  });
});

test("restores arrays nested through several JSON.stringify boundaries", () => {
  const source = JSON.stringify({
    batches: JSON.stringify([
      {
        payload: JSON.stringify({
          metrics: JSON.stringify([
            {
              score: 1,
              tags: JSON.stringify(["alpha", "beta"])
            }
          ])
        })
      }
    ])
  });
  const model = parseJsonlText(source);
  const row = model.rows[0];

  assert.equal(row?.kind, "json");
  if (row?.kind !== "json") {
    return;
  }
  assert.deepEqual(row.value, {
    batches: [
      {
        payload: {
          metrics: [
            {
              score: 1,
              tags: ["alpha", "beta"]
            }
          ]
        }
      }
    ]
  });

  const scoreResult = updateJsonlLineValue(
    source,
    0,
    ["batches", 0, "payload", "metrics", 0, "score"],
    42
  );

  assert.equal(scoreResult.ok, true);
  if (!scoreResult.ok) {
    return;
  }

  const written = JSON.parse(scoreResult.line) as { batches: string };
  assert.equal(typeof written.batches, "string");
  const batches = JSON.parse(written.batches) as Array<{ payload: string }>;
  assert.equal(typeof batches[0]?.payload, "string");
  const payload = JSON.parse(batches[0]?.payload ?? "") as { metrics: string };
  assert.equal(typeof payload.metrics, "string");
  const metrics = JSON.parse(payload.metrics) as Array<{ score: number; tags: string }>;
  assert.equal(metrics[0]?.score, 42);
  assert.equal(typeof metrics[0]?.tags, "string");
  assert.deepEqual(JSON.parse(metrics[0]?.tags ?? ""), ["alpha", "beta"]);
});

test("restores sibling stringified branches when editing one deeply nested value", () => {
  const source = JSON.stringify({
    request: JSON.stringify({
      a: JSON.stringify({ keep: "left" }),
      b: JSON.stringify({ edit: { enabled: false } })
    }),
    response: JSON.stringify({
      choices: [
        {
          message: JSON.stringify({ content: "old" })
        }
      ]
    })
  });

  const result = updateJsonlLineValue(source, 0, ["request", "b", "edit", "enabled"], true);

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }

  const written = JSON.parse(result.line) as { request: string; response: string };
  assert.equal(typeof written.request, "string");
  assert.equal(typeof written.response, "string");

  const request = JSON.parse(written.request) as { a: string; b: string };
  assert.equal(typeof request.a, "string");
  assert.equal(typeof request.b, "string");
  assert.deepEqual(JSON.parse(request.a), { keep: "left" });
  assert.deepEqual(JSON.parse(request.b), { edit: { enabled: true } });

  const response = JSON.parse(written.response) as { choices: Array<{ message: string }> };
  assert.equal(typeof response.choices[0]?.message, "string");
  assert.deepEqual(JSON.parse(response.choices[0]?.message ?? ""), { content: "old" });
});

test("rejects invalid primitive edits", () => {
  const result = updateJsonlLineValue("{\"count\":1}", 0, ["count"], "oops");

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /Expected number/);
  }
});
