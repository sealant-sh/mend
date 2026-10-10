import type { WorkspaceImage } from "@mend/domain";
import type {
  CreateOptions,
  Harness,
  SessionOptions,
  Workspace,
  WorkspaceCaptureOwnerMap,
  WorkspaceCredentialSkip,
  WorkspaceDotfilesManager,
  WorkspaceExecOptions,
  WorkspaceProcessUserCapability,
} from "@sealant/sdk";
import { Effect, Layer } from "effect";
import * as Context from "effect/Context";

import { SealantPlatformError } from "./errors.ts";

/**
 * The user a process starts as (docs/adr/0016, decision 1): what Mend allocated for a person. The
 * SDK's `user` option on sessions and exec (Core 0.39) takes the passwd name; sealantd then sets
 * uid, gid and supplementary groups, `HOME`, `USER`, `LOGNAME` and `SHELL` from the passwd entry,
 * and umask `0002`. Mend adds the private `TMPDIR=/tmp/u-<uid>` and
 * `XDG_RUNTIME_DIR=/run/user/<uid>` in the process's environment.
 */
export interface ProcessUser {
  readonly name: string;
  readonly uid: number;
  readonly gid: number;
  readonly groups: ReadonlyArray<number>;
  readonly home: string;
  readonly umask: number;
}

/** What sessions and exec take beside the SDK's own options. */
export interface ProcessUserOption {
  /** Absent: root, as every process ran before 0.36. */
  readonly user?: ProcessUser;
}

/**
 * A session's options: the SDK's, with Mend's `ProcessUser` in place of the SDK's `user` (a passwd
 * name or uid), which the client passes through as the name (`withProcessUser`).
 */
export type PersonSessionOptions = Omit<SessionOptions, "user"> & ProcessUserOption;

/** An exec's options, the same way (`PersonSessionOptions`). */
export type PersonExecOptions = Omit<WorkspaceExecOptions, "user"> & ProcessUserOption;

/**
 * Core's report on an image, read before create (decision 1; Core Delivery 8, from the image
 * build's probe of Delivery 9). Every field null while Core reports nothing.
 */
export interface ImageLayoutReport {
  /** The image digest Core will run for this request. */
  readonly digest: string | null;
  /** The runtime adapter Core will place it on (`docker`, `microvm`, …). */
  readonly runtime: string | null;
  /** Whether the image and runtime can run the person layout. */
  readonly person: boolean | null;
  /** What it lacks, in the words a refusal line names. */
  readonly missing: ReadonlyArray<string>;
}

export const UNKNOWN_IMAGE_REPORT: ImageLayoutReport = {
  digest: null,
  runtime: null,
  person: null,
  missing: [],
};

/**
 * A provider whose login Core writes into a home (decision 5): `pi` and `opencode` are the
 * ChatGPT logins Core makes from one of the person's Codex accounts, as entries of each tool's
 * own `auth.json` (sealant#336).
 */
export type LoginProvider = WorkspaceCredentialSkip["provider"];

export const LOGIN_PROVIDERS: ReadonlyArray<LoginProvider> = [
  "claude",
  "codex",
  "github",
  "pi",
  "opencode",
];

/**
 * What a POST puts into a home, per provider: `true` for the person's account named `default`, a
 * name for another of theirs, `null` to remove that provider's login from the home (they have not
 * connected it), absent to leave it as it is.
 */
export type HomeLogins = Partial<Record<LoginProvider, true | string | null>>;

/**
 * A provider a partial POST left out, and why (sealant#337): its account is missing, needs
 * reconnecting, or is not one the provider takes (a Codex account that is not a ChatGPT login,
 * named for pi or opencode), or its login file in the home cannot be written. Core removed that
 * provider's login from the home, as `null` would.
 */
export type LoginSkip = WorkspaceCredentialSkip;

/** One home of a running executor and the providers whose logins Core keeps there (`GET`). */
export interface HeldHome {
  readonly home: string;
  /** The Sealant user whose logins the home holds. */
  readonly onBehalfOf: string;
  readonly providers: ReadonlyArray<LoginProvider>;
}

