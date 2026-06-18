function createPromptController({
  $,
  getCurrent,
  isSending,
  promptPollMs,
  promptMaxWaitMs,
  promptStableFallbackTicks,
  refreshCurrentSession,
  setComposerStatus,
}) {
  let promptWatcher = null;
  let activePromptSessionID = null;

  function messageSignature(session) {
    return (session?.messages || [])
      .slice(-6)
      .map((message) => `${message.role}:${message.id}:${message.created}:${message.completed || 0}:${message.error || ""}:${(message.text || "").length}:${JSON.stringify(message.activities || []).length}`)
      .join("|");
  }

  function sessionStateSignature(session) {
    return `${session?.updated || 0}:${session?.title || ""}:${session?.model || ""}:${session?.tokensInput || 0}:${session?.tokensOutput || 0}:${JSON.stringify(session?.todos || []).length}:${messageSignature(session)}`;
  }

  function hasNewAssistantMessage(session, startedAt) {
    return (session?.messages || []).some((message) => (
      message.role !== "user" && message.text && (!message.created || message.created >= startedAt - 1000)
    ));
  }

  function lastRole(session) {
    const messages = (session?.messages || []).filter((message) => message.text || message.extras?.length);
    return messages[messages.length - 1]?.role || "";
  }

  function completedAssistantMessage(session, startedAt) {
    return [...(session?.messages || [])].reverse().find((message) => (
      message.role !== "user" && (message.completed || message.error) && (!message.created || message.created >= startedAt - 1000)
    ));
  }

  function clearPromptWatcher() {
    if (!promptWatcher) return;
    window.clearInterval(promptWatcher);
    promptWatcher = null;
    activePromptSessionID = null;
    if (!isSending()) $("sendBtn").textContent = "Send";
  }

  function watchPrompt(sessionID, beforeSignature) {
    clearPromptWatcher();
    activePromptSessionID = sessionID;
    $("sendBtn").disabled = false;
    $("sendBtn").textContent = "Stop";
    const startedAt = Date.now();
    let lastSignature = beforeSignature;
    let stableTicks = 0;
    let sawAssistant = false;
    let failureCount = 0;
    promptWatcher = window.setInterval(async () => {
      if (getCurrent()?.id !== sessionID) return clearPromptWatcher();
      if (Date.now() - startedAt > promptMaxWaitMs) {
        setComposerStatus("");
        return clearPromptWatcher();
      }
      try {
        await refreshCurrentSession({ force: true, refreshList: true });
        failureCount = 0;
        const current = getCurrent();
        const signature = messageSignature(current);
        const finalAssistant = completedAssistantMessage(current, startedAt);
        if (hasNewAssistantMessage(current, startedAt) || (signature !== beforeSignature && lastRole(current) !== "user")) {
          sawAssistant = true;
          setComposerStatus(finalAssistant?.error ? "OpenCode returned an error" : "OpenCode is responding...");
        }
        stableTicks = sawAssistant && signature === lastSignature ? stableTicks + 1 : 0;
        lastSignature = signature;
        if (finalAssistant || (sawAssistant && stableTicks >= promptStableFallbackTicks)) {
          setComposerStatus("");
          clearPromptWatcher();
        }
      } catch (error) {
        failureCount += 1;
        if (failureCount >= 8) {
          setComposerStatus(error.message || "Browser sync was interrupted. OpenCode may still be running.");
          clearPromptWatcher();
        }
      }
    }, promptPollMs);
  }

  return {
    clearPromptWatcher,
    getActivePromptSessionID: () => activePromptSessionID,
    isWatching: () => Boolean(promptWatcher),
    messageSignature,
    sessionStateSignature,
    watchPrompt,
  };
}

export { createPromptController };
