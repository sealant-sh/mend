import { StoreRefsRepo } from "@mend/db";
import { ProjectId } from "@mend/domain";
import { GitOpsRunner, RunnerCacheError } from "@mend/store";
import { buildManifest } from "@mend/store/testing";
import { it } from "@mend/test-ci/effect-vitest";
import { Effect, Layer } from "effect";
import { describe, expect } from "vitest";

import { CaptureGitVerifier, CaptureGitVerifierLive } from "../src/capture-verify.ts";

const PATH = "/home/anna/interviews/northwind-friday.md";

describe("a seal check's detail when the runner cache could not be prepared (SLNT-385)", () => {
  it.effect("names a reference to the logged failure, never the host error's words", () =>
    Effect.gen(function* () {
      const verifier = yield* CaptureGitVerifier;
      const { manifest } = buildManifest({
        worktreeId: "worktree-1",
        n: 1,
        parent: null,
        epoch: 1,
        git: {
          packs: [],
          refs: { "refs/heads/main": "a".repeat(40) },
          head: "refs/heads/main",
          fsck: "unverified",
        },
      });
      const verdict = yield* verifier.verify(ProjectId.make("project-1"), manifest);
      expect(verdict.outcome).toBe("unverified");
      expect(verdict.detail ?? "").not.toContain(PATH);
      expect(verdict.detail).toMatch(
        /^the runner cache could not be prepared: internal error · reference [0-9a-f]{16}$/,
      );
    }).pipe(
      Effect.provide(
        CaptureGitVerifierLive.pipe(
          Layer.provide(
            Layer.mock(GitOpsRunner, {
              ensure: (input) =>
                Effect.fail(
                  new RunnerCacheError({
                    projectId: input.projectId,
                    cause: new Error(`EACCES: permission denied, open '${PATH}'`),
                  }),
                ),
            }),
          ),
          Layer.provide(Layer.mock(StoreRefsRepo, { refsMap: () => Effect.succeed({}) })),
        ),
      ),
    ),
  );
});
