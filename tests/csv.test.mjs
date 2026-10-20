import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { mapHistoricalRow, parseCsv, validateHistoricalHeaders } from "../server/csv.mjs";

const seed = readFileSync(new URL("./fixtures/sample.csv", import.meta.url), "utf8");

test("historical CSV parses all rows and required headers", () => {
  const parsed = parseCsv(seed);
  assert.equal(parsed.rows.length, 3);
  assert.deepEqual(validateHistoricalHeaders(parsed.headers), []);
  assert.equal(parsed.headers.length, 6);
});

test("quoted multiline details are preserved", () => {
  const parsed = parseCsv(seed);
  const row = parsed.rows.find((candidate) => candidate["Concept/Data"] === "Example one");
  assert.ok(row);
  const entry = mapHistoricalRow(row);
  assert.match(entry.details, /\n/);
  assert.equal(entry.bookNumber, "1");
  assert.equal(entry.pageNumber, "1");
});

test("escaped quotes and line breaks parse without losing fields", () => {
  const parsed = parseCsv('Keyword,Concept/Data,Additional Details,Book Number,Page Number,Keywords\r\nnet,"A, B","line 1\nline ""two""",401.1,9,"tag, alias"\r\n');
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0]["Concept/Data"], "A, B");
  assert.equal(parsed.rows[0]["Additional Details"], 'line 1\nline "two"');
});
