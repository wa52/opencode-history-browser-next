import test from "node:test";
import assert from "node:assert/strict";
import { parseSnapshotText } from "../public/browser-snapshot-view.js";

test("parses mixed snapshot sections and groups for browser rendering", () => {
  const parsed = parseSnapshotText(`
# Context Snapshot

## Goal
- [M1] Continue the previous task

## Structured Memory
### Decisions And Constraints
- [M2] Use promptAsync
### Errors And Risks
- [M3] MessageAbortedError: Aborted
`);

  assert.equal(parsed.title, "Context Snapshot");
  assert.equal(parsed.sections[0].title, "Goal");
  assert.equal(parsed.sections[0].items[0], "[M1] Continue the previous task");
  assert.equal(parsed.sections[1].title, "Structured Memory");
  assert.equal(parsed.sections[1].groups[0].title, "Decisions And Constraints");
  assert.equal(parsed.sections[1].groups[1].items[0], "[M3] MessageAbortedError: Aborted");
});
