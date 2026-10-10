import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { AuditEventsRepo, type NewAuditEvent, ProjectsRepo, ReferencesRepo } from "@mend/db";
import { OrganizationId, ProjectId, ReferenceId } from "@mend/domain";
import { Reference } from "@mend/domain/workbench";
import { Store, StoreConfig } from "@mend/store";
import { Effect, Fiber, Layer, Schedule } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { makeProject } from "../test/support/tenancy-harness.ts";
import { scrubRemoteCredentials } from "./remote-credential-scrub.ts";

const ORG = OrganizationId.make("org-test");
const scratches: Array<string> = [];

afterEach(() => {
  for (const dir of scratches.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A bare repository whose origin is `url`, as a server before 0.36 cloned it. */
const repositoryWithOrigin = (root: string, name: string, url: string): string => {
  const gitDir = path.join(root, name);
  execFileSync("git", ["init", "--bare", "-q", gitDir]);
  execFileSync("git", ["config", "remote.origin.url", url], { cwd: gitDir });
  return gitDir;
};

/** An audit log that keeps what it was asked to record. */
const recordingAudit = () => {
  const events: Array<NewAuditEvent> = [];
  return {
    events,
    layer: Layer.mock(AuditEventsRepo, {
      record: (event) => Effect.sync(() => void events.push(event)),
    }),
  };
};

const projectAt = (id: string, storePath: string) =>
  makeProject({
    id: ProjectId.make(id),
    organizationId: ORG,
    visibility: "shared",
    createdByUserId: "anna",
    storePath,
  });

const originOf = (gitDir: string): string =>
  execFileSync("git", ["config", "--get", "remote.origin.url"], {
    cwd: gitDir,
    encoding: "utf8",
  }).trim();

describe("scrubRemoteCredentials", () => {
  it("strips a token from project and reference remotes, and names them without their URLs", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-remote-scrub-"));
    scratches.push(root);
    const leaky = repositoryWithOrigin(
      root,
      "leaky.git",
      "https://oauth2:TOKEN-SECRET@gitlab.com/org/leaky.git",
    );
    const clean = repositoryWithOrigin(root, "clean.git", "git@github.com:org/clean.git");
    const reference = repositoryWithOrigin(
      root,
      "docs",
      "https://x-access-token:TOKEN-SECRET@github.com/org/docs.git",
    );
    const project = (id: string, storePath: string) =>
      makeProject({
        id: ProjectId.make(id),
        organizationId: ORG,
        visibility: "shared",
        createdByUserId: null,
        storePath,
      });
    const now = new Date(0);
    const layer = Layer.mergeAll(
      Store.layer.pipe(Layer.provide(StoreConfig.layerFor(root))),
      Layer.mock(ProjectsRepo, {
        listAll: () =>
          Effect.succeed([
            project("leaky", leaky),
            project("clean", clean),
            // A project whose store is gone is passed over, not an error.
            project("gone", path.join(root, "gone.git")),
          ]),
      }),
      recordingAudit().layer,
      Layer.mock(ReferencesRepo, {
        listAll: () =>
          Effect.succeed([
            new Reference({
              id: ReferenceId.make("r-docs"),
              name: "docs",
              organizationId: ORG,
              createdByUserId: null,
              originUrl: "https://github.com/org/docs.git",
              path: reference,
              pinnedRef: null,
              headSha: null,
              refreshedAt: null,
              createdAt: now,
              updatedAt: now,
            }),
          ]),
      }),
    );

    const first = await Effect.runPromise(scrubRemoteCredentials().pipe(Effect.provide(layer)));
    expect(first).toEqual({ projects: ["leaky"], references: ["docs"] });
    expect(originOf(leaky)).toBe("https://gitlab.com/org/leaky.git");
    expect(originOf(clean)).toBe("git@github.com:org/clean.git");
    expect(originOf(reference)).toBe("https://github.com/org/docs.git");

    const again = await Effect.runPromise(scrubRemoteCredentials().pipe(Effect.provide(layer)));
    expect(again).toEqual({ projects: [], references: [] });
  });

  it("retries a repository whose config another git holds locked, until its remote is clean", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-remote-scrub-lock-"));
    scratches.push(root);
    const locked = repositoryWithOrigin(
      root,
      "locked.git",
      "https://user:LOCK-SECRET@example.invalid/repo.git",
    );
    const lock = path.join(locked, "config.lock");
    fs.writeFileSync(lock, "");
    const layer = Layer.mergeAll(
      Store.layer.pipe(Layer.provide(StoreConfig.layerFor(root))),
      Layer.mock(ProjectsRepo, {
        listAll: () =>
          Effect.succeed([
            makeProject({
              id: ProjectId.make("locked"),
              organizationId: ORG,
              visibility: "shared",
              createdByUserId: null,
              storePath: locked,
            }),
          ]),
      }),
      Layer.mock(ReferencesRepo, { listAll: () => Effect.succeed([]) }),
      recordingAudit().layer,
    );
    // Another git lets go of the config a moment after the sweep's first attempt.
    setTimeout(() => fs.rmSync(lock, { force: true }), 150);
    const result = await Effect.runPromise(
      scrubRemoteCredentials(Schedule.spaced("25 millis")).pipe(Effect.provide(layer)),
    );
    expect(result).toEqual({ projects: ["locked"], references: [] });
    expect(originOf(locked)).toBe("https://example.invalid/repo.git");
  });

  it("reports a cleaned project at once, while another stays refused, and records it", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-remote-scrub-notice-"));
    scratches.push(root);
    const leaky = repositoryWithOrigin(
      root,
      "leaky.git",
      "https://oauth2:TOKEN@gitlab.com/o/r.git",
    );
    const blocked = repositoryWithOrigin(root, "blocked.git", "https://gitlab.com/o/b.git");
    execFileSync("git", ["config", "include.path", "../elsewhere.gitconfig"], { cwd: blocked });
    const audit = recordingAudit();
    const layer = Layer.mergeAll(
      Store.layer.pipe(Layer.provide(StoreConfig.layerFor(root))),
      Layer.mock(ProjectsRepo, {
        listAll: () => Effect.succeed([projectAt("leaky", leaky), projectAt("blocked", blocked)]),
      }),
      Layer.mock(ReferencesRepo, { listAll: () => Effect.succeed([]) }),
      audit.layer,
    );
    // The blocked project retries for as long as its include stays: the sweep never ends here.
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(scrubRemoteCredentials(Schedule.spaced("20 millis")));
        yield* Effect.sleep("600 millis");
        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.provide(layer)),
    );
    expect(audit.events).toEqual([
      {
        organizationId: ORG,
        actorUserId: "anna",
        action: "project.remote_credentials_removed",
        subjectType: "project",
        subjectId: "leaky",
        data: { name: "leaky", keys: "remote.origin.url" },
      },
    ]);
    expect(originOf(leaky)).toBe("https://gitlab.com/o/r.git");
  });

  it("reports a removal a fetch made before the sweep, and one a restart never got to record", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-remote-scrub-restart-"));
    scratches.push(root);
    const leaky = repositoryWithOrigin(
      root,
      "leaky.git",
      "https://oauth2:TOKEN@gitlab.com/o/r.git",
    );
    const storeLayer = Store.layer.pipe(Layer.provide(StoreConfig.layerFor(root)));
    // A fetch (any gated op) got there first; then the server stopped before any sweep reported it.
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.scrubRemoteCredentials(leaky);
      }).pipe(Effect.provide(storeLayer)),
    );
    const audit = recordingAudit();
    const layer = Layer.mergeAll(
      storeLayer,
      Layer.mock(ProjectsRepo, { listAll: () => Effect.succeed([projectAt("leaky", leaky)]) }),
      Layer.mock(ReferencesRepo, { listAll: () => Effect.succeed([]) }),
      audit.layer,
    );
    const first = await Effect.runPromise(scrubRemoteCredentials().pipe(Effect.provide(layer)));
    expect(first).toEqual({ projects: ["leaky"], references: [] });
    expect(audit.events.map((event) => event.subjectId)).toEqual(["leaky"]);
    // Recorded once: the next start has nothing left to say.
    const second = await Effect.runPromise(scrubRemoteCredentials().pipe(Effect.provide(layer)));
    expect(second).toEqual({ projects: [], references: [] });
    expect(audit.events).toHaveLength(1);
  });
});
