/**
 * The session engine's per-person steps (docs/adr/0016-per-person-harness-homes.md), behind
 * `MEND_HARNESS_LAYOUT`: the layout decided before create, what prepare runs and what it found,
 * the people an executor holds, and the user each of their processes starts as. With the flag off
 * and no worktree recorded `person`, a launch reads one row (the worktree's layout) and nothing
 * else here runs: no exec, no write.
 */
import { HarnessLayoutsRepo, type OrganizationsRepo } from "@mend/db";
import type { OrganizationId, WorkspaceImage, WorktreeId } from "@mend/domain";
import {
  type HarnessLayout,
  HarnessLayout as HarnessLayoutSchema,
  type HarnessLayoutSource,
  type LinuxIdentity,
  linuxHomeOf,
} from "@mend/domain/workbench";
import {
  PersonLayoutPlatform,
  type ProcessUser,
  SealantPlatformError,
  type SealantClientShape,
} from "@mend/sealant";
import type { Workspace, WorkspaceCredentialsOptions } from "@sealant/sdk";
import { Config, Effect, Layer } from "effect";
import * as Context from "effect/Context";

import {
  type LayoutCapability,
  type PrepareFinding,
  UNKNOWN_CAPABILITY,
  decideHarnessLayout,
  imageLayoutKeyOf,
  layoutProbeScript,
  ownerMapRefusal,
  parseLayoutReport,
  personHomeScript,
  personPrepareScript,
  personProcessEnv,
  processUserOf,
  staticLayoutObstacle,
  worktreeRepairScript,
} from "./harness-layout.ts";

// ─── configuration ───────────────────────────────────────────────────────────

/** `MEND_HARNESS_LAYOUT`: the layout of worktrees with none yet. `shared` until Delivery 21. */
export class HarnessLayoutConfig extends Context.Service<
  HarnessLayoutConfig,
  { readonly flag: HarnessLayout }
>()("@mend/sessions/HarnessLayoutConfig") {}

export const HarnessLayoutConfigLive: Layer.Layer<HarnessLayoutConfig, Config.ConfigError> =
  Layer.effect(
    HarnessLayoutConfig,
    Effect.gen(function* () {
      const flag = yield* Config.schema(HarnessLayoutSchema, "MEND_HARNESS_LAYOUT").pipe(
        Config.withDefault("shared" as const),
      );
      return { flag };
    }),
  );

/** The flag off, for tests and compositions that never run the person layout. */
export const HarnessLayoutConfigShared: Layer.Layer<HarnessLayoutConfig> = Layer.succeed(
  HarnessLayoutConfig,
  { flag: "shared" },
);

// ─── what a launch runs ──────────────────────────────────────────────────────

/**
 * A launch's layout, decided before its create. `recorded`: the decision is in
 * `executor_layouts` (anything but the flag-off default, which leaves no row: a launch with no
 * row is `shared`, as every launch before this release).
 */
export type LaunchLayout =
  | {
      readonly layout: "shared";
      readonly source: HarnessLayoutSource;
      readonly reason: string | null;
      /** Prepare runs the image probe and records what it found. */
      readonly probe: boolean;
      readonly imageKey: string | null;
      readonly runtime: string;
      readonly recorded: boolean;
    }
  | {
      readonly layout: "person";
      readonly source: HarnessLayoutSource;
      readonly onMissing: PrepareFinding;
      readonly launcher: LinuxIdentity;
      /** Current members of the organization other than the launcher, made when their saved directory is in the restored head. */
      readonly members: ReadonlyArray<LinuxIdentity>;
      readonly imageKey: string;
      readonly runtime: string;
    };

/** The flag-off launch: no row, no probe, exactly as before this release. */
export const SHARED_AS_BEFORE: LaunchLayout = {
  layout: "shared",
  source: "flag",
  reason: null,
  probe: false,
  imageKey: null,
  runtime: "unknown",
  recorded: false,
};

/** A launch refused before create, with the line the session settles on (decision 14). */
export const layoutRefused = (message: string) =>
  new SealantPlatformError({ code: "harness_layout_refused", status: 409, message, cause: null });

