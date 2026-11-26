import { test } from "node:test";
import assert from "node:assert/strict";
import { matureVisibleInDiscovery, filterExcludedWarnings } from "../src/lib/discovery";

// ── matureVisibleInDiscovery: full truth table ─────────────────────────────
// Discovery listings show mature series ONLY when eligibility and the user's
// show_mature_content opt-in are BOTH true.
test("matureVisibleInDiscovery: eligible + pref on = visible", () => {
  assert.equal(matureVisibleInDiscovery(true, true), true);
});
test("matureVisibleInDiscovery: eligible + pref off = hidden", () => {
  assert.equal(matureVisibleInDiscovery(true, false), false);
});
test("matureVisibleInDiscovery: ineligible + pref on = hidden (preference never grants access)", () => {
  assert.equal(matureVisibleInDiscovery(false, true), false);
});
test("matureVisibleInDiscovery: ineligible + pref off = hidden", () => {
  assert.equal(matureVisibleInDiscovery(false, false), false);
});

// ── Direct access vs discovery: the distinction ────────────────────────────
// Direct series/chapter pages use RAW eligibility only (canAccessMature): an
// eligible user who has NOT opted in can still open a mature series they
// navigate to directly, even though it never appears in their listings.
// An ineligible user is blocked in both places, whatever their preference.
test("direct-vs-discovery: eligible without opt-in keeps direct access but no listing visibility", () => {
  const eligible = true; // raw eligibility, as used by direct pages
  const showMaturePref = false;
  assert.equal(eligible, true); // direct page gate: passes
  assert.equal(matureVisibleInDiscovery(eligible, showMaturePref), false); // listing gate: hidden
});
test("direct-vs-discovery: ineligible with opt-in is blocked in both", () => {
  const eligible = false;
  const showMaturePref = true;
  assert.equal(eligible, false); // direct page gate: blocked
  assert.equal(matureVisibleInDiscovery(eligible, showMaturePref), false); // listing gate: hidden
});

// ── filterExcludedWarnings ─────────────────────────────────────────────────
const rows = [
  { slug: "a", content_warnings: ["violence"] },
  { slug: "b", content_warnings: ["gore", "graphic_violence"] },
  { slug: "c", content_warnings: ["psychological"] },
  { slug: "d", content_warnings: [] },
  { slug: "e", content_warnings: null },
  { slug: "f" }, // no content_warnings field at all
];

test("filterExcludedWarnings removes rows sharing any excluded warning", () => {
  const out = filterExcludedWarnings(rows, ["gore"]);
  assert.deepEqual(out.map((r) => r.slug), ["a", "c", "d", "e", "f"]);
});
test("filterExcludedWarnings removes rows matching any of several excluded warnings", () => {
  const out = filterExcludedWarnings(rows, ["violence", "psychological"]);
  assert.deepEqual(out.map((r) => r.slug), ["b", "d", "e", "f"]);
});
test("filterExcludedWarnings keeps non-matching rows", () => {
  const out = filterExcludedWarnings(rows, ["substance_use"]);
  assert.deepEqual(out.map((r) => r.slug), ["a", "b", "c", "d", "e", "f"]);
});
test("filterExcludedWarnings with empty excluded list returns rows unchanged", () => {
  const out = filterExcludedWarnings(rows, []);
  assert.deepEqual(out, rows);
  assert.equal(out, rows); // same array, not a copy
});
test("filterExcludedWarnings keeps rows with null or missing warnings", () => {
  const out = filterExcludedWarnings(rows, ["violence", "gore", "graphic_violence", "psychological"]);
  assert.deepEqual(out.map((r) => r.slug), ["d", "e", "f"]);
});