/**
 * sealantd's capture owner map (docs/adr/0016, decision 8): who each restored
 * `people/<account id>` belongs to, and whose the worktree and its git directory are. Core's
 * `WorkspaceCaptureOwnerMap` (sealant#333), carried as a capture source's `ownerMap`; uids are
 * 40001–49999. sealantd reads it only at boot, so an executor keeps the map it booted with, and
 * its replan restores under it: a person standby boots with its owner's alone and serves only a
 * worktree that map is complete for (`standbyLayoutFor`), and a claim names the map it expects
 * (`captureReplan({ expectedOwnerMap })`).
 */
export type CaptureOwnerMap = WorkspaceCaptureOwnerMap;

/** One dotfiles tree, as the launch resolved it (a repository clone or the store's snapshot). */
export interface DotfilesArchive {
  readonly data: string;
  readonly manager: WorkspaceDotfilesManager;
  /** Run the tree's `./install.sh` once its files are applied. */
  readonly bootstrap: boolean;
}

/**
 * `./install.sh` of a person's dotfiles, started by sealantd as one managed process of that user
 * once every file is applied (`dotfiles.apply`'s `bootstrap`, sealantd#147): the caller starts the
 * person's agent beside it or after it (docs/adr/0016, decision 11).
 */
export interface DotfilesBootstrap {
  /**
   * Ends when the script does (Core's `bootstrap.wait()`): its exit code, a datum, so a failing
   * `install.sh` ends too. Fails (`dotfiles_failed`) when its end was not observed or it ran past
   * Core's 30 minutes.
   */
  readonly ended: Effect.Effect<{ readonly exitCode: number | null }, SealantPlatformError>;
}

/** What `applyDotfiles` answers once every file is applied, before any `install.sh` ends. */
export interface DotfilesApplied {
  /** Null when no tree had an `install.sh` to run (or its `bootstrap` setting is off). */
  readonly bootstrap: DotfilesBootstrap | null;
}

/**
 * The platform surface the person layout needs (docs/adr/0016, decisions 1, 5 and 11), behind one
 * contract so the engine is written against the ADR's stated interface. The live layer
 * (`PersonLayoutPlatformLive`, `person-layout-live.ts`) passes each piece through to Core's SDK
 * (0.39): processes as a user, the image's per-person capability before create, the credentials
 * API (one person per home), and a person's dotfiles applied as them (`workspace.dotfiles.apply`,
 * sealant#334).
 */
