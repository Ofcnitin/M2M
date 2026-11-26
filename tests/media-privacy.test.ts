import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-ignore - plain ESM lib with no type declarations; imported for its pure helpers
import { planMigration } from "../scripts/migrate-mature-media-lib.mjs";
import { deliveryDecision, privacyForRating, keyMatchesPrivacy } from "../src/lib/media-keys";

// Minimal stand-in for the bucket rule in src/lib/r2.ts bucketForPrivacy():
// privacy is an explicit input (derived from the DB rating), never read off the key.
// r2.ts itself is not imported here because it constructs an S3 client at module load.
const bucketForPrivacy = (privacy: "public" | "private") => (privacy === "private" ? "private-bucket" : "public-bucket");

test("bucket selection follows privacy (DB rating), not the key prefix", () => {
  // mature asset with an ORDINARY key must still resolve to the private bucket
  assert.equal(bucketForPrivacy(privacyForRating("mature")), "private-bucket");
  assert.equal(bucketForPrivacy(privacyForRating("everyone")), "public-bucket");
  assert.equal(bucketForPrivacy(privacyForRating("teen")), "public-bucket");
  assert.equal(bucketForPrivacy(privacyForRating(null)), "public-bucket");
});

test("mature + ordinary key => delivery REJECTED, never public", () => {
  const d = deliveryDecision({ rating: "mature", storageKey: "series-1/chapter-1/page.jpg" });
  assert.equal(d.kind, "reject");
});

test("mature + restricted key => signed-private delivery", () => {
  assert.deepEqual(deliveryDecision({ rating: "mature", storageKey: "restricted/series-1/cover/c.jpg" }), { kind: "signed-private" });
});

test("mature + missing/invalid key => rejected", () => {
  for (const bad of [null, undefined, "", 42, {}]) {
    assert.equal(deliveryDecision({ rating: "mature", storageKey: bad }).kind, "reject", String(bad));
    assert.equal(deliveryDecision({ rating: "everyone", storageKey: bad }).kind, "reject", String(bad));
  }
});

test("public asset => CDN; restricted key on a public series stays gated (never CDN)", () => {
  assert.deepEqual(deliveryDecision({ rating: "everyone", storageKey: "series-1/chapter-1/page.jpg" }), { kind: "cdn" });
  assert.deepEqual(deliveryDecision({ rating: "teen", storageKey: "restricted/series-1/x.jpg" }), { kind: "signed-private" });
});

test("keyMatchesPrivacy enforces prefix/rating agreement (resign gate)", () => {
  assert.equal(keyMatchesPrivacy("restricted/a/b.jpg", "private"), true);
  assert.equal(keyMatchesPrivacy("a/b.jpg", "private"), false);
  assert.equal(keyMatchesPrivacy("a/b.jpg", "public"), true);
  assert.equal(keyMatchesPrivacy("restricted/a/b.jpg", "public"), false);
  assert.equal(keyMatchesPrivacy(null, "public"), false);
});

test("migration plan rewrites a mature public key to restricted/ (private side)", () => {
  const [item] = planMigration([{ assetKind: "chapter_asset", assetId: "a1", seriesId: "s1", key: "s1/c1/p.jpg" }]);
  assert.equal(item.action, "copy");
  assert.equal(item.newKey, "restricted/s1/c1/p.jpg");
});
