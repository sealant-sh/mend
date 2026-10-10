import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ProjectsRepo, ReferencesRepo } from "@mend/db";
import { OrganizationId, ProjectId, ReferenceId } from "@mend/domain";
import { Reference } from "@mend/domain/workbench";
import { Store, StoreConfig } from "@mend/store";
import { Effect, Layer } from "effect";
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

    const first = await Effect.runPromise(scrubRemoteCredentials.pipe(Effect.provide(layer)));
    expect(first).toEqual({ projects: ["leaky"], references: ["docs"] });
    expect(originOf(leaky)).toBe("https://gitlab.com/org/leaky.git");
    expect(originOf(clean)).toBe("git@github.com:org/clean.git");
    expect(originOf(reference)).toBe("https://github.com/org/docs.git");

    const again = await Effect.runPromise(scrubRemoteCredentials.pipe(Effect.provide(layer)));
    expect(again).toEqual({ projects: [], references: [] });
  });
});
