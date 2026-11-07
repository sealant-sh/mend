import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { AgentMemoryRepo, piProfileDigest, agentMemoryDigest } from "@mend/db";
import { SealantWorkspaceId, SessionId, SessionProcessId } from "@mend/domain";
import { PiProfile, Project, SessionProcess } from "@mend/domain/workbench";
import { SealantPlatformError } from "@mend/sealant";
import { SessionEngine } from "@mend/sessions";
import { harnessHomePathOf, processStatePathOf } from "@mend/store";
import { it } from "@mend/test-ci/effect-vitest";
import type { CreateOptions } from "@sealant/sdk";
import { Clock, Deferred, Effect } from "effect";
import { describe, expect } from "vitest";

import { signalledFixture } from "./engine/clock-fixture.ts";
import {
  agentMemoryLayerOf,
  launchSkill,
  now,
  piProfilesLayerOf,
  sealantLaunchLayer,
  setup,
  skillsForLaunchLayer,
  withEngine,
  withPreparedEngineEffect,
} from "./engine/fixture.ts";

/** The owner's pi profile; none unless a test brings one. */
/** A live process row in a workspace, as the engine records one. */
const liveProcessRow = (
  id: string,
  sessionId: SessionId,
  workspaceId: SealantWorkspaceId,
  kind: "shell" | "agent-pty",
  harness: string | null,
) =>
  new SessionProcess({
    id: SessionProcessId.make(id),
    sessionId,
    sealantWorkspaceId: workspaceId,
    sealantSessionId: `pty-${id}`,
    sealantRunId: null,
    launchCorrelationId: null,
    serviceId: null,
    attemptOrdinal: null,
    kind,
    harness,
    providerSessionId: null,
    protocolOptions: null,
    label: kind,
    argv: kind === "shell" ? ["bash", "-i"] : [harness ?? "pi"],
    status: "running",
    exitCode: null,
    workspacePort: null,
    protocol: "tcp",
    hostPort: null,
    createdAt: now(),
    exitedAt: null,
    updatedAt: now(),
  });

/** Another person's pi profile, as a restored harness home brings it. */
const plantForeignPiProfile = (home: string) => {
  const file = path.join(home, ".pi/agent/mend/profile/extensions/theirs/index.ts");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "export default () => {};\n");
};

