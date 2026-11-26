import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeTag, normalizeTags, tagHref, MAX_TAGS, MAX_TAG_LENGTH } from "../src/lib/tags";

test("normalizeTag lowercases, strips # and punctuation, collapses spaces", () => {
  assert.equal(normalizeTag("  #Sci   Fi!! "), "sci fi");
  assert.equal(normalizeTag("Rom-Com"), "rom-com");
  assert.equal(normalizeTag("---x---"), "x");
});
test("normalizeTag keeps non-latin letters", () => {
  assert.equal(normalizeTag("#학원물"), "학원물");
  assert.equal(normalizeTag("Café"), "café");
});
test("normalizeTag removes characters that could break array filters", () => {
  assert.equal(normalizeTag('a,"b"{c}\\'), "abc");
});
test("normalizeTag caps length", () => {
  assert.equal(normalizeTag("x".repeat(80)).length, MAX_TAG_LENGTH);
});
test("normalizeTags splits, dedupes and drops empties", () => {
  assert.deepEqual(normalizeTags("Time Travel, time  travel, , #Found Family\nmystery"), ["time travel", "found family", "mystery"]);
});
test("normalizeTags caps the list", () => {
  const many = Array.from({ length: 25 }, (_, i) => `tag${i}`).join(",");
  assert.equal(normalizeTags(many).length, MAX_TAGS);
});
test("normalizeTags accepts arrays", () => assert.deepEqual(normalizeTags(["A", "a", "b"]), ["a", "b"]));
test("tagHref encodes", () => assert.equal(tagHref("sci fi"), "/discover?tag=sci%20fi"));
