import { test } from "node:test";
import assert from "node:assert/strict";
import { dimensions } from "../workers/processor/src/image";

const pad = (a: number[], n = 64) => Uint8Array.from([...a, ...new Array(Math.max(0, n - a.length)).fill(0)]);
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

test("png", () => {
  const png = pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...be32(800), ...be32(1200)]);
  assert.deepEqual(dimensions(png), { w: 800, h: 1200, mime: "image/png" });
});
test("jpeg reads the start-of-frame segment, skipping other segments", () => {
  const h = 3000, w = 900;
  const jpg = pad([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0), 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 3]);
  assert.deepEqual(dimensions(jpg), { w, h, mime: "image/jpeg" });
});
test("webp lossy (VP8 )", () => {
  const b = pad([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20, 0, 0, 0, 0, 0, 0, 0, 0x9d, 0x01, 0x2a, 640 & 255, 640 >> 8, 480 & 255, 480 >> 8]);
  assert.deepEqual(dimensions(b), { w: 640, h: 480, mime: "image/webp" });
});
test("webp extended (VP8X) stores width-1 and height-1", () => {
  const w = 1080 - 1, h = 5000 - 1;
  const b = pad([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58, 10, 0, 0, 0, 0, 0, 0, 0, w & 255, (w >> 8) & 255, (w >> 16) & 255, h & 255, (h >> 8) & 255, (h >> 16) & 255]);
  assert.deepEqual(dimensions(b), { w: 1080, h: 5000, mime: "image/webp" });
});
test("rejects unknown and truncated data without throwing", () => {
  assert.equal(dimensions(pad([1, 2, 3, 4])), null);
  assert.equal(dimensions(Uint8Array.from([0x89, 0x50, 0x4e, 0x47])), null); // would make DataView throw
  assert.equal(dimensions(new Uint8Array(0)), null);
});

import { inspect } from "../workers/processor/src/image";
test("jpeg with a large metadata segment asks for more bytes instead of failing", () => {
  const app1 = [0xff, 0xe1, 0x40, 0x00]; // declares a 16 KB EXIF segment
  const head = pad([0xff, 0xd8, ...app1], 64);
  const r = inspect(head);
  assert.equal(r.status, "need_more");
  const full = new Uint8Array(0x4000 + 2 + 2 + 40);
  full.set([0xff, 0xd8, ...app1], 0);
  full.set([0xff, 0xc0, 0x00, 0x11, 0x08, 0x0b, 0xb8, 0x03, 0x84, 3], 2 + 2 + 0x4000);
  assert.deepEqual(inspect(full), { status: "ok", w: 900, h: 3000, mime: "image/jpeg" });
});
test("png needs the full signature and IHDR; html is invalid", () => {
  assert.equal(inspect(pad([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])).status, "invalid");
  assert.equal(inspect(new TextEncoder().encode("<html><script>alert(1)</script></html>......")).status, "invalid");
});
test("jpeg reaching end-of-image with no frame header is invalid", () => {
  assert.equal(inspect(pad([0xff, 0xd8, 0xff, 0xd9], 40)).status, "invalid");
});
