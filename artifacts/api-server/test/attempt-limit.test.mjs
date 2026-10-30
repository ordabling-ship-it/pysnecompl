import test from "node:test";
import assert from "node:assert/strict";
import { createAttemptWindow } from "../src/lib/attempt-limit.mjs";

test("code attempts are limited per key and recover after the window", () => {
  const limiter = createAttemptWindow({ limit: 2, windowMs: 1_000 });
  assert.equal(limiter.hit("203.0.113.8", 0).allowed, true);
  assert.equal(limiter.hit("203.0.113.8", 10).allowed, true);
  const blocked = limiter.hit("203.0.113.8", 20);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterSeconds, 1);
  assert.equal(limiter.hit("203.0.113.9", 20).allowed, true);
  assert.equal(limiter.hit("203.0.113.8", 1_000).allowed, true);
});