export class PersonLayoutPlatform extends Context.Service<
  PersonLayoutPlatform,
  {
    /** Sessions and exec can start a process as a given user (`ProcessUserOption`). */
    readonly processUser: boolean;
    /**
     * Why the control plane cannot run the person layout, in the words a refusal names, or null
     * when it can: read from what Core itself reports (`sealant.features()`: its as-user routes,
     * the dotfiles verb, partial puts, pi's and opencode's logins, the capture owner map; Core
     * 0.39.0-next.706), never learned by a launch failing later. Read only when a launch could be
     * person; kept a while.
     */
    readonly controlPlaneObstacle: Effect.Effect<string | null>;
    /**
     * Whether Core runs a workspace's SSH sessions (VS Code Remote-SSH, `ssh`) as the Linux user
     * its create names (`sshUser`, `features.workspaceSshUser`, sealant#348): read with
     * `controlPlaneObstacle`'s answer and kept as long. False when Core does not say so or cannot
     * be asked; a person launch then sends no user and its SSH sessions run as root, as before.
     */
    readonly sshUser: Effect.Effect<boolean>;
    /**
     * Who Core's gateway runs the workspace's SSH sessions as from the next session on: `null`,
     * root, for a person launch whose prepare fell back to one shared home (decision 1), so the
     * launcher's Remote-SSH works there as it did before. One attempt, bounded
     * (`SSH_USER_CALL_TIMEOUT`); never fails. True once Core holds it (or Core takes no user, so
     * there is nothing to set); false when Core refused or did not answer in time, which the
     * caller retries. Until then the gateway refuses the launcher's SSH sessions, never runs them
     * as root.
     */
    readonly setSshUser: (workspace: Workspace, user: string | null) => Effect.Effect<boolean>;
    /**
     * The workspace's own answer to whether its processes can start as a person
     * (`workspace.processUser()`, sealant#343): `supported` only when the sealantd of the image it
     * booted reports `exec.user`. A person launch runs only on `supported` (decision 1).
     */
    readonly workspaceProcessUser: (
      workspace: Workspace,
    ) => Effect.Effect<WorkspaceProcessUserCapability>;
    /**
     * `applyDotfiles` works: a person's dotfiles can be applied as them into their home. Where it
     * is false, a person launch follows decision 1's fallback for dotfiles
     * (`harness-layout-steps.ts`, `dotfilesBlocked`).
     */
    readonly dotfilesUser: boolean;
    /**
     * The create of a person launch with its capture owner map (`CaptureOwnerMap`) on its capture
     * source, so the executor's sealantd restores each person's files as theirs (decision 8). A
     * create that is not capture-sourced is left as it is.
     */
    readonly withOwnerMap: (options: CreateOptions, map: CaptureOwnerMap) => CreateOptions;
    /**
     * Core's report on the image a create would ask for, read before the create: as `ownerUserId`
     * (the launcher, whose built images Core answers from), for the image-shaping part of the
     * create (`image` and `harness`). Unknown when Core says nothing or cannot be asked.
     */
    readonly imageReport: (input: {
      readonly ownerUserId: string;
      readonly image: WorkspaceImage;
      readonly harness: Harness;
    }) => Effect.Effect<ImageLayoutReport>;
    /**
     * `POST /v1/workspaces/:id/credentials { onBehalfOf, home, uid?, gid?, claude?, codex?,
     * github?, pi?, opencode?, partial? }` (decision 5): the Mend account `onBehalfOf`'s logins
     * written into `home`, owned by that home's user, and kept refreshed. With `owner`, a home that
     * does not exist yet is made for them (so the POST runs beside the `useradd` that makes the
     * user). Core refuses another person for a held home (409 `home-held`). A refused account
     * fails a whole POST with `code` `connected-account-missing`, `-invalid` or `-unsupported` and
     * its `provider`, and nothing is written; a `partial` POST writes the rest and answers what it
     * left out in `skipped` (sealant#337).
     */
    readonly postCredentials: (
      workspace: Workspace,
      input: {
        readonly onBehalfOf: string;
        readonly home: string;
        readonly owner?: { readonly uid: number; readonly gid: number };
        readonly logins: HomeLogins;
        readonly partial?: boolean;
      },
    ) => Effect.Effect<{ readonly skipped: ReadonlyArray<LoginSkip> }, SealantPlatformError>;
    /** `DELETE /v1/workspaces/:id/credentials { home }`: the files and the record removed. */
    readonly deleteCredentials: (
      workspace: Workspace,
      input: { readonly home: string },
    ) => Effect.Effect<void, SealantPlatformError>;
    /**
     * A person's own login for a provider, as Core says it stands (their account named
     * `default`): `active`, `invalid` (it needs reconnecting), `missing`, or `unknown` when Core
     * could not be asked. What a steerer's turn is refused for at submit (docs/adr/0016, decision
     * 6; ADR 0013): "Connect Claude to steer this session."
     */
    readonly loginOf: (
      accountId: string,
      provider: LoginProvider,
    ) => Effect.Effect<"active" | "invalid" | "missing" | "unknown">;
    /** The Sealant user a Mend account acts as: what `GET` names a home's person by. */
    readonly sealantUserOf: (accountId: string) => Effect.Effect<string, SealantPlatformError>;
    /** `GET /v1/workspaces/:id/credentials`: the homes of the running executor. */
    readonly listCredentials: (
      workspace: Workspace,
    ) => Effect.Effect<ReadonlyArray<HeldHome>, SealantPlatformError>;
    /**
     * sealantd's dotfiles applier through Core's verb (`workspace.dotfiles.apply`, decision 11):
     * a person's dotfiles applied as `user` into `home`, their passwd home. Never as root: Core
     * refuses root (`user-root`), so decision 1's fallback to `/root` has no dotfiles. Answers
     * once every file is applied; `install.sh` (each tree whose `bootstrap` is on) then runs as
     * that user, beside the caller. A refusal fails with Core's code (`dotfiles-user-unsupported`,
     * `user-unknown`, `user-root`, `home-mismatch`, `home-unusable`, `home-held`,
     * `workspace-not-running`, or `dotfiles_failed` with the daemon's words).
     */
    readonly applyDotfiles: (
      workspace: Workspace,
      input: {
        /** The Mend account whose dotfiles these are. */
        readonly onBehalfOf: string;
        readonly user: ProcessUser;
        readonly home: string;
        readonly archives: ReadonlyArray<DotfilesArchive>;
      },
    ) => Effect.Effect<DotfilesApplied, SealantPlatformError>;
  }
