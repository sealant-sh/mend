import {
  CommandId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  ThreadId,
  WS_METHODS,
  type ServerProvider,
} from "@mend/t3-contracts";
import * as Effect from "effect/Effect";

import { deliveredSkills, skillInvocationOf } from "../src/skills.ts";
import { assert, describe, it } from "./support/effect-vitest.ts";
import { startFakeMend, type FakeMend } from "./support/fake-mend.ts";
import type { FakeSkill } from "./support/fake-workbench.ts";
import { feed } from "./support/feed.ts";
import { gatewayTestLayer } from "./support/gateway.ts";
import { pairAndConnect } from "./support/rpc.ts";

const withGateway = <A, E, R>(test: (mend: FakeMend) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const mend = yield* startFakeMend;
    return yield* test(mend).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
  });

const WORKTREE = "/var/lib/mend/store/project-1/worktrees/wt-session-1";
const user = (name: string, description = ""): FakeSkill => ({ scope: "user", name, description });
const project = (name: string, description = ""): FakeSkill => ({
  scope: "project",
  name,
  description,
});

interface ListedSkill {
  readonly name: string;
  readonly scope: string | null;
  readonly path: string;
}

interface ProviderSkillsAt {
  readonly instanceId: string;
  readonly skills: ReadonlyArray<ListedSkill> | null;
}

const snapshotSkills = (
  providers: ReadonlyArray<ServerProvider>,
  cwd: string,
): ReadonlyArray<ProviderSkillsAt> =>
  providers.map((provider) => ({
    instanceId: String(provider.instanceId),
    skills:
      provider.workspaceSnapshots
        ?.find((snapshot) => snapshot.cwd === cwd)
        ?.skills.map((skill) => ({
          name: skill.name,
          scope: skill.scope ?? null,
          path: skill.path,
        })) ?? null,
  }));

let commands = 0;
const send = (threadId: string, messageId: string, text: string) =>
  ({
    type: "message.dispatch",
    commandId: CommandId.make(`skill-command-${++commands}`),
    createdBy: "user",
    creationSource: "web",
    threadId: ThreadId.make(threadId),
    messageId: MessageId.make(messageId),
    text,
    attachments: [],
    dispatchMode: { type: "queue_after_active" },
  }) as const;

const eventually = (condition: () => boolean, what: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (condition()) return;
      yield* Effect.sleep("50 millis");
    }
    return yield* Effect.die(new Error(`Timed out waiting for ${what}.`));
  });

const turnInputs = (mend: FakeMend) =>
  mend.workbench.calls
    .filter((call) => call.method === "POST" && call.path.endsWith("/turns"))
    .map((call) =>
      typeof call.body === "object" && call.body !== null && "input" in call.body
        ? call.body.input
        : null,
    );

describe("a skill as each harness invokes it", () => {
  const names = new Set(["review", "ship"]);

  it("Codex reads `$name`, whatever sigil was typed", () => {
    assert.strictEqual(
      skillInvocationOf("codex", "€review the parser", names),
      "$review the parser",
    );
    assert.strictEqual(skillInvocationOf("codex", "costs $5 today", names), "costs $5 today");
  });

  it("Claude expands one leading `/name`, the rest of the message its arguments", () => {
    assert.strictEqual(
      skillInvocationOf("claude", "$review the parser", names),
      "/review the parser",
    );
    assert.strictEqual(
      skillInvocationOf("claude", "please $review the parser", names),
      "/review please the parser",
    );
    assert.strictEqual(
      skillInvocationOf("claude", "$review it, then $ship", names),
      "/ship /review it, then",
    );
    assert.strictEqual(skillInvocationOf("claude", "echo $HOME", names), "echo $HOME");
  });

  it("the project's skill wins over the person's of the same name", () => {
    assert.deepStrictEqual(
      deliveredSkills([user("review", "mine"), user("notes")], [project("review", "the team's")]),
      [project("review", "the team's"), user("notes")],
    );
  });
});

