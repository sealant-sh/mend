import { SealantWorkspaceId, SessionId } from "@mend/domain";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SessionsRepo } from "../src/repos/agent-sessions.ts";
import { createLivePeopleFixture, OTHER } from "./session-live-people-fixture.ts";

const { postgres, run, setup, teardown } = createLivePeopleFixture();

describe.skipIf(postgres.skip)("the people live in a session's executor, in Postgres", () => {
  beforeAll(setup);
  afterAll(teardown);

  it("lists each person live in a per-person executor once, by name, and nobody in a shared one", async () => {
    const result = await run(
      Effect.gen(function* () {
        const sessions = yield* SessionsRepo;
        const listed = yield* sessions.listActiveView();
        const view = yield* sessions.viewById(SessionId.make("s-maria"));
        const plain = yield* sessions.byId(SessionId.make("s-maria"));
        return { listed, view, plain };
      }),
    );
    const people = Object.fromEntries(
      result.listed.map((session) => [
        session.id,
        session.livePeople.map((person) => [person.accountId, person.name]),
      ]),
    );
    expect(people).toEqual({
      "s-alice": [
        ["alice", "Alice"],
        ["maria", "a member"],
      ],
      "s-maria": [
        ["alice", "Alice"],
        ["maria", "a member"],
      ],
      "s-carol": [],
    });
    expect(result.view.livePeople.map((person) => person.accountId)).toEqual(["alice", "maria"]);
    // A person with no name is "a member": their email is not shown to whoever reads the list.
    expect(
      result.listed.flatMap((session) => session.livePeople.map((person) => person.name)),
    ).not.toContain("maria@example.com");
    // Nothing retires: no state, in the list or the view.
    expect(result.listed.every((session) => session.workspaceRetirement === null)).toBe(true);
    // Every other read leaves it empty.
    expect(result.plain.livePeople).toEqual([]);
  });

  it("says a session's executor waits to be replaced, in the same query", async () => {
    const state = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          INSERT INTO executor_retirements (workspace_id, worktree_id, session_id, pre_release, state)
          VALUES ('ws-shared', ${OTHER}, 's-carol', true, 'marked')`;
        const sessions = yield* SessionsRepo;
        const view = yield* sessions.viewById(SessionId.make("s-carol"));
        const listed = yield* sessions.listActiveView();
        yield* sql`DELETE FROM executor_retirements WHERE workspace_id = 'ws-shared'`;
        return {
          view: view.workspaceRetirement,
          listed: listed.map((session) => [session.id, session.workspaceRetirement]),
        };
      }),
    );
    expect(state.view).toBe("marked");
    expect(Object.fromEntries(state.listed)).toEqual({
      "s-alice": null,
      "s-maria": null,
      "s-carol": "marked",
    });
  });

  it("names who launched a session's executor, a joined session included, in the same query", async () => {
    const launchers = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // Alice's launch made ws-person and Maria joined it (no launch of her own); Carol made hers.
        yield* sql`
          UPDATE agent_sessions SET executor_launch_id = id, executor_started_at = now()
          WHERE id IN ('s-alice', 's-carol')`;
        const sessions = yield* SessionsRepo;
        const listed = yield* sessions.listActiveView();
        const view = yield* sessions.viewById(SessionId.make("s-maria"));
        const plain = yield* sessions.byId(SessionId.make("s-maria"));
        // The batched read the API fills plain reads with: the same rule, by workspace.
        const batched = yield* sessions.launchersOf([
          SealantWorkspaceId.make("ws-person"),
          SealantWorkspaceId.make("ws-shared"),
          SealantWorkspaceId.make("ws-nobody"),
        ]);
        yield* sql`
          UPDATE agent_sessions SET executor_launch_id = NULL, executor_started_at = NULL
          WHERE id IN ('s-alice', 's-carol')`;
        return {
          listed: Object.fromEntries(
            listed.map((session) => [session.id, session.workspaceLauncherUserId]),
          ),
          view: view.workspaceLauncherUserId,
          plain: plain.workspaceLauncherUserId,
          batched: Object.fromEntries(batched),
        };
      }),
    );
    expect(launchers.listed).toEqual({
      "s-alice": "alice",
      "s-maria": "alice",
      "s-carol": "carol",
    });
    expect(launchers.view).toBe("alice");
    // The plain read leaves it empty; the API fills it from the batched read.
    expect(launchers.plain).toBeNull();
    expect(launchers.batched).toEqual({ "ws-person": "alice", "ws-shared": "carol" });
  });
});
