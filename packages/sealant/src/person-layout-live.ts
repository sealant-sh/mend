/**
 * The person layout's platform surface (docs/adr/0016), passed through to Core's SDK (0.39): the
 * image's per-person capability before create (`workspaces.inspectImage`), processes as a user
 * (`withProcessUser`, in the client), one person's logins per home of a running executor
 * (`workspace.credentials`), and a person's dotfiles applied as them (`workspace.dotfiles`). Mend
 * names people by their Mend account; Core by their Sealant user, which the identity mapping
 * answers from Mend's own table.
 */
import type { WorkspaceImage } from "@mend/domain";
import type {
  CreateOptions,
  Harness,
  WorkspaceCredentialHome,
  WorkspaceImageInspection,
  WorkspaceImagePersonLayout,
  SealantFeatures,
  Workspace,
  WorkspaceProcessUserCapability,
} from "@sealant/sdk";
import { Clock, Duration, Effect, Layer, Option } from "effect";

import { SealantClients, toPlatformError } from "./client.ts";
import { SealantPlatformError } from "./errors.ts";
import {
  type HeldHome,
  type ImageLayoutReport,
  LOGIN_PROVIDERS,
  type LoginProvider,
  PersonLayoutPlatform,
  UNKNOWN_IMAGE_REPORT,
} from "./person-layout.ts";

const call = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: toPlatformError });

/**
 * How long a write or release of a home's logins may take: Mend holds that person's lock across
 * it, so a call Core never answers must not hold their next start for the transport's own minutes.
 */
const CREDENTIALS_CALL_TIMEOUT = Duration.seconds(30);

/** `call`, bounded by `CREDENTIALS_CALL_TIMEOUT`, failing with words when Core does not answer. */
const boundedCall = <A>(what: string, home: string, run: () => Promise<A>) =>
  call(run).pipe(
    Effect.timeoutOrElse({
      duration: CREDENTIALS_CALL_TIMEOUT,
      orElse: () =>
        Effect.fail(
          new SealantPlatformError({
            code: "credentials_timeout",
            status: null,
            message: `Sealant did not answer the ${what} of ${home}'s logins within 30 s; nothing is taken as done`,
            cause: null,
          }),
        ),
    }),
  );

/** The words a refusal line names for each of Core's stable codes; an unknown code as it is. */
const MISSING_WORDS: Readonly<Record<string, string>> = {
  sudo: "no sudo",
  "setuid-sudo": "no sudo",
  useradd: "no useradd",
  setfacl: "no setfacl",
  setpriv: "no setpriv",
  acl: "no ACLs on /workspace",
  nix: "nix images run one person",
  sealantd: "its sealantd cannot run processes as a user",
  "exec.user": "its sealantd cannot run processes as a user",
  "dotfiles.user": "its sealantd cannot run processes as a user",
  "restore.owner_map": "its sealantd cannot run processes as a user",
  "reserved-ids": "a uid or gid in 40000–49999 is taken in this image",
};

/** Core's per-person capability, as the layout decision reads it (decision 1). */
export const imageLayoutReportOf = (inspection: WorkspaceImageInspection): ImageLayoutReport => {
  const layout: WorkspaceImagePersonLayout = inspection.personLayout;
  return {
    digest: inspection.image?.digest ?? null,
    runtime: layout.runtime,
    person: layout.status === "supported" ? true : layout.status === "unsupported" ? false : null,
    missing: [...new Set(layout.missing.map((code) => MISSING_WORDS[code] ?? code))],
  };
};

/**
 * The source an image question names. `workspaces.imageKey` and `workspaces.inspectImage` build
 * the whole create request, which refuses options without exactly one source, though neither
 * reads it: the key leaves the sources out, and Core's plan reads only whether the source is a
 * mount (its `safe.directory` step). The layout is decided only for a capture-mode launch, whose
 * create is capture-sourced, so the question names a capture source too. Its endpoint reaches
 * Core in the inspected spec and is never dialled; its token never leaves this process
 * (`inspectImage` sends the spec alone, never `captureToken`).
 */
export const IMAGE_QUESTION_SOURCE = {
  kind: "capture",
  endpoint: "https://image-question.mend.invalid",
  token: "never-sent",
} as const satisfies CreateOptions["source"];

