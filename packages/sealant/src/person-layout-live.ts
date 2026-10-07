/**
 * The person layout's platform surface (docs/adr/0016), passed through to Core's SDK (0.39): the
 * image's per-person capability before create (`workspaces.inspectImage`), processes as a user
 * (`withProcessUser`, in the client), and one person's logins per home of a running executor
 * (`workspace.credentials`). Mend names people by their Mend account; Core by their Sealant user,
 * which the identity mapping answers from Mend's own table.
 */
import type { WorkspaceImage } from "@mend/domain";
import type {
  CreateOptions,
  Harness,
  WorkspaceCredentialHome,
  WorkspaceImageInspection,
  WorkspaceImagePersonLayout,
} from "@sealant/sdk";
import { Clock, Duration, Effect, Layer } from "effect";

import { SealantClients, toPlatformError } from "./client.ts";
import { SealantPlatformError } from "./errors.ts";
import {
  type HeldHome,
  type ImageLayoutReport,
  LOGIN_PROVIDERS,
  type LoginProvider,
  PersonLayoutPlatform,
  UNKNOWN_IMAGE_REPORT,
  personLayoutUnsupported,
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

/** The image-shaping part of a create, as the engine's create asks for the same image. */
export const imageCreateOptionsOf = (image: WorkspaceImage, harness: Harness): CreateOptions => ({
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
        const key = `${input.ownerUserId}\u0000${yield* clients.imageKey(options)}`;
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

      return {
        processUser: true,
        // Core's SDK does not carry sealantd's `dotfiles.apply` yet (PLATFORM-FEEDBACK.md,
        // 2026-10-07). Once it does, this is `true` and `applyDotfiles` below passes through,
        // e.g. `call(() => workspace.dotfiles.apply({ user: input.user?.name ?? "root", ... }))`.
        dotfilesUser: false,
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
            yield* boundedCall("write", input.home, () =>
              workspace.credentials.put({
                home: input.home,
                onBehalfOf,
                ...(input.owner === undefined
                  ? {}
                  : { uid: input.owner.uid, gid: input.owner.gid }),
                ...input.logins,
              }),
            );
          },
        ),
        deleteCredentials: Effect.fn("PersonLayoutPlatform.deleteCredentials")(
          function* (workspace, input) {
            yield* boundedCall("release", input.home, () =>
              workspace.credentials.release(input.home),
            );
          },
        ),
        sealantUserOf: (accountId) => clients.sealantUserId(accountId),
        listCredentials: Effect.fn("PersonLayoutPlatform.listCredentials")(function* (workspace) {
          const homes = yield* call(() => workspace.credentials.list());
          return homes.map(heldHomeOf);
        }),
        // No SDK surface yet for sealantd's dotfiles verb (PLATFORM-FEEDBACK.md, 2026-10-07).
        applyDotfiles: () =>
          Effect.fail(
            personLayoutUnsupported(
              "apply dotfiles as a person",
              "sealantd Delivery 5, Core Delivery 8",
            ),
          ),
      };
    }),
  );
