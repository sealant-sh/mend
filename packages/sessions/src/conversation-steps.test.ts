import { LinuxIdentity } from "@mend/domain/workbench";
import { type HomeLogins, SealantPlatformError } from "@mend/sealant";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { execAnswer, fakeWorkspace } from "../test/fake-workspace.ts";
import { CONVERSATION_LINE } from "./conversation-home.ts";
import { conversationMissingWords, makeConversationSteps } from "./conversation-steps.ts";

/**
 * The hand-over's budget (docs/adr/0016, Performance, CI guards): two Core calls, DELETE then
 * POST, one stop and one start, with the staging beside the stop and the exchange the only exec
 * that waits for the old process.
 */

const alice = new LinuxIdentity({ accountId: "alice-1", name: "m3kq7xj2a", uid: 40_001 });
const bob = new LinuxIdentity({ accountId: "bob-2", name: "mb7ezq4fd", uid: 40_002 });
const SESSION = "s-shared-1";
const HOME = `/run/mend/conv/${SESSION}`;
const TRANSCRIPT = `${HOME}/.claude/projects/-workspace-repo/8f14e45f-ceea-4e7a-9c2b-1f0a7e3d2c11.jsonl`;

const harness = (
  options: {
    readonly stage?: string;
    readonly post?: (logins: HomeLogins) => SealantPlatformError | null;
  } = {},
) => {
  const calls: Array<string> = [];
  const posts: Array<{
    readonly home: string;
    readonly logins: HomeLogins;
    readonly uid: number | undefined;
  }> = [];
  const steps = makeConversationSteps({
    platform: {
      postCredentials: (_workspace, input) =>
        Effect.suspend(() => {
          calls.push(`post:${input.onBehalfOf}:${input.home}`);
          posts.push({ home: input.home, logins: input.logins, uid: input.owner?.uid });
          const failure = options.post?.(input.logins) ?? null;
          return failure === null ? Effect.succeed({ skipped: [] }) : Effect.fail(failure);
        }),
      deleteCredentials: (_workspace, input) =>
        Effect.sync(() => {
          calls.push(`delete:${input.home}`);
        }),
    },
    sealant: {
      exec: (_workspace, argv) =>
        Effect.sync(() => {
          const script = argv[2] ?? "";
          if (script.includes("mend-conv exchanged") || script.includes("exchanged %s")) {
            calls.push("exec:exchange");
            return execAnswer(`${CONVERSATION_LINE} exchanged renameat2\n`);
          }
          calls.push("exec:stage");
          return execAnswer(
            options.stage ??
              `${CONVERSATION_LINE} resume ${TRANSCRIPT}\n${CONVERSATION_LINE} empty\n`,
          );
        }),
    },
    places: { harnessHome: "/workspace/harness-home" },
  });
  return { steps, calls, posts };
};

const stop = (calls: Array<string>) =>
  Effect.sync(() => {
    calls.push("stop");
  });

const handOverTo = (
  world: ReturnType<typeof harness>,
  sender: LinuxIdentity,
  options: { readonly first?: boolean } = {},
) =>
  world.steps.handOver({
    workspace: fakeWorkspace(),
    sessionId: SESSION,
    harness: "claude",
    owner: alice,
    sender,
    providerSessionId: options.first === true ? null : "8f14e45f-ceea-4e7a-9c2b-1f0a7e3d2c11",
    model: null,
    move: options.first === true,
    stop: options.first === true ? null : stop(world.calls),
    personEnv: { MEND_SESSION_ID: SESSION },
  });

