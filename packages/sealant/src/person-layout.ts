import type { WorkspaceImage } from "@mend/domain";
import type { Workspace, WorkspaceCredentialsOptions } from "@sealant/sdk";
import { Effect, Layer } from "effect";
import * as Context from "effect/Context";

import { SealantPlatformError } from "./errors.ts";

/**
 * The user a process starts as (docs/adr/0016, decision 1): the SDK's `user` option on sessions
 * and exec, which Core (Delivery 8) and sealantd (Delivery 5) have not built yet. sealantd sets
 * uid, gid and supplementary groups, `HOME`, `USER`, `LOGNAME` and `SHELL` from the passwd entry,
 * umask `0002`, and the private `TMPDIR=/tmp/u-<uid>` and `XDG_RUNTIME_DIR=/run/user/<uid>`.
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
 * The platform surface the person layout needs beyond today's SDK (docs/adr/0016, decisions 1,
 * 5 and 11), behind one contract so the engine is written against the ADR's stated interface.
 * Its live layer says, truthfully, that this platform has none of it: `processUser` false, so
 * no launch is ever decided `person`, and every call fails with the Delivery that adds it. When
 * Core's SDK gains a piece, the live layer passes it through here and nowhere else changes.
 */
export class PersonLayoutPlatform extends Context.Service<
  PersonLayoutPlatform,
  {
    /** Sessions and exec can start a process as a given user (`ProcessUserOption`). */
    readonly processUser: boolean;
    /** Core's report on the image a create would ask for, read before the create. */
    readonly imageReport: (image: WorkspaceImage) => Effect.Effect<ImageLayoutReport>;
    /**
     * `POST /v1/workspaces/:id/credentials { onBehalfOf, home, claude?, codex?, github? }`
     * (decision 5): the person's logins written into `home`, owned by that home's user, and kept
     * refreshed. Core refuses another person for a held home (409 `home-held`).
     */
    readonly postCredentials: (
      workspace: Workspace,
      input: {
        readonly onBehalfOf: string;
        readonly home: string;
        readonly credentials: WorkspaceCredentialsOptions;
      },
    ) => Effect.Effect<void, SealantPlatformError>;
    /** `DELETE /v1/workspaces/:id/credentials { home }`: the files and the record removed. */
    readonly deleteCredentials: (
      workspace: Workspace,
      input: { readonly home: string },
    ) => Effect.Effect<void, SealantPlatformError>;
    /**
     * sealantd's dotfiles applier through the control verb (decision 11; sealantd Delivery 5,
     * Core Delivery 8): a person's dotfiles applied as `user` into `home`, or as root into `home`
     * when `user` is null (decision 1's fallback to `/root`).
     */
    readonly applyDotfiles: (
      workspace: Workspace,
      input: {
        readonly user: ProcessUser | null;
        readonly home: string;
        readonly archives: ReadonlyArray<{
          readonly data: string;
          readonly manager: string;
          readonly bootstrap: boolean;
        }>;
      },
    ) => Effect.Effect<void, SealantPlatformError>;
  }
>()("@mend/sealant/PersonLayoutPlatform") {}

const unsupported = (what: string, delivery: string) =>
  new SealantPlatformError({
    code: "person_layout_unsupported",
    status: null,
    message: `this platform cannot ${what} yet (docs/adr/0016, ${delivery})`,
    cause: null,
  });

/** Today's platform: none of it. No launch is decided `person` on it (`processUser` false). */
export const PersonLayoutPlatformLive: Layer.Layer<PersonLayoutPlatform> = Layer.succeed(
  PersonLayoutPlatform,
  {
    processUser: false,
    imageReport: () => Effect.succeed(UNKNOWN_IMAGE_REPORT),
    postCredentials: () =>
      Effect.fail(unsupported("write a person's logins into a home", "Core Deliveries 7 and 8")),
    deleteCredentials: () =>
      Effect.fail(unsupported("release a home's logins", "Core Deliveries 7 and 8")),
    applyDotfiles: () =>
      Effect.fail(
        unsupported("apply dotfiles as a person", "sealantd Delivery 5, Core Delivery 8"),
      ),
  },
);

/**
 * A request for a user the SDK cannot start: refused rather than run as root, which in a
 * person-layout executor would be nobody's process with everybody's files.
 */
export const processUserUnsupported = (argv: ReadonlyArray<string>) =>
  new SealantPlatformError({
    code: "process_user_unsupported",
    status: null,
    message: `this platform cannot start a process as a user yet (docs/adr/0016, Core Delivery 8): ${argv[0] ?? ""}`,
    cause: null,
  });

/** A create naming a home for the launcher's logins, which the SDK cannot send yet. */
export const credentialsHomeUnsupported = () =>
  new SealantPlatformError({
    code: "credentials_home_unsupported",
    status: null,
    message:
      "this platform cannot write the launcher's logins into their own home yet (docs/adr/0016, Core Delivery 8)",
    cause: null,
  });

/**
 * Runs `run` only when no user is asked for: today's SDK starts every process as root, so a
 * process asked for as a person is refused before anything reaches the platform.
 */
export const withoutProcessUser = <A, E>(
  argv: ReadonlyArray<string>,
  options: ProcessUserOption | undefined,
  run: () => Effect.Effect<A, E>,
): Effect.Effect<A, E | SealantPlatformError> =>
  options?.user === undefined ? run() : Effect.fail(processUserUnsupported(argv));
