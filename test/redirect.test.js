import test from "node:test";
import assert from "node:assert/strict";
import { buildBackupForwarder, hasForeignHistoryRedirect, ownsRedirect } from "../lib/redirect.js";
import { REDIRECT_MARKER } from "../lib/identity.js";

test("detects legacy redirect ownership conflicts", () => {
  assert.equal(hasForeignHistoryRedirect("REM OPENCODE_HISTORY_BROWSER_REDIRECT", REDIRECT_MARKER), true);
  assert.equal(hasForeignHistoryRedirect(`REM ${REDIRECT_MARKER}`, REDIRECT_MARKER), false);
  assert.equal(hasForeignHistoryRedirect("@ECHO off", REDIRECT_MARKER), false);
});

test("restores only wrappers owned by the next edition", () => {
  assert.equal(ownsRedirect(`# ${REDIRECT_MARKER}`, REDIRECT_MARKER), true);
  assert.equal(ownsRedirect("# changed by another installer", REDIRECT_MARKER), false);
  assert.equal(ownsRedirect("", REDIRECT_MARKER), false);
});

test("rebuilds missing Windows backups as direct CLI forwarders", () => {
  const executable = "C:\\Tools\\opencode.exe";
  assert.equal(buildBackupForwarder(".cmd", executable), '@ECHO off\r\n"C:\\Tools\\opencode.exe" %*\r\n');
  assert.equal(
    buildBackupForwarder(".ps1", executable),
    '& "C:\\Tools\\opencode.exe" @args\r\nexit $LASTEXITCODE\r\n',
  );
});
