function hasForeignHistoryRedirect(content, ownMarker) {
  return /OPENCODE_HISTORY_BROWSER(?:_NEXT)?_REDIRECT/.test(content) &&
    !String(content).includes(ownMarker);
}

function ownsRedirect(content, ownMarker) {
  return String(content).includes(ownMarker);
}

function buildBackupForwarder(extension, executable) {
  if (extension === ".cmd") {
    return `@ECHO off\r\n"${executable}" %*\r\n`;
  }
  return `& "${executable}" @args\r\nexit $LASTEXITCODE\r\n`;
}

export { buildBackupForwarder, hasForeignHistoryRedirect, ownsRedirect };
