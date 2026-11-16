import { createHash } from "node:crypto";

import { makeHarnessLayoutsMemoryState } from "@mend/db";
import { ProjectId, type SessionId } from "@mend/domain";
import type { SessionProcess } from "@mend/domain/workbench";
import { type PersonSessionOptions, SealantPlatformError } from "@mend/sealant";
import { ProtocolHost, SessionEngine } from "@mend/sessions";
import type { CreateOptions, SessionOptions } from "@sealant/sdk";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { HARNESS_HOME_MOUNT_PATH } from "../src/harness-state.ts";
import { makeMemoryCaptureStore } from "./capture-store-memory.ts";
import { commandOf } from "./engine-person-runtime-fixtures.ts";
import {
  pickedUpWrites,
  recordingProtocolHostLayer,
  sealantLaunchLayer,
  setup,
  withEngine,
} from "./engine/fixture.ts";
import { LAYOUT_READY, isPrepare, personPlatform } from "./engine/person-fixture.ts";
import { makeImportedConversationsMemory } from "./imported-conversations-memory.ts";

// Ordinary trigger: a person moving from T3 Code imported a Claude thread into a session, and now
// sends that session its first message. The conversation must be in the agent's home, rewritten
// for this workspace, before the agent resumes it by its own id; and only that once.
const NATIVE = "0f9c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f";
const SOURCE_DIR = "-home-ada-src-shop";
const transcript = (checkout: string) =>
  [
    {
      type: "user",
      sessionId: NATIVE,
      uuid: "u1",
      parentUuid: null,
      cwd: checkout,
      message: { role: "user", content: "Why does the cart total round down?" },
    },
    {
      type: "assistant",
      sessionId: NATIVE,
      uuid: "a1",
      parentUuid: "u1",
      message: {
        id: "msg_1",
        role: "assistant",
        content: [{ type: "text", text: `${checkout}/cart.ts truncates cents.` }],
      },
    },
  ]
    .map((record) => JSON.stringify(record))
    .join("\n") + "\n";
// Not UTF-8: a screenshot a tool saved travels byte for byte.
const SHOT = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x80]);

const seedImport = (
  memory: ReturnType<typeof makeImportedConversationsMemory>,
  sessionId: SessionId,
  projectId: string,
) => {
  const files = [
    {
      relativePath: `.claude/projects/${SOURCE_DIR}/${NATIVE}.jsonl`,
      bytes: new TextEncoder().encode(transcript("/home/ada/src/shop")),
    },
    { relativePath: `.claude/projects/${SOURCE_DIR}/${NATIVE}/tool-results/shot.png`, bytes: SHOT },
  ];
  memory.rows.set(sessionId, {
    row: {
      sessionId,
      projectId: ProjectId.make(projectId),
      ownerUserId: "user-fixture",
      harness: "claude",
      nativeId: NATIVE,
      source: { checkout: "/home/ada/src/shop", home: "/home/ada" },
      files: files.map((file) => ({
        relativePath: file.relativePath,
        byteLength: file.bytes.byteLength,
        sha256: createHash("sha256").update(file.bytes).digest("hex"),
      })),
      byteLength: files.reduce((total, file) => total + file.bytes.byteLength, 0),
      permissionMode: "ask",
      deliveredAt: null,
    },
    bytes: files,
  });
};

/** What the workspace file writer put where, through its pickup tickets. */
const writtenFiles = (execCalls: ReadonlyArray<ReadonlyArray<string>>): Map<string, Buffer> => {
  const files = new Map<string, Buffer>();
  for (const argv of execCalls)
    for (const file of pickedUpWrites.get(argv) ?? [])
      files.set(file.path, Buffer.from(file.base64, "base64"));
  return files;
};

const HOME = HARNESS_HOME_MOUNT_PATH;
const DELIVERED = `${HOME}/.claude/projects/-workspace-repo/${NATIVE}.jsonl`;
const DELIVERED_SHOT = `${HOME}/.claude/projects/-workspace-repo/${NATIVE}/tool-results/shot.png`;