describe("SessionEngine", () => {
  it("delivers the launching owner's skills and lets project skills override by name", async () => {
    const created: CreateOptions[] = [];
    const requestedOwners: Array<string | null> = [];
    const skillsLayer = skillsForLaunchLayer((ownerUserId, projectId) =>
      Effect.sync(() => {
        requestedOwners.push(ownerUserId);
        return {
          user: [
            launchSkill("global", "owner global", {
              scope: "user",
              userId: ownerUserId ?? "missing-owner",
            }),
            launchSkill("shared", "owner shared", {
              scope: "user",
              userId: ownerUserId ?? "missing-owner",
            }),
          ],
          project: [launchSkill("shared", "project shared", { scope: "project", projectId })],
        };
      }),
    );
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "codex",
            label: null,
            name: null,
            ownerUserId: "owner-1",
            start: { kind: "base", base: null },
          });

          yield* engine.launch(session.id, ["codex"]);

          const skillsRoot = path.join(
            harnessHomePathOf(project.storePath, session.id),
            ".claude",
            "skills",
          );
          expect(fs.readFileSync(path.join(skillsRoot, "global", "SKILL.md"), "utf8")).toBe(
            "owner global",
          );
          expect(fs.readFileSync(path.join(skillsRoot, "shared", "SKILL.md"), "utf8")).toBe(
            "project shared",
          );
          expect(requestedOwners).toEqual(["owner-1"]);
        }),
      { sealantLayer: sealantLaunchLayer(created), skillsLayer },
    );
  });

  it("excludes user skills when the project's inheritance setting is off", async () => {
    const created: CreateOptions[] = [];
    const skillsLayer = skillsForLaunchLayer((ownerUserId, projectId) =>
      Effect.succeed({
        user: [
          launchSkill("global", "owner global", {
            scope: "user",
            userId: ownerUserId ?? "missing-owner",
          }),
        ],
        project: [launchSkill("local", "project local", { scope: "project", projectId })],
      }),
    );
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const noInheritance = new Project({ ...project, inheritUserSkills: false });
          world.projects.set(project.id, noInheritance);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "codex",
            label: null,
            name: null,
            ownerUserId: "owner-2",
            start: { kind: "base", base: null },
          });

          yield* engine.launch(session.id, ["codex"]);

          const skillsRoot = path.join(
            harnessHomePathOf(project.storePath, session.id),
            ".claude",
            "skills",
          );
          expect(fs.existsSync(path.join(skillsRoot, "global"))).toBe(false);
          expect(fs.readFileSync(path.join(skillsRoot, "local", "SKILL.md"), "utf8")).toBe(
            "project local",
          );
        }),
      { sealantLayer: sealantLaunchLayer(created), skillsLayer },
    );
  });

  it("delivers the owner's pi profile to a pi session, and to no other", async () => {
    const created: CreateOptions[] = [];
    const files = [
      {
        path: "extensions/git-info/index.ts",
        encoding: "utf8",
        contents: "export default () => {};\n",
      },
    ] as const;
    const asked: Array<string> = [];
    const piProfilesLayer = piProfilesLayerOf((userId) =>
      Effect.sync(() => {
        asked.push(userId);
        return {
          profile: new PiProfile({
            fileCount: 1,
            bytes: files[0].contents.length,
            extensions: ["git-info"],
            packages: [],
            digest: piProfileDigest(files),
            revision: 1,
            updatedAt: new Date(0),
          }),
          files,
        };
      }),
    );
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const start = (harness: string) =>
            engine.provision({
              projectId: project.id,
              harness,
              label: null,
              name: null,
              ownerUserId: "owner-pi",
              start: { kind: "base", base: null },
            });
          const pi = yield* start("pi");
          yield* engine.launch(pi.id, ["pi"]);
          const codex = yield* start("codex");
          yield* engine.launch(codex.id, ["codex"]);

          const delivered = (sessionId: typeof pi.id) =>
            path.join(
              harnessHomePathOf(project.storePath, sessionId),
              ".pi/agent/mend/profile/extensions/git-info/index.ts",
            );
          expect(fs.readFileSync(delivered(pi.id), "utf8")).toBe(files[0].contents);
          expect(fs.existsSync(delivered(codex.id))).toBe(false);
          expect(asked).toEqual(["owner-pi"]);
        }),
      { sealantLayer: sealantLaunchLayer(created), piProfilesLayer },
    );
  });

  it("refuses a pi launch whose owner's profile cannot be delivered", async () => {
    const created: CreateOptions[] = [];
    const files = [
      { path: "extensions/mine/index.ts", encoding: "utf8", contents: "export default 1;\n" },
    ] as const;
    const piProfilesLayer = piProfilesLayerOf(() =>
      Effect.succeed({
        profile: new PiProfile({
          fileCount: 1,
          bytes: files[0].contents.length,
          extensions: ["mine"],
          packages: [],
          digest: piProfileDigest(files),
          revision: 1,
          updatedAt: new Date(0),
        }),
        files,
      }),
    );
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "pi",
            label: null,
            name: null,
            ownerUserId: "owner-with-profile",
            start: { kind: "base", base: null },
          });
          const home = harnessHomePathOf(project.storePath, session.id);
          plantForeignPiProfile(home);
          fs.writeFileSync(path.join(home, ".mend"), "not a directory");
          const failure = yield* engine.launch(session.id, ["pi"]).pipe(Effect.flip);
          const platformFailure = failure instanceof SealantPlatformError ? failure : null;
          expect(platformFailure?.code).toBe("PI_PROFILE_NOT_DELIVERED");
          expect(world.sessions.get(session.id)?.status).toBe("failed");
        }),
      { sealantLayer: sealantLaunchLayer(created), piProfilesLayer },
    );
  });

  it.effect(
    "a pi follow-up in a retained workspace runs on its owner's profile, and on the one there beside a live pi",
    () =>
      Effect.gen(function* () {
        const created: CreateOptions[] = [];
        const { world, tmp, untilChanged } = yield* signalledFixture("mend-launch-test-");
        yield* withPreparedEngineEffect(
          (_world, dir) => setup(dir, world),
          (_world, _dir, project) =>
            Effect.gen(function* () {
              const engine = yield* SessionEngine;
              const provision = (ownerUserId: string) =>
                engine.provision({
                  projectId: project.id,
                  harness: "pi",
                  label: null,
                  name: null,
                  ownerUserId,
                  start: { kind: "base", base: null },
                });
              const session = yield* provision("owner-a");
              yield* engine.launch(session.id, ["pi"]);
              const workspaceId =
                [...world.processes.values()].find((process) => process.sessionId === session.id)
                  ?.sealantWorkspaceId ?? SealantWorkspaceId.make("workspace-1");
              const shell = liveProcessRow("shell-a", session.id, workspaceId, "shell", null);
              world.processes.set(shell.id, shell);
              const stopAgent = Effect.gen(function* () {
                yield* engine.stop(session.id);
                const agentLive = () =>
                  [...world.processes.values()].some(
                    (process) =>
                      process.sessionId === session.id &&
                      process.kind === "agent-pty" &&
                      process.exitedAt === null,
                  );
                yield* untilChanged(() => !agentLive(), "the agent's end after the stop");
                expect(agentLive()).toBe(false);
              });
              const home = harnessHomePathOf(project.storePath, session.id);
              const profile = path.join(home, ".pi/agent/mend/profile");

              // No pi runs there: the profile the harness home holds is moved aside, as at a launch.
              yield* stopAgent;
              plantForeignPiProfile(home);
              yield* engine.launchFollowUp(session.id, "Carry on.", "follow-up:pi-1", "owner-a");
              expect(fs.existsSync(profile)).toBe(false);
              expect(
                fs.readdirSync(path.join(home, ".mend/pi-profile-kept")).length,
              ).toBeGreaterThan(0);

              // Another person's pi runs in the workspace: the launch runs on the profile already
              // there, which is left as it is.
              yield* stopAgent;
              plantForeignPiProfile(home);
              const other = yield* provision("owner-b");
              const theirs = liveProcessRow("pi-b", other.id, workspaceId, "agent-pty", "pi");
              world.processes.set(theirs.id, theirs);
              yield* engine.launchFollowUp(session.id, "Carry on.", "follow-up:pi-2", "owner-a");
              expect(fs.existsSync(profile)).toBe(true);
            }),
          { fixture: { world, tmp }, sealantLayer: sealantLaunchLayer(created) },
        );
      }),
  );

  it("moves aside a pi profile that is not the owner's, and refuses the launch when it cannot", async () => {
    // A pi launch runs on its owner's freshly delivered profile, on no profile, or not at all.
    const created: CreateOptions[] = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const start = () =>
            engine.provision({
              projectId: project.id,
              harness: "pi",
              label: null,
              name: null,
              ownerUserId: "owner-without-profile",
              start: { kind: "base", base: null },
            });
          const moved = yield* start();
          const movedHome = harnessHomePathOf(project.storePath, moved.id);
          plantForeignPiProfile(movedHome);
          yield* engine.launch(moved.id, ["pi"]);
          expect(fs.existsSync(path.join(movedHome, ".pi/agent/mend/profile"))).toBe(false);
          const kept = fs.readdirSync(path.join(movedHome, ".mend/pi-profile-kept"));
          expect(kept).toHaveLength(1);

          // The profile cannot be moved: the session fails instead of running it.
          const stuck = yield* start();
          const stuckHome = harnessHomePathOf(project.storePath, stuck.id);
          plantForeignPiProfile(stuckHome);
          fs.writeFileSync(path.join(stuckHome, ".mend"), "not a directory");
          const failure = yield* engine.launch(stuck.id, ["pi"]).pipe(Effect.flip);
          const platformFailure = failure instanceof SealantPlatformError ? failure : null;
          expect(platformFailure?.code).toBe("PI_PROFILE_NOT_DELIVERED");
          expect(world.sessions.get(stuck.id)?.status).toBe("failed");
          expect(fs.existsSync(path.join(stuckHome, ".pi/agent/mend/profile"))).toBe(true);
        }),
      { sealantLayer: sealantLaunchLayer(created) },
    );
  });

  it.effect(
    "delivers the owner's agent memory at launch and reads back what the agent learned when it stops",
    () =>
      Effect.gen(function* () {
        const created: CreateOptions[] = [];
        const root = ".claude/projects/-workspace-repo/memory";
        const index = { path: `${root}/MEMORY.md`, encoding: "utf8", contents: "- one\n" } as const;
        const readBacks: Array<Parameters<AgentMemoryRepo["Service"]["readBack"]>[0]> = [];
        /** The stop's tail read the harness home back. */
        const readBackDone = yield* Deferred.make<void>();
        const agentMemoryLayer = agentMemoryLayerOf({
          forLaunch: (userId) =>
            Effect.succeed(
              userId === "owner-memory"
                ? [{ ...index, digest: agentMemoryDigest(index), updatedBySession: null }]
                : [],
            ),
          readBack: (input) =>
            Effect.sync(() => {
              readBacks.push(input);
              return { saved: [], merged: [], deleted: [], skipped: [] };
            }).pipe(Effect.tap(() => Deferred.succeed(readBackDone, undefined))),
        });
        yield* withPreparedEngineEffect(
          (world, dir) => setup(dir, world),
          (_world, _dir, project) =>
            Effect.gen(function* () {
              const engine = yield* SessionEngine;
              const session = yield* engine.provision({
                projectId: project.id,
                harness: "claude",
                label: null,
                name: null,
                ownerUserId: "owner-memory",
                start: { kind: "base", base: null },
              });
              yield* engine.launch(session.id, ["claude"]);
              const home = harnessHomePathOf(project.storePath, session.id);
              expect(fs.readFileSync(path.join(home, index.path), "utf8")).toBe("- one\n");

              // The agent learned something, then the session stopped.
              fs.writeFileSync(path.join(home, root, "learned.md"), "the API listens on 3101\n");
              yield* engine.stop(session.id);
              yield* Deferred.await(readBackDone);
              const [readBack] = readBacks;
              expect(readBack?.userId).toBe("owner-memory");
              expect(readBack?.sessionId).toBe(session.id);
              expect(readBack?.delivered).toEqual({ [index.path]: agentMemoryDigest(index) });
              expect(readBack?.session.map((file) => file.path).toSorted()).toEqual([
                index.path,
                `${root}/learned.md`,
              ]);
            }),
          { sealantLayer: sealantLaunchLayer(created), agentMemoryLayer },
        );
      }),
  );

  // Live clock: the carry ages the harvested conversations against the engine's now and stamps
  // the stub's mtime with the summary's time, which the filesystem keeps as a real instant (Node
  // clamps one before 1970 to now), so the engine's clock has to be the wall clock here.
  it.live(
    "carries the owner's earlier Codex conversations into a Codex launch, minus what Codex summarised (docs/adr/0009, Codex)",
    () =>
      Effect.gen(function* () {
        const created: CreateOptions[] = [];
        const summarisedId = "11111111-1111-4111-8111-111111111111";
        const pendingId = "22222222-2222-4222-8222-222222222222";
        // The stored summary database lists one of the two conversations as summarised.
        const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "mend-codex-db-"));
        const dbFile = path.join(dbDir, "memories_1.sqlite");
        const { DatabaseSync } = yield* Effect.promise(() => import("node:sqlite"));
        const db = new DatabaseSync(dbFile);
        db.exec(
          "create table stage1_outputs (thread_id text primary key, source_updated_at integer not null)",
        );
        const summarisedAt = Math.floor(
          ((yield* Clock.currentTimeMillis) - 8 * 60 * 60 * 1000) / 1000,
        );
        db.prepare("insert into stage1_outputs values (?, ?)").run(summarisedId, summarisedAt);
        db.close();
        const database = {
          path: ".codex/memories_1.sqlite",
          encoding: "base64",
          contents: fs.readFileSync(dbFile).toString("base64"),
        } as const;
        const agentMemoryLayer = agentMemoryLayerOf({
          forLaunch: () =>
            Effect.succeed([
              { ...database, digest: agentMemoryDigest(database), updatedBySession: null },
            ]),
        });
        yield* withPreparedEngineEffect(
          (world, dir) => setup(dir, world),
          (world, _dir, project) =>
            Effect.gen(function* () {
              const engine = yield* SessionEngine;
              const provision = () =>
                engine.provision({
                  projectId: project.id,
                  harness: "codex",
                  label: null,
                  name: null,
                  ownerUserId: "owner-codex",
                  start: { kind: "base", base: null },
                });
              // Two earlier Codex sessions of the owner's, each with a harvested conversation that
              // ended eight hours ago.
              for (const providerSessionId of [summarisedId, pendingId]) {
                const earlier = yield* provision();
                yield* engine.launch(earlier.id, ["codex"]);
                const agent = [...world.processes.values()].find(
                  (row) => row.sessionId === earlier.id && row.kind === "agent-pty",
                );
                if (agent === undefined) throw new Error("the earlier launch recorded no agent");
                world.processes.set(
                  agent.id,
                  new SessionProcess({ ...agent, status: "exited", exitCode: 0, exitedAt: now() }),
                );
                const stateDir = processStatePathOf(project.storePath, earlier.id, agent.id);
                fs.mkdirSync(stateDir, { recursive: true });
                fs.writeFileSync(
                  path.join(stateDir, "manifest.json"),
                  JSON.stringify({
                    harness: "codex",
                    providerSessionId,
                    // The summary's own time: Codex summarised this exact revision.
                    capturedAt: new Date(summarisedAt * 1000).toISOString(),
                  }),
                );
                fs.writeFileSync(
                  path.join(stateDir, "transcript.native"),
                  `${JSON.stringify({ type: "session_meta", payload: { id: providerSessionId, timestamp: "2026-09-30T08:00:00Z" } })}\n`,
                );
              }

              const session = yield* provision();
              yield* engine.launch(session.id, ["codex"]);
              const home = harnessHomePathOf(project.storePath, session.id);
              const carried = path.join(
                home,
                `.codex/sessions/2026/09/30/rollout-2026-09-30T08-00-00-${pendingId}.jsonl`,
              );
              // The launch carries the conversations in before it answers.
              expect(fs.existsSync(carried)).toBe(true);
              expect(
                fs
                  .readFileSync(path.join(home, ".mend/carried-transcripts"), "utf8")
                  .trim()
                  .split("\n")
                  .toSorted(),
              ).toEqual([summarisedId, pendingId].toSorted());
              // The summarised one is there as a stub: its first line, at the summary's time, so
              // Codex keeps its summary without making it again.
              const stub = path.join(
                home,
                `.codex/sessions/2026/09/30/rollout-2026-09-30T08-00-00-${summarisedId}.jsonl`,
              );
              expect(fs.readFileSync(stub, "utf8").trim().split("\n")).toHaveLength(1);
              expect(Math.floor(fs.statSync(stub).mtimeMs / 1000)).toBe(summarisedAt);
              expect(fs.readFileSync(carried, "utf8")).toContain(pendingId);
            }),
          { sealantLayer: sealantLaunchLayer(created), agentMemoryLayer },
        );
      }),
  );
});
