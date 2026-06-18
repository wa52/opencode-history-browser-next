import test from "node:test";
import assert from "node:assert/strict";
import { createSession, sessionWorkspaceRoot } from "../lib/opencode-session.js";

test("createSession binds explicit workspace root into query and metadata", async () => {
  let received;
  const api = {
    client: {
      session: {
        create(parameters) {
          received = parameters;
          return Promise.resolve({ data: { id: "ses_new" } });
        },
      },
    },
  };

  const created = await createSession(api, {
    title: "New chat",
    directory: "D:/workspace/project-a",
    metadata: { createdFrom: "browser-new-chat" },
  });

  assert.deepEqual(created, { id: "ses_new" });
  assert.equal(received.title, "New chat");
  assert.equal(received.directory, "D:/workspace/project-a");
  assert.deepEqual(received.metadata, {
    createdFrom: "browser-new-chat",
    workspaceRoot: "D:/workspace/project-a",
  });
});

test("sessionWorkspaceRoot prefers explicit metadata and falls back to directory", () => {
  assert.equal(
    sessionWorkspaceRoot({
      directory: "D:/workspace/fallback",
      metadata: { workspaceRoot: "D:/workspace/explicit" },
    }),
    "D:/workspace/explicit",
  );

  assert.equal(
    sessionWorkspaceRoot({
      directory: "D:/workspace/fallback",
    }),
    "D:/workspace/fallback",
  );
});
