import test from "node:test";
import assert from "node:assert/strict";
import { createCleanupOnce } from "../lib/cleanup.js";

test("shares one cleanup promise across concurrent callers", async () => {
  let releases;
  let calls = 0;
  const cleanup = createCleanupOnce(async () => {
    calls += 1;
    await new Promise((resolve) => {
      releases = resolve;
    });
  });

  const first = cleanup();
  const second = cleanup();
  assert.equal(first, second);
  assert.equal(calls, 0);
  await Promise.resolve();
  assert.equal(calls, 1);
  releases();
  await Promise.all([first, second]);
});
