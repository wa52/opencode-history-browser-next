import test from "node:test";
import assert from "node:assert/strict";
import { createSession, getSession, sessionWorkspaceRoot } from "../lib/opencode-session.js";

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

test("getSession keeps browser rendering alive when message errors exist", async () => {
  const api = {
    client: {
      session: {
        get() {
          return Promise.resolve({
            data: {
              id: "ses_1",
              title: "Chat",
              directory: "D:/workspace/project-a",
              time: { created: 1, updated: 2 },
              metadata: { workspaceRoot: "D:/workspace/project-a" },
              tokens: { input: 0, output: 0 },
              summary: {},
            },
          });
        },
        messages() {
          return Promise.resolve({
            data: [{
              info: {
                id: "msg_1",
                role: "assistant",
                error: { message: "MessageAbortedError: Aborted" },
                time: { created: 3, completed: 4 },
              },
              parts: [],
            }],
          });
        },
        todo() {
          return Promise.resolve({ data: [] });
        },
      },
    },
  };

  const session = await getSession(api, "ses_1");

  assert.equal(session.id, "ses_1");
  assert.equal(session.messages.length, 1);
  assert.equal(session.messages[0].aborted, true);
  assert.equal(session.messages[0].error, "");
});
