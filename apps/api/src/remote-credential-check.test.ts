import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ProjectsRepo, ReferencesRepo } from "@mend/db";
import { OrganizationId, ProjectId, ReferenceId } from "@mend/domain";
import { Reference } from "@mend/domain/workbench";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { makeProject } from "../test/support/tenancy-harness.ts";
import { checkRemoteCredentials } from "./remote-credential-check.ts";

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

const projectAt = (id: string, storePath: string) =>
  makeProject({
    id: ProjectId.make(id),
    organizationId: ORG,
    visibility: "shared",
    createdByUserId: "anna",
    storePath,
  });

describe("checkRemoteCredentials", () => {
  it("names every project and reference refused for its git config, and changes nothing", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-remote-check-"));
    scratches.push(root);
    const leaky = repositoryWithOrigin(
      root,
      "leaky.git",
      "https://oauth2:TOKEN@gitlab.com/o/r.git",
    );
    const clean = repositoryWithOrigin(root, "clean.git", "git@github.com:org/clean.git");
    const included = repositoryWithOrigin(root, "included.git", "https://gitlab.com/o/i.git");
    execFileSync("git", ["config", "include.path", "../elsewhere.gitconfig"], { cwd: included });
    const reference = repositoryWithOrigin(
      root,
      "docs",
      "https://x-access-token:TOKEN@github.com/org/docs.git",
    );
    const configs = [leaky, clean, included, reference].map((gitDir) =>
      fs.readFileSync(path.join(gitDir, "config"), "utf8"),
    );
    const now = new Date(0);
    const layer = Layer.mergeAll(
      Layer.mock(ProjectsRepo, {
        listAll: () =>
          Effect.succeed([
            projectAt("leaky", leaky),
            projectAt("clean", clean),
            projectAt("included", included),
            // A project whose store is gone is passed over, not an error.
            projectAt("gone", path.join(root, "gone.git")),
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

    const run = () => Effect.runPromise(checkRemoteCredentials.pipe(Effect.provide(layer)));
    expect(await run()).toEqual({ projects: ["leaky", "included"], references: ["docs"] });
    // Stateless: the next start names them again, and nothing was rewritten.
    expect(await run()).toEqual({ projects: ["leaky", "included"], references: ["docs"] });
    expect(
      [leaky, clean, included, reference].map((gitDir) =>
        fs.readFileSync(path.join(gitDir, "config"), "utf8"),
      ),
    ).toEqual(configs);
  });
});
