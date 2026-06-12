import test from "node:test";
import assert from "node:assert/strict";
import { createWriteQueue } from "../lib/write-queue.js";

test("continues writing after a failed write", async () => {
  const written = [];
  let attempts = 0;
  const queue = createWriteQueue(async (value) => {
    attempts += 1;
    if (attempts === 1) throw new Error("expected failure");
    written.push(value);
  });

  await assert.rejects(queue.enqueue({ value: 1 }), /expected failure/);
  await queue.enqueue({ value: 2 });
  await queue.flush();
  assert.deepEqual(written, [{ value: 2 }]);
});
