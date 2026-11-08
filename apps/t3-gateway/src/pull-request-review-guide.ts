import { createHash } from "node:crypto";

import {
  PullRequestOperationError,
  PullRequestReviewGuideResult,
  type PullRequestRef,
} from "@mend/t3-contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { GatedMend } from "./device-gate.ts";
import type { PersonHub } from "./hub.ts";
import type { MendPullRequest } from "./mend-pull-requests.ts";
import type { BearerSession } from "./state.ts";

const refusal = (detail: string) =>
  new PullRequestOperationError({ operation: "reviewGuide", detail });

/** Adapt a tour only when its change still equals the PR's recorded landed head. */
export const makePullRequestReviewGuide = ({
  hub,
  mend,
  session,
}: {
  readonly hub: PersonHub;
  readonly mend: GatedMend;
  readonly session: BearerSession;
}) => {
  const pending = new Map<string, string>();
  const targetOf = (ref: PullRequestRef, pr: MendPullRequest) =>
    Effect.gen(function* () {
      const shell = yield* hub.shellSnapshot;
      const seen = new Set<string>();
      for (const thread of shell.threads) {
        if (thread.projectId !== ref.projectId || thread.worktreePath === null) continue;
        const change = yield* hub.changeOfWorktree(thread.worktreePath);
        if (change === null || seen.has(change.changeId)) continue;
        seen.add(change.changeId);
        const history = yield* mend.changeLandings(session.deviceToken, change.changeId);
        const latestPush = history.landings.find((landing) => landing.pushedSha !== null);
        if (
          latestPush?.pushedSha !== pr.headSha ||
          latestPush.pullRequest?.url.toLowerCase() !== pr.url.toLowerCase()
        )
          continue;
        if (
          history.facts === undefined ||
          history.facts.some(
            (fact) => fact._tag === "origin-moved" || fact._tag === "changed-since-landing",
          )
        )
          continue;
        const diff = yield* mend.changeDiff(session.deviceToken, change.changeId);

        return {
          changeId: change.changeId,
          digest: createHash("sha256").update(diff.diff).digest("hex"),
        };
      }
      return null;
    });
  const resultOf = (ref: PullRequestRef, pr: MendPullRequest, generate: boolean) =>
    Effect.gen(function* () {
      const target = yield* targetOf(ref, pr);
      if (target === null) {
        if (generate)
          return yield* refusal(
            "Mend can compose a guide for a PR it landed while its change still matches that PR's current head. Open the matching unchanged session first.",
          );
        return { guide: null, run: null, currentHeadSha: pr.headSha };
      }
      const tour = yield* mend.changeTour(session.deviceToken, target.changeId);
      const passes = yield* mend.changePasses(session.deviceToken, target.changeId);
      let pass = passes.find((candidate) => candidate.kind === "tour");
      const key = `${target.changeId}:${pr.headSha}`;
      if (generate) {
        yield* mend.composeChangeTour(session.deviceToken, target.changeId);
        pending.set(key, new Date().toISOString());
        pass = undefined;
      } else if (pass?.status === "completed" || pass?.status === "failed") pending.delete(key);
      const startedAt = pending.get(key);
      const running = pass?.status === "queued" || pass?.status === "running";
      return yield* Schema.decodeUnknownEffect(PullRequestReviewGuideResult)({
        currentHeadSha: pr.headSha,
        guide:
          tour === null || tour.diffDigest !== target.digest
            ? null
            : {
                headSha: pr.headSha,
                generatedAt: tour.createdAt,
                // Mend's stored tour does not record a model. Say so instead of borrowing the session's.
                modelSelection: {
                  instanceId: "mend-inference",
                  model: "Model not recorded by Mend",
                },
                stops: [
                  {
                    title: "Change summary",
                    summary: [tour.summary, tour.approach]
                      .filter((part) => part !== null)
                      .join("\n\n"),
                    attention: null,
                    excerpts: [],
                    files: [],
                    notes: [],
                    questions: [],
                  },
                  ...tour.stops.map((stop) => ({
                    title: stop.title,
                    summary: [
                      stop.narration,
                      ...stop.evidence.map(
                        (record) =>
                          `Record ${record.sealantRunId}, sequence ${record.sequence}: ${record.excerpt}`,
                      ),
                    ].join("\n\n"),
                    attention: stop.grounded
                      ? null
                      : {
                          kind: "contract",
                          note: "Mend's inferred reading. Claims here are not all grounded in the session record.",
                        },
                    excerpts:
                      stop.file === null || stop.line === null || stop.line < 1
                        ? []
                        : [
                            {
                              path: stop.file,
                              side: "new",
                              start: stop.line,
                              end: Math.max(stop.line, stop.endLine ?? stop.line),
                              caption: stop.title,
                            },
                          ],
                    files: stop.file === null ? [] : [{ path: stop.file }],
                    notes: [],
                    questions: [],
                  })),
                ],
              },
        run:
          running || startedAt !== undefined
            ? { _tag: "Running", headSha: pr.headSha, startedAt: startedAt ?? pass?.startedAt }
            : pass?.status === "failed"
              ? {
                  _tag: "Failed",
                  headSha: pr.headSha,
                  failedAt: pass.finishedAt ?? pass.startedAt,
                  detail: pass.detail ?? "Mend's tour pass failed.",
                }
              : null,
      }).pipe(Effect.mapError(() => refusal("Mend returned an incomplete review tour.")));
    });
  return { resultOf };
};
