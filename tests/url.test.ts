import { test } from "node:test";
import assert from "node:assert/strict";
import { safeNext } from "../src/lib/url";

test("allows same-site paths", () => {
  assert.equal(safeNext("/series/abc?order=asc#comments"), "/series/abc?order=asc#comments");
  assert.equal(safeNext("/"), "/");
});
test("blocks open redirects", () => {
  for (const bad of ["//evil.com", "/\\evil.com", "https://evil.com", "evil.com", "javascript:alert(1)", "", null, undefined]) {
    assert.equal(safeNext(bad as string | null | undefined), "/", String(bad));
  }
});
test("custom fallback", () => assert.equal(safeNext("//x", "/home"), "/home"));