>()("@mend/sealant/PersonLayoutPlatform") {}

/** A piece of the person layout this platform cannot do. */
export const personLayoutUnsupported = (what: string, delivery: string) =>
  new SealantPlatformError({
    code: "person_layout_unsupported",
    status: null,
    message: `this platform cannot ${what} yet (docs/adr/0016, ${delivery})`,
    cause: null,
  });

/**
 * A platform with none of the person layout: `processUser` false, so no launch is ever decided
 * `person`, and every call fails. For compositions and tests that never run the person layout.
 */
export const PersonLayoutPlatformNone: Layer.Layer<PersonLayoutPlatform> = Layer.succeed(
  PersonLayoutPlatform,
  {
    processUser: false,
    dotfilesUser: false,
    controlPlaneObstacle: Effect.succeed(null),
    sshUser: Effect.succeed(false),
    setSshUser: () => Effect.succeed(true),
    workspaceProcessUser: () => Effect.succeed("unsupported"),
    withOwnerMap: (options) => options,
    imageReport: () => Effect.succeed(UNKNOWN_IMAGE_REPORT),
    postCredentials: () =>
      Effect.fail(
        personLayoutUnsupported("write a person's logins into a home", "Core Delivery 7"),
      ),
    deleteCredentials: () =>
      Effect.fail(personLayoutUnsupported("release a home's logins", "Core Delivery 7")),
    loginOf: () => Effect.succeed("unknown"),
    sealantUserOf: () =>
      Effect.fail(personLayoutUnsupported("name a person's Sealant user", "Core Delivery 7")),
    listCredentials: () =>
      Effect.fail(personLayoutUnsupported("list a workspace's homes", "Core Delivery 7")),
    applyDotfiles: () =>
      Effect.fail(
        personLayoutUnsupported(
          "apply dotfiles as a person",
          "sealantd Delivery 5, Core Delivery 8",
        ),
      ),
  },
);

/**
 * Mend's line for a process Core or the SDK refused to start as a person (`user-unsupported`,
 * sealant#343; docs/adr/0016 decision 13), by the reason Core's words give: nothing was started,
 * and never as anyone else. Core gives the reason only in its message, so the lines read it there
 * (PLATFORM-FEEDBACK.md, 2026-10-08); an unknown one keeps Core's words. Any other failure as it is.
 */
export const personProcessRefusal = (error: SealantPlatformError): SealantPlatformError => {
  if (error.code !== "user-unsupported") return error;
  const words = error.message;
  const line = /doesn't run processes as another user|never starts a process as a user/.test(words)
    ? "This workspace cannot start processes as each person (its sealantd or runtime does not), so nothing was started."
    : /is not in range/.test(words)
      ? "This person's user in the workspace is outside the range Sealant runs processes as, so nothing was started."
      : /is not in workspace/.test(words)
        ? "This person's user does not exist in the workspace yet, so nothing was started. Start the session again."
        : /cannot be checked|did not answer|did not confirm|no way to reach/.test(words)
          ? "The workspace did not answer whether this person may run a process, so nothing was started. Start the session again."
          : /does not report the feature|could not be asked|answers 404/.test(words)
            ? "This Sealant control plane cannot start processes as each person, so nothing was started."
            : `Nothing was started as this person: ${words}`;
  return new SealantPlatformError({
    code: error.code,
    status: error.status,
    message: line,
    cause: error,
  });
};

/**
 * Runs `run` with the options as the SDK takes them: Mend's `ProcessUser` passed as its passwd
 * name, which the SDK sends only to a control plane that reports the feature and otherwise refuses
 * (`user-unsupported`) before anything starts, never running the process as root instead.
 */
export const withProcessUser = <O extends ProcessUserOption, A, E>(
  options: O | undefined,
  run: (options: (Omit<O, "user"> & { readonly user?: string }) | undefined) => Effect.Effect<A, E>,
): Effect.Effect<A, E> => {
  if (options === undefined) return run(undefined);
  const { user, ...rest } = options;
  return run(user === undefined ? rest : { ...rest, user: user.name });
};