/** What prepare found, once the executor exists. */
export type PrepareOutcome =
  | { readonly layout: "person" }
  | { readonly layout: "shared"; readonly fallback: string | null };

/** Until Delivery 18, a turn from anyone but the process's person is refused in a person executor. */
export const PERSON_STEER_REFUSAL =
  "This session's workspace runs each person as their own user, and turns from anyone but its owner arrive with per-person steering. Until then only the owner sends turns here.";

export interface HarnessLayoutSteps {
  readonly flag: HarnessLayout;
  /** The layout of a capture-mode launch, before its create; a refusal fails with its line. */
  readonly decide: (input: {
    readonly worktreeId: WorktreeId;
    readonly sessionId: string;
    readonly launchId: string;
    readonly ownerUserId: string;
    readonly organizationId: OrganizationId;
    /** The image the create will ask for (read only when the flag or the worktree asks). */
    readonly image: Effect.Effect<WorkspaceImage>;
    /** Whether the worktree's head capture holds `harness/people/` (read only when needed). */
    readonly headHasPeople: Effect.Effect<boolean>;
  }) => Effect.Effect<LaunchLayout, SealantPlatformError>;
  /**
   * Whether any executor of the worktree can run the person layout: the flag on, or the worktree
   * already person. One row read; with neither, a process start asks nothing else here.
   */
  readonly mayRunPerson: (worktreeId: WorktreeId) => Effect.Effect<boolean>;
  /** Whether a standby (created before any worktree is known, as root) may serve the worktree. */
  readonly standbyMayServe: (worktreeId: WorktreeId) => Effect.Effect<boolean>;
  /** What prepare runs in the executor's first exec for this layout, after the helper install. */
  readonly prepareScript: (
    layout: LaunchLayout,
    places: { readonly harnessHome: string; readonly repo: string },
  ) => string | null;
  /**
   * What prepare's output says, recorded: the person layout confirmed (the worktree is person
   * from now on), a fallback to shared on a fresh worktree (the launcher's logins and dotfiles put
   * where a shared executor reads them first), or a refusal.
   */
  readonly settlePrepare: (input: {
    readonly layout: LaunchLayout;
    readonly launchId: string;
    readonly worktreeId: WorktreeId;
    readonly workspace: Workspace;
    readonly stdout: string;
    readonly fallback: {
      readonly credentials: WorkspaceCredentialsOptions | undefined;
      readonly dotfiles: ReadonlyArray<{
        readonly data: string;
        readonly manager: string;
        readonly bootstrap: boolean;
      }>;
    };
  }) => Effect.Effect<PrepareOutcome, SealantPlatformError>;
  /** The layout of the executor a launch made: its record, or `shared` without one. */
  readonly layoutOfLaunch: (launchId: string | null) => Effect.Effect<HarnessLayout>;
  /**
   * The user a person's process starts as in a person-layout executor, made there first when it
   * is their first process (one exec), and the worktree repair started when the person differs
   * from the last one whose process started there (one exec, never awaited). Null in a shared
   * executor: the process runs as root, as before.
   */
  readonly processAs: (input: {
    readonly workspace: Workspace;
    readonly launchId: string | null;
    readonly accountId: string;
  }) => Effect.Effect<
    { readonly user: ProcessUser; readonly env: Readonly<Record<string, string>> } | null,
    SealantPlatformError
  >;
  /** The refusal of a turn whose author is not the process's person, in a person executor. */
  readonly turnRefusal: (input: {
    readonly launchId: string | null;
    readonly ownerUserId: string | null;
    readonly author: string | null;
  }) => Effect.Effect<string | null>;
}

/** What prepare runs for a layout (`HarnessLayoutSteps.prepareScript`). */
export const layoutPrepareScript: HarnessLayoutSteps["prepareScript"] = (layout, places) => {
  if (layout.layout === "person") {
    return personPrepareScript(
      [
        { person: layout.launcher, ifSaved: false },
        ...layout.members.map((person) => ({ person, ifSaved: true })),
      ],
      places,
    );
  }
  return layout.probe ? layoutProbeScript([]) : null;
};