/**
 * The image-shaping part of a create, as the engine's create asks for the same image, with the
 * source an image question names (`IMAGE_QUESTION_SOURCE`).
 */
export const imageCreateOptionsOf = (image: WorkspaceImage, harness: Harness): CreateOptions => ({
  source: IMAGE_QUESTION_SOURCE,
  harness,
  ...(image.mode === "custom" ? { baseImage: image.baseImage } : { os: image.os }),
  ...(image.mode === "family" && image.shell !== "bash" ? { shell: image.shell } : {}),
  packages: image.packages,
  services: image.services,
});

/** A home as `GET` lists it, with the providers whose logins Core keeps there. */
export const heldHomeOf = (home: WorkspaceCredentialHome): HeldHome => ({
  home: home.home,
  onBehalfOf: home.onBehalfOf,
  providers: LOGIN_PROVIDERS.filter(
    (provider: LoginProvider) => home.accounts[provider] !== undefined,
  ),
});

/**
 * How long an answer about an image is kept before Core is asked again: a capability changes only
 * with a new build (a new digest), so a yes or a no lasts a day; an unknown (nothing built yet)
 * ten minutes, so a build that lands is seen soon.
 */
const IMAGE_ANSWER_MS = 24 * 60 * 60_000;
const UNKNOWN_IMAGE_ANSWER_MS = 10 * 60_000;
const IMAGE_ANSWERS = 512;

/** How long the control plane's answer about itself is kept: an upgrade is seen within it. */
const CONTROL_PLANE_ANSWER_MS = 5 * 60_000;
/** How long an unreadable answer is kept before the control plane is asked again. */
const CONTROL_PLANE_FAILURE_MS = 15_000;

/**
 * The features the person layout uses, each one Core reports (`sealant.features()`, Core
 * 0.39.0-next.706): a control plane from before any of them reports it false.
 */
const PERSON_LAYOUT_FEATURES = [
  "processUserRoutes",
  "dotfilesApply",
  "credentialsPartialPut",
  "credentialsPiOpencode",
  "captureOwnerMap",
] as const satisfies ReadonlyArray<keyof SealantFeatures>;

/**
 * Why a control plane cannot run the person layout, in the words a refusal names, or null when it
 * reports every feature the layout uses. Its as-user routes first: without them no process starts
 * as a person at all.
 */
export const controlPlaneObstacleOf = (features: SealantFeatures): string | null => {
  const missing = PERSON_LAYOUT_FEATURES.filter((feature) => !features[feature]);
  if (missing.length === 0) return null;
  return missing.includes("processUserRoutes")
    ? `the Sealant control plane does not run processes as a user (it does not report ${missing.join(", ")})`
    : `the Sealant control plane lacks what per-person users need (it does not report ${missing.join(", ")})`;
};

/**
 * Core runs a workspace's SSH sessions as the user its create names (`features.workspaceSshUser`,
 * sealant#348). Read by name: the SDK Mend pins may not declare it yet, and a control plane from
 * before it does not report it.
 */
export const runsSshAsUser = (features: SealantFeatures): boolean =>
  "workspaceSshUser" in features && features.workspaceSshUser === true;

/** A workspace handle whose SDK sets its SSH user (`workspace.setSshUser`, sealant#348). */
interface SshUserSettable {
  readonly setSshUser: (user: string | null) => Promise<void>;
}

const setsSshUser = (workspace: Workspace): workspace is Workspace & SshUserSettable =>
  "setSshUser" in workspace && typeof workspace.setSshUser === "function";

/** The workspace's own answer (`workspace.processUser()`), as a prepare's missing words. */
export const workspaceProcessUserObstacleOf = (
  capability: WorkspaceProcessUserCapability,
): string | null =>
  capability === "supported"
    ? null
    : capability === "unsupported"
      ? "its sealantd cannot run processes as a user"
      : "Sealant could not say whether this workspace runs processes as a user";
/** The control plane could not be asked: unknown is no, for a layout every process depends on. */
export const CONTROL_PLANE_UNREADABLE =
  "the Sealant control plane could not be asked whether it runs processes as a user";