describe("skills in t3code's composer", () => {
  it.live("lists a workspace's skills on a refresh for its cwd, and keeps them in the feed", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.addSession({ id: "session-1", projectId: "project-1", harness: "claude" });
        mend.workbench.userSkills.set("user-1", [user("notes", "My notes"), user("review")]);
        mend.workbench.projectSkills.set("project-1", [project("review", "Review a change")]);
        const { rpc } = yield* pairAndConnect(mend, "SKILLS");
        const config = yield* feed(rpc[WS_METHODS.subscribeServerConfig]({}));
        yield* config.next(
          (event): event is Extract<typeof event, { type: "snapshot" }> =>
            event.type === "snapshot",
        );

        const refreshed = yield* rpc[WS_METHODS.serverRefreshProviders]({ cwd: WORKTREE });
        const expected: ReadonlyArray<ProviderSkillsAt> = [
          {
            instanceId: "claudeAgent",
            skills: [
              { name: "notes", scope: "user", path: "~/.claude/skills/notes/SKILL.md" },
              { name: "review", scope: "project", path: "~/.claude/skills/review/SKILL.md" },
            ],
          },
          {
            instanceId: "codex",
            skills: [
              { name: "notes", scope: "user", path: "~/.codex/skills/notes/SKILL.md" },
              { name: "review", scope: "project", path: "~/.codex/skills/review/SKILL.md" },
            ],
          },
        ];
        assert.deepStrictEqual(snapshotSkills(refreshed.providers, WORKTREE), expected);
        const claude = refreshed.providers[0]?.workspaceSnapshots?.[0];
        assert.strictEqual(claude?.skills[1]?.description, "Review a change");
        assert.deepStrictEqual(claude?.slashCommands, []);
        assert.notStrictEqual(claude?.slashCommandsPending, true);

        const pushed = yield* config.next(
          (event): event is Extract<typeof event, { type: "providerStatuses" }> =>
            event.type === "providerStatuses",
        );
        assert.deepStrictEqual(snapshotSkills(pushed.payload.providers, WORKTREE), expected);
        const later = yield* rpc[WS_METHODS.serverGetConfig]({});
        assert.deepStrictEqual(snapshotSkills(later.providers, WORKTREE), expected);
      }),
    ),
  );

  it.live(
    "answers an empty snapshot for a cwd that is none of the person's, so it is not asked again",
    () =>
      withGateway((mend) =>
        Effect.gen(function* () {
          mend.workbench.addProject("project-1", "mend");
          const { rpc } = yield* pairAndConnect(mend, "SKILLS-ELSEWHERE");
          const refreshed = yield* rpc[WS_METHODS.serverRefreshProviders]({
            cwd: "/tmp/elsewhere",
          });
          assert.deepStrictEqual(snapshotSkills(refreshed.providers, "/tmp/elsewhere"), [
            { instanceId: "claudeAgent", skills: [] },
            { instanceId: "codex", skills: [] },
          ]);
          const later = yield* rpc[WS_METHODS.serverGetConfig]({});
          assert.deepStrictEqual(snapshotSkills(later.providers, "/tmp/elsewhere"), [
            { instanceId: "claudeAgent", skills: null },
            { instanceId: "codex", skills: null },
          ]);
        }),
      ),
  );

  it.live("leaves out the person's skills where the project does not inherit them", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
        mend.workbench.skillsNotInherited.add("project-1");
        mend.workbench.userSkills.set("user-1", [user("notes")]);
        mend.workbench.projectSkills.set("project-1", [project("review")]);
        const { rpc } = yield* pairAndConnect(mend, "SKILLS-OWN");
        const refreshed = yield* rpc[WS_METHODS.serverRefreshProviders]({ cwd: WORKTREE });
        assert.deepStrictEqual(
          refreshed.providers[1]?.workspaceSnapshots?.[0]?.skills.map((skill) => skill.name),
          ["review"],
        );
      }),
    ),
  );

  it.live("sends a picked skill to Claude as `/name` and to Codex as `$name`", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.addSession({ id: "session-1", projectId: "project-1", harness: "claude" });
        mend.workbench.addSession({ id: "session-2", projectId: "project-1", harness: "codex" });
        mend.workbench.projectSkills.set("project-1", [project("review")]);
        const { rpc } = yield* pairAndConnect(mend, "SKILLS-SEND");
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](
          send("session-1", "message-claude", "please $review the parser"),
        );
        yield* eventually(() => turnInputs(mend).length === 1, "Claude's turn");
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](
          send("session-2", "message-codex", "£review the build"),
        );
        yield* eventually(() => turnInputs(mend).length === 2, "Codex's turn");
        assert.deepStrictEqual(turnInputs(mend), [
          "/review please the parser",
          "$review the build",
        ]);
      }),
    ),
  );
});
