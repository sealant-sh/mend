import { chmodSync, existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { openGatewayState } from "../src/state.ts";

/**
 * Review round 1, finding 8: a message id comes from the client, so the id map is keyed by the
 * Mend turn and a recorded turn is never replaced.
 */

describe("the id map", () => {
  it.effect("keeps a client's message id per turn, never across sessions or owners", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const state = yield* openGatewayState(":memory:");
        yield* state.recordTurnIds(
          { sessionId: "session-a", turnId: "turn-a", runId: "t3-run:a", messageId: "same" },
          1,
        );
        // Another person picks the same message id in their own session.
        yield* state.recordTurnIds(
          { sessionId: "session-b", turnId: "turn-b", runId: "t3-run:b", messageId: "same" },
          2,
        );
        // A second claim on a recorded turn changes nothing.
        yield* state.recordTurnIds(
          { sessionId: "session-a", turnId: "turn-a", runId: "t3-run:x", messageId: "hijack" },
          3,
        );
        const ids = yield* state.listTurnIds();
        assert.deepStrictEqual(
          ids
            .map((row) => [row.sessionId, row.turnId, row.runId, row.messageId])
            .toSorted((left, right) => String(left[0]).localeCompare(String(right[0]))),
          [
            ["session-a", "turn-a", "t3-run:a", "same"],
            ["session-b", "turn-b", "t3-run:b", "same"],
          ],
        );
      }),
    ),
  );

  it.effect("migrates a state file whose message ids were a global key", () =>
    Effect.gen(function* () {
      const path = join(mkdtempSync(join(tmpdir(), "t3-gateway-state-")), "state.sqlite");
      // A state file as migration 2 left it.
      const old = new DatabaseSync(path);
      old.exec(`
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE bearer_sessions (session_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,
          device_token TEXT NOT NULL, mend_user_id TEXT NOT NULL, mend_user_name TEXT NOT NULL,
          mend_user_email TEXT NOT NULL, mend_device_id TEXT NOT NULL, scopes TEXT NOT NULL,
          client_label TEXT, client_device_type TEXT NOT NULL, client_os TEXT,
          issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER);
        CREATE TABLE project_ids (project_id TEXT PRIMARY KEY, mend_project_id TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL);
        CREATE TABLE thread_ids (thread_id TEXT PRIMARY KEY, mend_session_id TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL);
        CREATE TABLE message_ids (message_id TEXT PRIMARY KEY, mend_session_id TEXT NOT NULL,
          mend_ref TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE (mend_session_id, mend_ref));
        CREATE TABLE run_ids (run_id TEXT PRIMARY KEY, mend_session_id TEXT NOT NULL,
          mend_turn_id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
        INSERT INTO message_ids VALUES ('kept', 'session-a', 'turn-a', 1);
        INSERT INTO run_ids VALUES ('t3-run:a', 'session-a', 'turn-a', 1);
        PRAGMA user_version = 2;
      `);
      old.close();

      const ids = yield* Effect.scoped(
        openGatewayState(path).pipe(
          Effect.tap((state) =>
            state.recordTurnIds(
              { sessionId: "session-b", turnId: "turn-b", runId: "t3-run:b", messageId: "kept" },
              2,
            ),
          ),
          Effect.flatMap((state) => state.listTurnIds()),
        ),
      );
      assert.deepStrictEqual(ids.map((row) => [row.sessionId, row.messageId]).toSorted(), [
        ["session-a", "kept"],
        ["session-b", "kept"],
      ]);
    }),
  );
});

const modeOf = (path: string) => statSync(path).mode & 0o777;

/**
 * Spec divergence 1 (t3code-gateway.md): the state file holds every paired person's Mend device
 * token, so only the gateway's own user may read it.
 */
describe("the state file's permissions", () => {
  it.effect("creates the file 0600 in a directory of its own 0700, WAL files included", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = join(mkdtempSync(join(tmpdir(), "t3-gateway-mode-")), "mend", "t3");
        const path = join(directory, "state.sqlite");
        const state = yield* openGatewayState(path);
        yield* state.recordTurnIds(
          { sessionId: "session", turnId: "turn", runId: "t3-run:1", messageId: "message" },
          1,
        );
        assert.strictEqual(modeOf(directory), 0o700);
        assert.strictEqual(modeOf(path), 0o600);
        for (const file of [`${path}-wal`, `${path}-shm`]) {
          if (existsSync(file)) assert.strictEqual(modeOf(file), 0o600, file);
        }
      }),
    ),
  );

  it.effect("narrows a file an older gateway left readable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const path = join(mkdtempSync(join(tmpdir(), "t3-gateway-mode-")), "state.sqlite");
        writeFileSync(path, "");
        chmodSync(path, 0o644);
        yield* openGatewayState(path);
        assert.strictEqual(modeOf(path), 0o600);
      }),
    ),
  );
});

describe("sequence reservations", () => {
  it.effect("start at the clock, above any sequence a gateway gave before it kept one", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const state = yield* openGatewayState(":memory:");
        const before = Date.now();
        const first = yield* state.reserveSequences(0, 1_000);
        assert.isAtLeast(first, before);
        // One mark for the whole gateway: the next reservation, any person's, starts past it.
        const second = yield* state.reserveSequences(0, 1_000);
        assert.strictEqual(second, first + 1_000);
        const asked = yield* state.reserveSequences(second + 5_000, 10);
        assert.strictEqual(asked, second + 5_000);
      }),
    ),
  );
});

/** A kept image of one byte, for a person's message. */
const keptImage = (id: string, messageId: string) => ({
  id,
  threadId: "session-1",
  messageId,
  position: 0,
  name: `${id}.png`,
  mimeType: "image/png",
  sizeBytes: 1,
  placement: null,
  bytes: new Uint8Array([1]),
});

describe("kept images", () => {
  it.effect(
    "lets go of a dropped draft's images, and keeps what a message sent or waits with",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const state = yield* openGatewayState(":memory:");
          yield* state.saveImages(
            "user-1",
            [keptImage("draft", "message-draft"), keptImage("sent", "message-sent")],
            1,
          );
          yield* state.saveImages("user-2", [keptImage("other", "message-other")], 1);
          yield* state.recordSentImages("user-1", "message-sent", [
            { imageId: "sent", path: "/workspace/harness-home/paste/a.png" },
          ]);
          // A person's own sweep touches only their images.
          assert.deepStrictEqual(yield* state.pruneImages(10, "user-1"), ["draft"]);
          assert.deepStrictEqual(
            (yield* state.listImages("user-1")).map((kept) => kept.id),
            ["sent"],
          );
          assert.deepStrictEqual(yield* state.pruneImages(10, null), ["other"]);
          assert.deepStrictEqual(
            (yield* state.listSentImages("user-1"))
              .get("message-sent")
              ?.map((sent) => sent.imageId),
            ["sent"],
          );
        }),
      ),
  );
});
