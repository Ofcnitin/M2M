import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Static source assertions for the v7 §7 reader contract (no DOM in unit tests).
const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "components", "Reader.tsx"), "utf8");

test("strip container is full width (w-full) with data-reader-strip hook", () => {
  assert.match(src, /data-reader-strip/);
  assert.match(src, /data-reader-strip className=\{`w-full /);
});

test("width cap is applied only at >=sm (640px) via inline media query, not a max-w class below sm", () => {
  // The only width cap for the strip lives inside the min-width:640px media query.
  assert.match(src, /@media \(min-width: 640px\)\{\[data-reader-strip\]\{max-width:var\(--reader-max\);margin-inline:auto\}\}/);
  // Strip container itself carries no max-w-* utility class.
  const stripLine = src.split("\n").find((l) => l.includes("data-reader-strip")) ?? "";
  assert.ok(!/max-w-/.test(stripLine), `strip line must not cap width: ${stripLine}`);
});

test("strip images are w-full h-auto block", () => {
  assert.match(src, /className=\{`block \$\{fit === "screen" \? "" : "h-auto w-full"\}`\}/);
  assert.match(src, /width: "100%", height: "auto", display: "block"/);
});

test("gap defaults to false in DEFAULTS and gap-0 is the default strip class", () => {
  assert.match(src, /const DEFAULTS: Settings = \{ width: "medium", bg: "theme", gap: false, fit: "width" \}/);
  assert.match(src, /cfg\.gap \? "grid gap-2" : "grid gap-0"/);
});

test("strip pages use content-visibility for lazy rendering cost", () => {
  assert.match(src, /contentVisibility: "auto"/);
  assert.match(src, /containIntrinsicSize/);
});

test("page mode is present and distinct from vertical strip", () => {
  assert.match(src, /view === "p"/);
  assert.match(src, /maxWidth: cfg\.fit === "screen" \? undefined : Math\.min\(maxW, 720\)/);
  assert.match(src, /touchAction: "pan-y"/);
});
