import { AdoptionGitProgress, AdoptionProgress } from "@mend/api-contracts";
import type { ProjectId } from "@mend/domain";
import type { Project } from "@mend/domain/workbench";
import type { AdoptProgress } from "@mend/store";
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Option } from "effect";

/** One adoption as its request starts it: whose it is, and what it clones. */
export interface AdoptionStart {
  /** The key the client chose (`AdoptProject.adoptionId`). */
  readonly id: string;
  readonly ownerUserId: string;
  readonly name: string;
  readonly source: string;
  /** The id the project gets once cloned, chosen before its row exists. */
  readonly projectId: ProjectId;
}

/** How an adoption ended: its project, or Mend's sentence for why it failed. */
export type AdoptionEnd =
  | { readonly _tag: "Adopted"; readonly projectId: ProjectId }
  | { readonly _tag: "Failed"; readonly failure: string };

/** An adoption someone waits on: how far it got now, its project's id, and its end. */
export interface WatchedAdoption {
  readonly progress: AdoptionProgress;
  readonly projectId: ProjectId;
  /** Answers once the adoption ends, at once when it already has. */
  readonly ended: Effect.Effect<AdoptionEnd>;
}

/** What the adoption's work says as it goes. Called from git's output stream: plain callbacks. */
export interface AdoptionReporter {
  /** The store's progress: the clone, with git's own words, then the checks. */
  readonly store: (progress: AdoptProgress) => void;
  /** The project row is being written. */
  readonly recording: () => void;
}

/** How a failed adoption reads: Mend's sentence, and what git said when git failed. */
export interface AdoptionFailure {
  readonly failure: string;
  readonly gitSaid: string | null;
}

/**
 * Adoptions as they run, and a while after they end: what `GET /adoptions/:id` reads, so the
 * dialog that started one shows how far the clone got, and can be closed and opened again.
 */
export class Adoptions extends Context.Service<
  Adoptions,
  {
    /**
     * Run one adoption and answer its project. The work runs on a fiber of its own: the request
     * that started it may be cut off (a reload, a closed tab) and the clone goes on to its end,
     * which `read` reports.
     */
    readonly run: <E, R>(
      start: AdoptionStart,
      work: (report: AdoptionReporter) => Effect.Effect<Project, E, R>,
      failureOf: (error: E) => AdoptionFailure,
    ) => Effect.Effect<Project, E, R>;
    /** How far an adoption got; null for one this server does not know, or another account's. */
    readonly read: (ownerUserId: string, id: string) => Effect.Effect<AdoptionProgress | null>;
    /**
     * Wait on an adoption's end, as `read` sees it: null for one this server does not know (a
     * restart forgets them), or another account's.
     */
    readonly watch: (ownerUserId: string, id: string) => Effect.Effect<WatchedAdoption | null>;
  }
>()("@mend/api/Adoptions") {}

/** How long an ended adoption stays readable. */
const KEPT_MS = 15 * 60_000;

interface Entry {
  readonly ownerUserId: string;
  readonly projectId: ProjectId;
  readonly ended: Deferred.Deferred<AdoptionEnd>;
  progress: AdoptionProgress;
}

/** One adoption's progress, moved on. */
const change = (entry: Entry, fields: Partial<AdoptionProgress>) => {
  entry.progress = new AdoptionProgress({
    ...entry.progress,
    ...fields,
    updatedAt: new Date(),
  });
};

export const AdoptionsLive: Layer.Layer<Adoptions> = Layer.effect(
  Adoptions,
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const entries = new Map<string, Entry>();

    const forgetEnded = (now: number) => {
      for (const [id, entry] of entries)
        if (
          entry.progress.state !== "running" &&
          now - entry.progress.updatedAt.getTime() > KEPT_MS
        )
          entries.delete(id);
    };

    const reporterOf = (entry: Entry): AdoptionReporter => ({
      store: (progress) =>
        progress._tag === "Checking"
          ? change(entry, { phase: "checking" })
          : change(entry, {
              phase: "cloning",
              git:
                progress.git === null
                  ? entry.progress.git
                  : new AdoptionGitProgress({ ...progress.git }),
            }),
      recording: () => change(entry, { phase: "recording" }),
    });

    const run = <E, R>(
      start: AdoptionStart,
      work: (report: AdoptionReporter) => Effect.Effect<Project, E, R>,
      failureOf: (error: E) => AdoptionFailure,
    ): Effect.Effect<Project, E, R> =>
      Effect.gen(function* () {
        const now = new Date();
        forgetEnded(now.getTime());
        // A key another account holds is not this one's to overwrite: it runs unreported.
        const held = entries.get(start.id);
        if (held !== undefined && held.ownerUserId !== start.ownerUserId)
          return yield* work({ store: () => undefined, recording: () => undefined });
        const entry: Entry = {
          ownerUserId: start.ownerUserId,
          projectId: start.projectId,
          ended: yield* Deferred.make<AdoptionEnd>(),
          progress: new AdoptionProgress({
            id: start.id,
            name: start.name,
            source: start.source,
            state: "running",
            phase: "preparing",
            git: null,
            projectId: null,
            failure: null,
            gitSaid: null,
            startedAt: now,
            updatedAt: now,
          }),
        };
        entries.set(start.id, entry);
        const settle = (exit: Exit.Exit<Project, E>) =>
          Effect.sync((): AdoptionEnd => {
            if (Exit.isSuccess(exit)) {
              change(entry, { state: "adopted", projectId: exit.value.id });
              return { _tag: "Adopted", projectId: exit.value.id };
            }
            const error = Cause.findErrorOption(exit.cause);
            const failed: AdoptionFailure = Option.isSome(error)
              ? failureOf(error.value)
              : {
                  failure: Cause.hasInterruptsOnly(exit.cause)
                    ? "The adoption was stopped before it finished."
                    : "Mend could not finish the adoption. The server log has the detail.",
                  gitSaid: null,
                };
            change(entry, { state: "failed", ...failed });
            return { _tag: "Failed", failure: failed.failure };
          }).pipe(Effect.flatMap((end) => Deferred.succeed(entry.ended, end)));
        const fiber = yield* work(reporterOf(entry)).pipe(
          Effect.onExit(settle),
          Effect.forkIn(scope),
        );
        return yield* Fiber.join(fiber);
      });

    const read = (ownerUserId: string, id: string) =>
      Effect.sync(() => {
        const entry = entries.get(id);
        return entry === undefined || entry.ownerUserId !== ownerUserId ? null : entry.progress;
      });

    const watch = (ownerUserId: string, id: string) =>
      Effect.sync((): WatchedAdoption | null => {
        const entry = entries.get(id);
        if (entry === undefined || entry.ownerUserId !== ownerUserId) return null;
        return {
          progress: entry.progress,
          projectId: entry.projectId,
          ended: Deferred.await(entry.ended),
        };
      });

    return { run, read, watch };
  }),
);
