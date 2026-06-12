import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveStaticTarget } from "../lib/static-files.js";

const root = resolve(tmpdir(), "history-browser-next", "public");

test("resolves files inside the public directory", () => {
  assert.equal(resolveStaticTarget(root, "/"), join(root, "index.html"));
  assert.equal(resolveStaticTarget(root, "/styles.css"), join(root, "styles.css"));
});

test("rejects path traversal outside the public directory", () => {
  assert.equal(resolveStaticTarget(root, "/../package.json"), "");
  assert.equal(resolveStaticTarget(root, "/%2e%2e/package.json"), "");
  assert.equal(resolveStaticTarget(root, "/%E0%A4%A"), "");
});
