import test from "node:test";
import assert from "node:assert/strict";
import {
  KV_PREFIX,
  LOCK_FILE,
  LOG_FILE,
  PLUGIN_ID,
  REPOSITORY_SPEC,
} from "../lib/identity.js";

test("next project has an independent identity", () => {
  assert.equal(PLUGIN_ID, "opencode-history-browser-next");
  assert.equal(REPOSITORY_SPEC, "github:wa52/opencode-history-browser-next");
  assert.match(KV_PREFIX, /next/);
  assert.match(LOCK_FILE, /next/);
  assert.match(LOG_FILE, /next/);
});
