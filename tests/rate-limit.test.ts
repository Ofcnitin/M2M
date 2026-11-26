import { test } from "node:test";
import assert from "node:assert/strict";
import { rateLimit, clientKey, resetRateLimits } from "../src/lib/rate-limit";

test("allows up to the limit then blocks with retry-after", () => {
  resetRateLimits();
  const opts = { limit: 3, windowMs: 10_000 };
  const t0 = 1_000_000;
  assert.equal(rateLimit("k1", opts, t0).ok, true);
  assert.equal(rateLimit("k1", opts, t0 + 1).ok, true);
  assert.equal(rateLimit("k1", opts, t0 + 2).ok, true);
  const blocked = rateLimit("k1", opts, t0 + 3);
  assert.equal(blocked.ok, false);
  assert.ok(blocked.retryAfterSeconds >= 1 && blocked.retryAfterSeconds <= 10);
});

test("window expiry frees capacity", () => {
  resetRateLimits();
  const opts = { limit: 1, windowMs: 1000 };
  assert.equal(rateLimit("k2", opts, 5000).ok, true);
  assert.equal(rateLimit("k2", opts, 5500).ok, false);
  assert.equal(rateLimit("k2", opts, 6001).ok, true);
});

test("keys are independent", () => {
  resetRateLimits();
  const opts = { limit: 1, windowMs: 1000 };
  assert.equal(rateLimit("a", opts, 0).ok, true);
  assert.equal(rateLimit("b", opts, 0).ok, true);
  assert.equal(rateLimit("a", opts, 0).ok, false);
});

test("clientKey uses first x-forwarded-for hop, falls back safely", () => {
  const req = new Request("https://example.com", { headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" } });
  assert.equal(clientKey(req), "203.0.113.7");
  const req2 = new Request("https://example.com", { headers: { "x-real-ip": "198.51.100.2" } });
  assert.equal(clientKey(req2), "198.51.100.2");
  assert.equal(clientKey(new Request("https://example.com")), "unknown");
});