const engineWith = () => {
  const memory = makeImportedConversationsMemory();
  const created: CreateOptions[] = [];
  const spawned: ReadonlyArray<string>[] = [];
  const execCalls: ReadonlyArray<string>[] = [];
  const attached: Array<{ readonly process: SessionProcess; readonly mode: string }> = [];
  const permissionModes: Array<"bypass" | "ask"> = [];
  // The capture store, which handoffs need: the session's workspace mounts nothing, and every
  // file reaches it through the session's own channel.
  const options = {
    captured: makeMemoryCaptureStore(),
    importedConversations: memory,
    sealantLayer: sealantLaunchLayer(
      created,
      undefined,
      undefined,
      spawned,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      execCalls,
    ),
    protocolHostLayer: recordingProtocolHostLayer(attached, [], [], permissionModes),
  };
  return { memory, spawned, execCalls, attached, permissionModes, options };
};

describe("an imported conversation at its session's first launch", () => {
  it("is written into the agent's home for this workspace, resumed by its own id, and delivered once", async () => {
    const world = engineWith();
    await withEngine(
      (state, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, state);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "claude",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            start: { kind: "base", base: null },
          });
          seedImport(world.memory, session.id, project.id);

          yield* engine.launchProtocol(session.id, { mode: "protocol" }, "user-fixture");

          const written = writtenFiles(world.execCalls);
          const delivered = written.get(DELIVERED)?.toString("utf8") ?? "";
          // The checkout and the project folder moved to this workspace's; nothing of the
          // person's machine is left in the transcript.
          expect(delivered).toContain("/workspace/repo/cart.ts truncates cents.");
          expect(delivered).toContain('"cwd":"/workspace/repo"');
          expect(delivered).not.toContain("/home/ada");
          expect([...(written.get(DELIVERED_SHOT) ?? [])]).toEqual([...SHOT]);
          // The agent resumes the conversation by its own id, in the mode it ran in.
          const argv = world.spawned[0]?.slice(4) ?? [];
          expect(argv[argv.indexOf("--resume") + 1]).toBe(NATIVE);
          expect(world.attached[0]?.process.providerSessionId).toBe(NATIVE);
          expect(world.permissionModes).toEqual(["ask"]);
          expect(world.memory.rows.get(session.id)?.row.deliveredAt).not.toBeNull();

          // A relaunch resumes the session's own saved state: the import is not written again.
          yield* engine.stop(session.id);
          world.execCalls.length = 0;
          yield* engine.launchProtocol(session.id, { mode: "protocol" }, "user-fixture");
          expect(writtenFiles(world.execCalls).has(DELIVERED)).toBe(false);
          expect(world.attached).toHaveLength(2);
        }),
      world.options,
    );
  });

  it("is refused in a terminal before its first message, and stays undelivered", async () => {
    const world = engineWith();
    await withEngine(
      (state, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, state);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "claude",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            start: { kind: "base", base: null },
          });
          seedImport(world.memory, session.id, project.id);

          const refused = yield* engine.launch(session.id, ["claude"]).pipe(Effect.flip);
          expect(refused).toBeInstanceOf(SealantPlatformError);
          expect(refused instanceof SealantPlatformError ? refused.message : "").toMatch(
            /Send a message to this imported conversation/,
          );
          expect(writtenFiles(world.execCalls).has(DELIVERED)).toBe(false);
          expect(world.memory.rows.get(session.id)?.row.deliveredAt).toBeNull();
        }),
      world.options,
    );
  });
});

/** A protocol host that records what each attached process resumes from. */
const resumingHost = (
  attached: Array<{ readonly process: SessionProcess; readonly resumePath: string | null }>,
) =>
  Layer.succeed(ProtocolHost, {
    attach: (input) =>
      Effect.sync(() => {
        attached.push({ process: input.process, resumePath: input.resumePath ?? null });
      }),
    rehydrate: () => Effect.void,
    submitTurn: () => Effect.die("not in test"),
    sendMessage: () => Effect.die("not in test"),
    steerTurn: () => Effect.die("not in test"),
    interruptTurn: () => Effect.void,
    respondRequest: () => Effect.die("not in test"),
    detach: () => Effect.void,
    has: () => Effect.succeed(false),
    requestPriority: () => "normal",
    quiescence: () => Effect.succeed(null),
    awaitQuiescent: () => Effect.void,
    endWork: () => Effect.void,
    detachForHandOver: () => Effect.void,
  });