export const PersonLayoutPlatformLive: Layer.Layer<PersonLayoutPlatform, never, SealantClients> =
  Layer.effect(
    PersonLayoutPlatform,
    Effect.gen(function* () {
      const clients = yield* SealantClients;
      /**
       * Core's answer per image key, kept (Core: "call `inspectImage` only for a key you have not
       * seen"): at most one call per image while the answer lasts, and Mend's own record of what
       * a prepare found wins over it from the first launch on (decision 1).
       */
      const answers = new Map<
        string,
        { readonly report: ImageLayoutReport; readonly at: number }
      >();

      const imageReport = Effect.fn("PersonLayoutPlatform.imageReport")(function* (input: {
        readonly ownerUserId: string;
        readonly image: WorkspaceImage;
        readonly harness: Harness;
      }) {
        const options = imageCreateOptionsOf(input.image, input.harness);
        // Options the SDK refuses are a fault of Mend's: said in the log, and the capability is
        // unknown (as a question Core cannot answer is), never a launch that fails before create.
        const imageKey = yield* clients.imageKey(options).pipe(
          Effect.tapError((error) =>
            Effect.logError("person layout: the image's key was not computed").pipe(
              Effect.annotateLogs({ message: error.message }),
            ),
          ),
          Effect.option,
        );
        if (Option.isNone(imageKey)) return UNKNOWN_IMAGE_REPORT;
        const key = `${input.ownerUserId}\u0000${imageKey.value}`;
        const now = yield* Clock.currentTimeMillis;
        const known = answers.get(key);
        if (
          known !== undefined &&
          now - known.at <
            (known.report.person === null ? UNKNOWN_IMAGE_ANSWER_MS : IMAGE_ANSWER_MS)
        ) {
          return known.report;
        }
        const report = yield* clients.inspectImage(input.ownerUserId, options).pipe(
          Effect.map(imageLayoutReportOf),
          // Unknown, never a refusal: the launch runs shared and its prepare records the answer.
          Effect.catch((error) =>
            Effect.logWarning("person layout: the image's capability was not read").pipe(
              Effect.annotateLogs({ message: error.message }),
              Effect.as(UNKNOWN_IMAGE_REPORT),
            ),
          ),
        );
        answers.delete(key);
        if (answers.size >= IMAGE_ANSWERS) {
          const oldest = answers.keys().next();
          if (oldest.done !== true) answers.delete(oldest.value);
        }
        answers.set(key, { report, at: now });
        return report;
      });

      let controlPlane: {
        readonly obstacle: string | null;
        readonly sshUser: boolean;
        readonly until: number;
      } | null = null;
      const controlPlaneAnswer = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (controlPlane !== null && now < controlPlane.until) return controlPlane;
        const answer = yield* clients.controlPlaneFeatures().pipe(
          Effect.map((features) => ({
            obstacle: controlPlaneObstacleOf(features),
            sshUser: runsSshAsUser(features),
            until: now + CONTROL_PLANE_ANSWER_MS,
          })),
          Effect.catch((error) =>
            Effect.logWarning("person layout: the control plane's features were not read").pipe(
              Effect.annotateLogs({ message: error.message }),
              Effect.as({
                obstacle: CONTROL_PLANE_UNREADABLE,
                sshUser: false,
                until: now + CONTROL_PLANE_FAILURE_MS,
              }),
            ),
          ),
        );
        controlPlane = answer;
        return answer;
      });
      const controlPlaneObstacle = controlPlaneAnswer.pipe(
        Effect.map((answer) => answer.obstacle),
        Effect.withSpan("PersonLayoutPlatform.controlPlaneObstacle"),
      );

      return {
        processUser: true,
        controlPlaneObstacle,
        sshUser: controlPlaneAnswer.pipe(Effect.map((answer) => answer.sshUser)),
        // `workspace.setSshUser` (sealant#348), only where Core said it takes a user; an SDK
        // from before it has no such method, and its creates never sent one.
        setSshUser: (workspace, user) =>
          Effect.gen(function* () {
            if (!(yield* controlPlaneAnswer).sshUser || !setsSshUser(workspace)) return;
            yield* call(() => workspace.setSshUser(user)).pipe(
              Effect.catch((error) =>
                Effect.logWarning("person layout: the workspace's SSH user was not set").pipe(
                  Effect.annotateLogs({ workspaceId: workspace.id, user, message: error.message }),
                ),
              ),
            );
          }).pipe(Effect.withSpan("PersonLayoutPlatform.setSshUser")),
        // Filled in by `ready()` on the handle the create made; asked of Core otherwise (a handle
        // from `get()`). Unreadable is unknown, which is not a yes.
        workspaceProcessUser: (workspace) =>
          workspace.launch?.processUser !== undefined
            ? Effect.succeed(workspace.launch.processUser)
            : call(() => workspace.processUser()).pipe(
                Effect.orElseSucceed((): WorkspaceProcessUserCapability => "unknown"),
              ),
        // Core 0.39.0-next.703 (sealant#334, sealantd 0.20.0-next.152): `workspace.dotfiles.apply`.
        dotfilesUser: true,
        // Core 0.39.0-next.696 (sealant#333): the map rides the capture source, and Core passes
        // it to sealantd as `SEALANT_CAPTURE_OWNER_MAP` at boot.
        withOwnerMap: (options, map) =>
          options.source?.kind === "capture"
            ? { ...options, source: { ...options.source, ownerMap: map } }
            : options,
        imageReport,
        postCredentials: Effect.fn("PersonLayoutPlatform.postCredentials")(
          function* (workspace, input) {
            const onBehalfOf = yield* clients.sealantUserId(input.onBehalfOf);
            const written = yield* boundedCall("write", input.home, () =>
              workspace.credentials.put({
                home: input.home,
                onBehalfOf,
                ...(input.owner === undefined
                  ? {}
                  : { uid: input.owner.uid, gid: input.owner.gid }),
                ...input.logins,
                ...(input.partial === true ? { partial: true } : {}),
              }),
            );
            return { skipped: written.skipped };
          },
        ),
        deleteCredentials: Effect.fn("PersonLayoutPlatform.deleteCredentials")(
          function* (workspace, input) {
            yield* boundedCall("release", input.home, () =>
              workspace.credentials.release(input.home),
            );
          },
        ),
        loginOf: (accountId, provider) =>
          clients
            .connectedAccounts(accountId)
            .list()
            .pipe(
              Effect.map((accounts) => {
                const account = accounts.find(
                  (candidate) =>
                    candidate.provider === provider &&
                    candidate.name === "default" &&
                    candidate.status !== "archived",
                );
                if (account === undefined) return "missing" as const;
                return account.status === "active" ? ("active" as const) : ("invalid" as const);
              }),
              Effect.orElseSucceed(() => "unknown" as const),
            ),
        sealantUserOf: (accountId) => clients.sealantUserId(accountId),
        listCredentials: Effect.fn("PersonLayoutPlatform.listCredentials")(function* (workspace) {
          const homes = yield* call(() => workspace.credentials.list());
          return homes.map(heldHomeOf);
        }),
        // One pass-through: the archives as Mend resolved them (a repository Mend cloned with
        // the person's own git access, then their synced snapshot), applied as their user.
        applyDotfiles: Effect.fn("PersonLayoutPlatform.applyDotfiles")(
          function* (workspace, input) {
            const onBehalfOf = yield* clients.sealantUserId(input.onBehalfOf);
            const applied = yield* call(() =>
              workspace.dotfiles.apply({
                onBehalfOf,
                user: input.user.name,
                home: input.home,
                archives: input.archives.map((archive) => ({
                  data: archive.data,
                  manager: archive.manager,
                  bootstrap: archive.bootstrap,
                })),
              }),
            );
            const bootstrap = applied.bootstrap;
            if (bootstrap === null) return { bootstrap: null };
            // One wait, however many callers ask how it ended (the start, then the session line).
            let waited: Promise<{ readonly exitCode: number }> | undefined;
            return {
              bootstrap: {
                ended: call(() => (waited ??= bootstrap.wait())).pipe(
                  Effect.map((done) => ({ exitCode: done.exitCode })),
                ),
              },
            };
          },
        ),
      };
    }),
  );