describe("the hand-over (docs/adr/0016, decision 6)", () => {
  it("costs two Core calls, DELETE then POST, one stop and the exchange after it", async () => {
    const world = harness();
    await Effect.runPromise(handOverTo(world, alice, { first: true }));
    // The first home of a session: nothing held yet, so no DELETE.
    expect(world.calls).toEqual(["exec:stage", "exec:exchange", `post:alice-1:${HOME}`]);
    world.calls.length = 0;
    const handed = await Effect.runPromise(handOverTo(world, bob));
    // The staging runs beside the stop (which says first is the scheduler's); only the two Core
    // calls and the exchange wait for the old process.
    expect(world.calls.slice(0, 2).toSorted()).toEqual(["exec:stage", "stop"]);
    expect(world.calls.slice(2)).toEqual([`delete:${HOME}`, "exec:exchange", `post:bob-2:${HOME}`]);
    expect(
      world.calls.filter((call) => call.startsWith("post:") || call.startsWith("delete:")),
    ).toHaveLength(2);
    expect(world.calls.filter((call) => call === "stop")).toHaveLength(1);
    // The sender's own login, only the harness's provider, written as them.
    expect(world.posts.at(-1)).toEqual({ home: HOME, logins: { claude: true }, uid: 40_002 });
    expect(handed.resumePath).toBe(TRANSCRIPT);
    expect(handed.env["CLAUDE_CONFIG_DIR"]).toBe(`${HOME}/.claude`);
    // And back to Alice: the same two calls, Bob's login released first.
    world.calls.length = 0;
    await Effect.runPromise(handOverTo(world, alice));
    expect(world.calls.slice(2)).toEqual([
      `delete:${HOME}`,
      "exec:exchange",
      `post:alice-1:${HOME}`,
    ]);
  });

  it("moves the conversation only after the owner's personal process has stopped", async () => {
    const world = harness();
    await Effect.runPromise(
      world.steps.handOver({
        workspace: fakeWorkspace(),
        sessionId: SESSION,
        harness: "claude",
        owner: alice,
        sender: alice,
        providerSessionId: "8f14e45f-ceea-4e7a-9c2b-1f0a7e3d2c11",
        model: null,
        move: true,
        stop: stop(world.calls),
        personEnv: {},
      }),
    );
    expect(world.calls.slice(0, 2)).toEqual(["stop", "exec:stage"]);
  });

  it("fails the turn when the conversation is missing, before any login is touched", async () => {
    const world = harness({ stage: `${CONVERSATION_LINE} missing\n${CONVERSATION_LINE} empty\n` });
    const result = await Effect.runPromise(handOverTo(world, bob).pipe(Effect.result));
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure.message).toBe(conversationMissingWords("claude"));
    }
    expect(world.calls.some((call) => call.startsWith("post:") || call.startsWith("delete:"))).toBe(
      false,
    );
    expect(world.calls).not.toContain("exec:exchange");
  });

  it("refuses a sender who has not connected the provider, with nobody else's login used", async () => {
    const world = harness({
      post: () =>
        new SealantPlatformError({
          code: "connected-account-missing",
          status: 404,
          message: 'No claude connected account matches "default"',
          provider: "claude",
          cause: null,
        }),
    });
    await Effect.runPromise(handOverTo(world, alice, { first: true }).pipe(Effect.ignore));
    const result = await Effect.runPromise(handOverTo(world, bob).pipe(Effect.result));
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure.code).toBe("person_login_refused");
      expect(result.failure.message).toBe(
        "Connect Claude to start a session here. Connect it in Settings → Connected accounts, or run mend connect claude.",
      );
    }
    // Bob's refused write was his own; Alice's login was released and never written for him.
    expect(world.calls.filter((call) => call.startsWith("post:"))).toEqual([
      `post:alice-1:${HOME}`,
      `post:bob-2:${HOME}`,
    ]);
  });

  it("releases H's login when its process exits, never a newer start's", async () => {
    const world = harness();
    await Effect.runPromise(handOverTo(world, alice, { first: true }));
    world.steps.started("workspace-1", SESSION, "process-a");
    // A hand-over to Bob is under way: Alice's process exiting now releases nothing of his.
    const handed = handOverTo(world, bob);
    await Effect.runPromise(handed);
    world.steps.started("workspace-1", SESSION, "process-b");
    world.calls.length = 0;
    await Effect.runPromise(
      world.steps.release({
        workspace: Effect.succeed(fakeWorkspace()),
        workspaceId: "workspace-1",
        sessionId: SESSION,
        processId: "process-a",
      }),
    );
    expect(world.calls).toEqual([]);
    await Effect.runPromise(
      world.steps.release({
        workspace: Effect.succeed(fakeWorkspace()),
        workspaceId: "workspace-1",
        sessionId: SESSION,
        processId: "process-b",
      }),
    );
    expect(world.calls).toEqual([`delete:${HOME}`]);
    expect(world.steps.holderOf("workspace-1", SESSION)).toBeNull();
  });
});
