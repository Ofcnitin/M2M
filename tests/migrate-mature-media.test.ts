// @ts-nocheck - imports the plain-ESM migration lib (no type declarations) on purpose
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-ignore - plain ESM lib with no type declarations
import { buildInventory, planMigration, planRollback, buildReport, classifyKey } from "../scripts/migrate-mature-media-lib.mjs";

const S1 = "11111111-1111-1111-1111-111111111111"; // mature
const S2 = "22222222-2222-2222-2222-222222222222"; // public
const C1 = "33333333-3333-3333-3333-333333333333";
const C2 = "44444444-4444-4444-4444-444444444444";

// Fixture per spec: 2 mature assets (one public key, one restricted) + 1 missing,
// plus a public series whose assets must never enter the inventory.
const fixture = {
  series: [
    { id: S1, content_rating: "mature", cover_url: null, banner_url: null },
    { id: S2, content_rating: "everyone", cover_url: `${S2}/cover/x.jpg`, banner_url: null },
  ],
  chapters: [
    { id: C1, series_id: S1 },
    { id: C2, series_id: S2 },
  ],
  chapterAssets: [
    { id: "a-public", chapter_id: C1, storage_key: `${S1}/${C1}/page1.jpg` },
    { id: "a-restricted", chapter_id: C1, storage_key: `restricted/${S1}/${C1}/page2.jpg` },
    { id: "a-missing", chapter_id: C1, storage_key: null },
    { id: "a-other-series", chapter_id: C2, storage_key: `${S2}/${C2}/page1.jpg` },
  ],
};

test("classifyKey", () => {
  assert.equal(classifyKey("restricted/a.jpg"), "restricted");
  assert.equal(classifyKey("a.jpg"), "public");
  assert.equal(classifyKey(null), "missing");
  assert.equal(classifyKey(""), "missing");
  assert.equal(classifyKey("https://cdn.example.com/a.jpg"), "external");
});

test("inventory contains only mature-series assets", () => {
  const inv = buildInventory(fixture.series, fixture.chapters, fixture.chapterAssets);
  assert.equal(inv.length, 3);
  assert.ok(inv.every((i: { seriesId: string }) => i.seriesId === S1));
});

test("plan counts: 1 copy, 1 skip, 1 missing", () => {
  const plan = planMigration(buildInventory(fixture.series, fixture.chapters, fixture.chapterAssets));
  const byAction = Object.groupBy(plan, (p: { action: string }) => p.action);
  assert.equal(byAction.copy?.length, 1);
  assert.equal(byAction.skip?.length, 1);
  assert.equal(byAction.missing?.length, 1);
  assert.equal(byAction.copy?.[0].newKey, `restricted/${S1}/${C1}/page1.jpg`);
});

test("dry-run report shape and counts", () => {
  const inventory = buildInventory(fixture.series, fixture.chapters, fixture.chapterAssets);
  const report = buildReport({ matureSeriesCount: 1, inventory, plan: planMigration(inventory) });
  assert.deepEqual(Object.keys(report).sort(), ["failed", "migrated", "missing", "remainingPublicReferences", "totalMatureAssets", "totalMatureSeries"]);
  assert.equal(report.totalMatureSeries, 1);
  assert.equal(report.totalMatureAssets, 3);
  assert.equal(report.migrated, 1); // planned copies in dry-run
  assert.equal(report.missing, 1);
  assert.equal(report.failed, 0);
  assert.equal(report.remainingPublicReferences, 1); // the public-key asset still references the public bucket
});

test("executed report: migrated outcome clears the public reference", () => {
  const inventory = buildInventory(fixture.series, fixture.chapters, fixture.chapterAssets);
  const outcomes = new Map([["chapter_asset:a-public", "migrated"]]);
  const report = buildReport({ matureSeriesCount: 1, inventory, plan: planMigration(inventory), outcomes });
  assert.equal(report.migrated, 1);
  assert.equal(report.remainingPublicReferences, 0);
});

test("rollback plan reverses db_updated rows only", () => {
  const rows = [
    { id: "m1", asset_kind: "chapter_asset", asset_id: "a-public", series_id: S1, old_key: "s/c/p.jpg", new_key: "restricted/s/c/p.jpg", status: "db_updated" },
    { id: "m2", asset_kind: "cover", asset_id: S1, series_id: S1, old_key: "s/cover.jpg", new_key: "restricted/s/cover.jpg", status: "deleted_public" },
    { id: "m3", asset_kind: "chapter_asset", asset_id: "a-x", series_id: S1, old_key: "s/c/q.jpg", new_key: "restricted/s/c/q.jpg", status: "copied" },
    { id: "m4", asset_kind: "chapter_asset", asset_id: "a-y", series_id: S1, old_key: null, new_key: null, status: "missing" },
  ];
  const plan = planRollback(rows);
  assert.equal(plan.length, 2);
  const dbUpdated = plan.find((p: { migrationId: string }) => p.migrationId === "m1");
  assert.equal(dbUpdated.fromKey, "restricted/s/c/p.jpg");
  assert.equal(dbUpdated.toKey, "s/c/p.jpg");
  assert.equal(dbUpdated.revertDb, true);
  const copied = plan.find((p: { migrationId: string }) => p.migrationId === "m3");
  assert.equal(copied.revertDb, false); // DB never pointed at the new key yet
});