const BOUND = 2_048;
/** A map that forgets everything at a bound: what it holds is a cache, rebuilt on a miss. */
const bounded = <K, V>() => {
  const map = new Map<K, V>();
  return {
    get: (key: K) => map.get(key),
    set: (key: K, value: V) => {
      if (map.size >= BOUND) map.clear();
      map.set(key, value);
    },
  };
};

export const makeHarnessLayoutSteps = (deps: {
  readonly flag: HarnessLayout;
  readonly repo: HarnessLayoutsRepo["Service"];
  readonly platform: PersonLayoutPlatform["Service"];
  readonly organizations: OrganizationsRepo["Service"];
  readonly sealant: Pick<SealantClientShape, "exec">;
  readonly harnessHome: string;
  /** Starts work that nothing waits on (the worktree repair). */
  readonly fork: (effect: Effect.Effect<void>) => Effect.Effect<void>;
}): HarnessLayoutSteps => {
  const { flag, repo, platform, sealant } = deps;
  const layoutByLaunch = bounded<string, HarnessLayout>();
  /** The people already made in an executor, per workspace. */
  const madeIn = bounded<string, Set<string>>();
  /** Whose process started last in an executor's worktree, per workspace. */
  const lastIn = bounded<string, string>();

  const capabilityFor = Effect.fn("HarnessLayoutSteps.capabilityFor")(function* (
    image: WorkspaceImage,
  ) {
    const obstacle = staticLayoutObstacle(image, { processUser: platform.processUser });
    if (obstacle !== null) {
      return {
        capability: { person: false, missing: [obstacle], source: "static" } as const,
        imageKey: imageLayoutKeyOf(image, null),
        runtime: "unknown",
      };
    }
    const report = yield* platform.imageReport(image);
    const imageKey = imageLayoutKeyOf(image, report.digest);
    const runtime = report.runtime ?? "unknown";
    // Mend's record of what a prepare found wins over Core's report for the same image.
    const recorded = yield* repo.capabilityOf(imageKey, runtime);
    const capability: LayoutCapability =
      recorded !== null
        ? { person: recorded.person, missing: recorded.missing, source: "mend" }
        : report.person !== null
          ? { person: report.person, missing: report.missing, source: "core" }
          : UNKNOWN_CAPABILITY;
    return { capability, imageKey, runtime };
  });

  const membersOf = Effect.fn("HarnessLayoutSteps.membersOf")(function* (
    organizationId: OrganizationId,
    launcher: string,
  ) {
    const members = yield* deps.organizations.members(organizationId);
    return yield* repo.identitiesOf(
      members.map((member) => member.userId).filter((id) => id !== launcher),
    );
  });

  const decide: HarnessLayoutSteps["decide"] = Effect.fn("HarnessLayoutSteps.decide")(
    function* (input) {
      const worktree = yield* repo.worktreeLayout(input.worktreeId);
      // Nothing asks for person: as before, nothing read, nothing recorded.
      if (worktree.layout === null && worktree.requested === null && flag === "shared") {
        return SHARED_AS_BEFORE;
      }
      // The record is written before any person process runs; the head is read as a belt only
      // where the flag is on and the worktree has no record.
      const headHasPeople =
        worktree.layout === null && flag === "person" ? yield* input.headHasPeople : false;
      const { capability, imageKey, runtime } = yield* capabilityFor(yield* input.image);
      const decision = decideHarnessLayout({ flag, worktree, headHasPeople, capability });
      if (decision.kind === "refuse") return yield* layoutRefused(decision.message);
      if (decision.layout === "shared") {
        yield* repo.recordLaunch({
          launchId: input.launchId,
          worktreeId: input.worktreeId,
          sessionId: input.sessionId,
          layout: "shared",
          source: decision.source,
          reason: decision.reason,
          imageKey,
          confirmed: !decision.probe,
        });
        layoutByLaunch.set(input.launchId, "shared");
        return {
          layout: "shared",
          source: decision.source,
          reason: decision.reason,
          probe: decision.probe,
          imageKey,
          runtime,
          recorded: true,
        };
      }
      const launcher = yield* repo
        .ensureIdentity(input.ownerUserId)
        .pipe(Effect.mapError((error) => layoutRefused(error.message)));
      const members = yield* membersOf(input.organizationId, input.ownerUserId);
      yield* repo.recordLaunch({
        launchId: input.launchId,
        worktreeId: input.worktreeId,
        sessionId: input.sessionId,
        layout: "person",
        source: decision.source,
        reason: null,
        imageKey,
        confirmed: false,
      });
      layoutByLaunch.set(input.launchId, "person");
      return {
        layout: "person",
        source: decision.source,
        onMissing: decision.onMissing,
        launcher,
        members,
        imageKey,
        runtime,
      };
    },
  );

  const mayRunPerson: HarnessLayoutSteps["mayRunPerson"] = Effect.fn(
    "HarnessLayoutSteps.mayRunPerson",
  )(function* (worktreeId) {
    if (flag === "person") return true;
    return (yield* repo.worktreeLayout(worktreeId)).layout === "person";
  });

  const standbyMayServe: HarnessLayoutSteps["standbyMayServe"] = Effect.fn(
    "HarnessLayoutSteps.standbyMayServe",
  )(function* (worktreeId) {
    if (flag === "person") return false;
    const worktree = yield* repo.worktreeLayout(worktreeId);
    return worktree.layout === null && worktree.requested !== "person";
  });

  const settlePrepare: HarnessLayoutSteps["settlePrepare"] = Effect.fn(
    "HarnessLayoutSteps.settlePrepare",
  )(function* (input) {
    const { layout } = input;
    if (layout.layout === "shared") {
      if (!layout.probe) return { layout: "shared", fallback: null };
      const report = parseLayoutReport(input.stdout);
      if (report.probed && layout.imageKey !== null) {
        yield* repo.recordCapability({
          imageKey: layout.imageKey,
          runtime: layout.runtime,
          person: report.missing.length === 0,
          missing: report.missing,
        });
      }
      yield* repo.confirm(input.launchId);
      return { layout: "shared", fallback: null };
    }
    const report = parseLayoutReport(input.stdout);
    // The restore, not the image: nothing is recorded against the image, and the launch is
    // refused whatever the worktree, since nobody could edit what came back.
    if (report.unowned !== null) return yield* layoutRefused(ownerMapRefusal(report.unowned));
    if (report.ready) {
      yield* repo.recordCapability({
        imageKey: layout.imageKey,
        runtime: layout.runtime,
        person: true,
        missing: [],
      });
      yield* repo.confirmPerson(input.launchId, input.worktreeId);
      // Only the people this prepare says it made: a member with an identity (made in some other
      // worktree) whose saved directory did not come back with this head was skipped, and is
      // made at their first process here.
      const made = new Set(report.made);
      madeIn.set(
        input.workspace.id,
        new Set(
          [layout.launcher, ...layout.members]
            .filter((person) => made.has(person.name))
            .map((person) => person.accountId),
        ),
      );
      lastIn.set(input.workspace.id, layout.launcher.accountId);
      return { layout: "person" };
    }
    const missing =
      report.missing.length > 0
        ? report.missing
        : [report.probed ? "the users could not be made" : "the image could not be checked"];
    if (report.probed && report.missing.length > 0) {
      yield* repo.recordCapability({
        imageKey: layout.imageKey,
        runtime: layout.runtime,
        person: false,
        missing,
      });
    }
    if (layout.onMissing === "refuse") {
      return yield* layoutRefused(
        layout.source === "operator"
          ? `harnessLayout person was asked for, and this image cannot run per-person users (${missing.join(", ")}).`
          : `This worktree's sessions are saved per person, and its image cannot run per-person users (${missing.join(", ")}). Pick an image that can, or start a new worktree.`,
      );
    }
    // A wrong prediction never leaves an agent without a login: the create-time home is released,
    // the launcher's logins are written to `/root` and their dotfiles applied there, before
    // anything starts. Any of it failing fails the launch.
    const home = linuxHomeOf(layout.launcher);
    yield* platform.deleteCredentials(input.workspace, { home });
    yield* platform.postCredentials(input.workspace, {
      onBehalfOf: layout.launcher.accountId,
      home: "/root",
      credentials: input.fallback.credentials ?? {},
    });
    if (input.fallback.dotfiles.length > 0) {
      yield* platform.applyDotfiles(input.workspace, {
        user: null,
        home: "/root",
        archives: input.fallback.dotfiles,
      });
    }
    const reason = `this image cannot run per-person users (${missing.join(", ")}), so this workspace takes one person`;
    yield* repo.recordFallback(input.launchId, reason);
    layoutByLaunch.set(input.launchId, "shared");
    return { layout: "shared", fallback: reason };
  });

  const layoutOfLaunch: HarnessLayoutSteps["layoutOfLaunch"] = Effect.fn(
    "HarnessLayoutSteps.layoutOfLaunch",
  )(function* (launchId) {
    if (launchId === null) return "shared";
    const known = layoutByLaunch.get(launchId);
    if (known !== undefined) return known;
    const record = yield* repo.launchLayout(launchId);
    // Only a confirmed person launch runs as people; anything else ran as root.
    const layout: HarnessLayout =
      record !== null && record.layout === "person" && record.confirmed ? "person" : "shared";
    layoutByLaunch.set(launchId, layout);
    return layout;
  });

  const processAs: HarnessLayoutSteps["processAs"] = Effect.fn("HarnessLayoutSteps.processAs")(
    function* (input) {
      if ((yield* layoutOfLaunch(input.launchId)) !== "person") return null;
      const identity = yield* repo
        .ensureIdentity(input.accountId)
        .pipe(Effect.mapError((error) => layoutRefused(error.message)));
      const made = madeIn.get(input.workspace.id) ?? new Set<string>();
      if (!made.has(identity.accountId)) {
        // Their first process in this executor: their user, home and saved directory (one exec,
        // idempotent, so a server restart that forgot costs one more and changes nothing).
        const result = yield* sealant.exec(input.workspace, [
          "sh",
          "-c",
          personHomeScript(identity, { harnessHome: deps.harnessHome }),
        ]);
        if (result.exitCode !== 0) {
          return yield* new SealantPlatformError({
            code: "person_user_not_made",
            status: null,
            message: `${identity.name} could not be made in this workspace: ${result.stderr.trim()}`,
            cause: null,
          });
        }
        made.add(identity.accountId);
        madeIn.set(input.workspace.id, made);
      }
      const last = lastIn.get(input.workspace.id);
      if (last !== undefined && last !== identity.accountId) {
        // Another person's process starts in the worktree: what earlier processes left without
        // group write is repaired, off the critical path.
        yield* deps.fork(
          sealant.exec(input.workspace, ["sh", "-c", worktreeRepairScript()]).pipe(
            Effect.tap((result) =>
              Effect.logInfo("session engine: worktree repair · observed").pipe(
                Effect.annotateLogs({
                  workspaceId: input.workspace.id,
                  exitCode: result.exitCode,
                  repaired: result.stdout.split("\n").filter((line) => line.length > 0).length,
                }),
              ),
            ),
            Effect.catch((error) =>
              Effect.logWarning("session engine: worktree repair did not run").pipe(
                Effect.annotateLogs({ workspaceId: input.workspace.id, message: error.message }),
              ),
            ),
            Effect.asVoid,
          ),
        );
      }
      lastIn.set(input.workspace.id, identity.accountId);
      return {
        user: processUserOf(identity),
        env: personProcessEnv(deps.harnessHome, identity),
      };
    },
  );

  const turnRefusal: HarnessLayoutSteps["turnRefusal"] = Effect.fn(
    "HarnessLayoutSteps.turnRefusal",
  )(function* (input) {
    if (input.author === null || input.author === input.ownerUserId) return null;
    return (yield* layoutOfLaunch(input.launchId)) === "person" ? PERSON_STEER_REFUSAL : null;
  });

  return {
    flag,
    decide,
    mayRunPerson,
    standbyMayServe,
    prepareScript: layoutPrepareScript,
    settlePrepare,
    layoutOfLaunch,
    processAs,
    turnRefusal,
  };
};
