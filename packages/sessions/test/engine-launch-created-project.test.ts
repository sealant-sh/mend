import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { OrganizationId, ProjectId } from "@mend/domain";
import { Project, type SessionProcess } from "@mend/domain/workbench";
import { SessionEngine } from "@mend/sessions";
import { decodeManifest, Store, worktreePathOf } from "@mend/store";
import type { CreateOptions } from "@sealant/sdk";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { makeMemoryCaptureStore, type MemoryCaptureStore } from "./capture-store-memory.ts";
import {
  recordingProtocolHostLayer,
  sealantLaunchLayer,
  withPreparedEngineEffect,
  type World,
} from "./engine/fixture.ts";

const owner = "user-fixture";

/** A project as `POST /api/projects/new` or `/api/projects/scratch` leaves it: no origin. */
const createdInMend = (world: World, purpose: "named" | "scratch") =>
  Effect.gen(function* () {
    const store = yield* Store;
    const id = ProjectId.make(purpose === "named" ? "proj-notes" : "proj-scratch");
    const name = purpose === "named" ? "notes" : "scratch-fixture-person";
    const repository = yield* store.createRepository(id, {
      readme: `# ${name}\n`,
      author: { name: "Fixture Person", email: "fixture@example.com" },
      at: new Date("2026-10-25T12:00:00Z"),
    });
    yield* store.settleCreatedRepository(repository.storePath);
    const project = new Project({
      id,
      name,
      organizationId: OrganizationId.make("org-test"),
      visibility: "private",
      createdByUserId: owner,
      scratchOwnerUserId: purpose === "scratch" ? owner : null,
      originUrl: null,
      storePath: repository.storePath,
      defaultBranch: repository.defaultBranch,
      adoptedSha: repository.headSha,
      autoTour: "inherit",
      autoName: "inherit",
      autoLand: "inherit",
      autoSuggest: "inherit",
      backgroundSessions: "inherit",
      gitAuthMode: "mend-key",
      workspaceImage: null,
      applyDotfiles: true,
      defaultShellProfile: true,
      inheritUserSkills: true,
      hotSessions: 0,
      installCommand: null,
      installEnabled: true,
      createdAt: world.clock.now(),
      updatedAt: world.clock.now(),
    });
    world.projects.set(project.id, project);
    return { project, readmeSha: repository.headSha };
  });

/** README.md at `sha`, read from the base pack capture 0 of `worktreeId` names. */
const readmeInCaptureZero = (tmp: string, memory: MemoryCaptureStore, worktreeId: string) =>
  Effect.gen(function* () {
    const head = memory.captures.get(memory.chains.get(worktreeId)?.headCapture ?? "");
    if (head === undefined) return yield* Effect.die("the worktree has no capture");
    expect(head.n).toBe(0);
    const manifest = yield* decodeManifest(
      head.manifestKey,
      new Uint8Array(fs.readFileSync(path.join(tmp, "blobs", head.manifestKey))),
    ).pipe(Effect.orDie);
    const sha = manifest.checkpoint?.sha ?? "";
    const unpacked = fs.mkdtempSync(path.join(tmp, "capture-zero-"));
    execFileSync("git", ["init", "-q", "--bare", unpacked]);
    for (const pack of manifest.sections.git.packs)
      execFileSync("git", ["-C", unpacked, "unpack-objects", "-q"], {
        input: fs.readFileSync(path.join(tmp, "blobs", pack)),
      });
    return {
      sha,
      refs: manifest.sections.git.refs,
      readme: execFileSync("git", ["-C", unpacked, "show", `${sha}:README.md`], {
        encoding: "utf8",
      }),
    };
  });

describe.each([
  ["co-located", false],
  ["captured", true],
] as const)("a session in a project created in Mend, %s", (_mode, captured) => {
  const launching = <A>(
    purpose: "named" | "scratch",
    work: (input: {
      readonly world: World;
      readonly tmp: string;
      readonly project: Project;
      readonly readmeSha: string;
      readonly memory: MemoryCaptureStore;
      readonly submitted: ReadonlyArray<string>;
    }) => Effect.Effect<A, unknown, SessionEngine>,
  ) => {
    const created: CreateOptions[] = [];
    const attached: Array<{ readonly process: SessionProcess; readonly mode: string }> = [];
    const submitted: string[] = [];
    const memory = makeMemoryCaptureStore();
    return Effect.runPromise(
      withPreparedEngineEffect(
        (world) => createdInMend(world, purpose),
        (world, tmp, { project, readmeSha }) =>
          work({ world, tmp, project, readmeSha, memory, submitted }).pipe(Effect.orDie),
        {
          ...(captured ? { captured: memory } : {}),
          sealantLayer: sealantLaunchLayer(created),
          protocolHostLayer: recordingProtocolHostLayer(attached, submitted),
        },
      ),
    );
  };
  const provision = (project: Project) =>
    Effect.gen(function* () {
      return yield* (yield* SessionEngine).provision({
        projectId: project.id,
        harness: "codex",
        label: null,
        name: null,
        ownerUserId: owner,
        start: { kind: "base", base: null },
      });
    });
  const open = (
    sessionId: Parameters<SessionEngine["Service"]["launchProtocol"]>[0],
    prompt: string,
  ) =>
    Effect.gen(function* () {
      yield* (yield* SessionEngine).launchProtocol(
        sessionId,
        { mode: "protocol", prompt, permissionMode: "bypass" },
        owner,
      );
    });
  const startsFromReadme = (
    input: {
      readonly tmp: string;
      readonly project: Project;
      readonly readmeSha: string;
      readonly memory: MemoryCaptureStore;
    },
    session: Effect.Success<ReturnType<typeof provision>>,
  ) =>
    Effect.gen(function* () {
      expect(session.baseRef).toBe("main");
      expect(session.baseSha).toBe(input.readmeSha);
      if (!captured) {
        const worktree = worktreePathOf(input.project.storePath, session.worktree);
        expect(fs.readFileSync(path.join(worktree, "README.md"), "utf8")).toBe(
          `# ${input.project.name}\n`,
        );
        expect(
          execFileSync("git", ["-C", worktree, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        ).toBe(input.readmeSha);
        return;
      }
      const zero = yield* readmeInCaptureZero(input.tmp, input.memory, session.worktreeId);
      expect(zero.sha).toBe(input.readmeSha);
      expect(zero.refs[`refs/heads/${session.branch}`]).toBe(input.readmeSha);
      expect(zero.readme).toBe(`# ${input.project.name}\n`);
    });

  it("starts a named project's session from its README commit and delivers the opening message", () =>
    launching("named", (input) =>
      Effect.gen(function* () {
        const session = yield* provision(input.project);
        yield* startsFromReadme(input, session);
        yield* open(session.id, "write the first file");
        expect(input.submitted).toEqual(["write the first file"]);
        expect(input.world.sessions.get(session.id)?.status).not.toBe("failed");
      }),
    ));

  it("gives each scratch thread a worktree of its own from the README commit", () =>
    launching("scratch", (input) =>
      Effect.gen(function* () {
        const first = yield* provision(input.project);
        const second = yield* provision(input.project);
        expect(second.worktreeId).not.toBe(first.worktreeId);
        expect(second.worktree).not.toBe(first.worktree);
        yield* startsFromReadme(input, first);
        yield* startsFromReadme(input, second);
        yield* open(first.id, "first scratch thread");
        yield* open(second.id, "second scratch thread");
        expect(input.submitted).toEqual(["first scratch thread", "second scratch thread"]);
      }),
    ));
});