const isStage = (argv: ReadonlyArray<string>) => (argv[2] ?? "").includes("leftover()");
const isExchange = (argv: ReadonlyArray<string>) =>
  (argv[2] ?? "").includes("nothing is staged for this conversation");

describe("an imported conversation in the person layout", () => {
  it("lands in the session's conversation home, rewritten for that home, and the agent resumes it from there", async () => {
    const memory = makeImportedConversationsMemory();
    const spawned: Array<ReadonlyArray<string>> = [];
    const opened: Array<SessionOptions | PersonSessionOptions> = [];
    const execCalls: Array<ReadonlyArray<string>> = [];
    const attached: Array<{
      readonly process: SessionProcess;
      readonly resumePath: string | null;
    }> = [];
    const stages: Array<string> = [];
    let sessionId: SessionId | null = null;
    // The conversation home's own scripts, as a person's executor answers them: the layout is
    // ready, the fresh hand-over stages an empty home (no resume yet), and the exchange lands.
    const exec = (argv: ReadonlyArray<string>) => {
      if (isPrepare(argv)) return { exitCode: 0, stdout: LAYOUT_READY, stderr: "" };
      if (isStage(argv)) {
        stages.push(argv[2] ?? "");
        return { exitCode: 0, stdout: "mend-conv moved 0\nmend-conv empty\n", stderr: "" };
      }
      if (isExchange(argv))
        return { exitCode: 0, stdout: "mend-conv exchanged renameat2\n", stderr: "" };
      return undefined;
    };
    await withEngine(
      (state, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, state);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "claude",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            start: { kind: "base", base: null },
          });
          sessionId = session.id;
          seedImport(memory, session.id, project.id);
          yield* engine.launchProtocol(session.id, { mode: "protocol" }, "user-fixture");
        }),
      {
        captured: makeMemoryCaptureStore(),
        importedConversations: memory,
        sealantLayer: sealantLaunchLayer(
          [],
          undefined,
          undefined,
          spawned,
          undefined,
          undefined,
          undefined,
          opened,
          undefined,
          execCalls,
          undefined,
          { exec },
        ),
        protocolHostLayer: resumingHost(attached),
        harnessLayout: {
          flag: "person",
          state: makeHarnessLayoutsMemoryState(),
          platform: personPlatform([], { person: true }),
        },
      },
    );
    if (sessionId === null) throw new Error("no session");
    const home = `/run/mend/conv/${String(sessionId)}`;
    // Written as the owner into their saved conversation directory (`C`), which the agent sees
    // as `H`. A person's write redeems its ticket in their own executor, so its bytes are not
    // read back here; the shared layout's test reads the same rewrite's bytes.
    const C = `${HOME}/people/user-fixture/conversations/${String(sessionId)}`;
    const writes = execCalls.map(commandOf).filter((command) => command[3] === "mend-write");
    expect(
      writes.flatMap((command) => command.slice(5).filter((arg) => !arg.startsWith("C7"))),
    ).toEqual([
      `${C}/.claude/projects/-workspace-repo/${NATIVE}.jsonl`,
      `${C}/.claude/projects/-workspace-repo/${NATIVE}/tool-results/shot.png`,
    ]);
    // The hand-over started the conversation fresh: the files reached the home after it.
    expect(stages.some((script) => script.includes(NATIVE))).toBe(false);
    // The agent runs in H and resumes the conversation from there, by its own id.
    expect(opened.at(-1)?.env?.["CLAUDE_CONFIG_DIR"]).toBe(`${home}/.claude`);
    const argv = spawned.at(-1) ?? [];
    expect(argv[argv.indexOf("--resume") + 1]).toBe(NATIVE);
    expect(attached[0]?.resumePath).toBe(
      `${home}/.claude/projects/-workspace-repo/${NATIVE}.jsonl`,
    );
    expect(attached[0]?.process.providerSessionId).toBe(NATIVE);
    expect(memory.rows.get(sessionId)?.row.deliveredAt).not.toBeNull();
  }, 30_000);
});
