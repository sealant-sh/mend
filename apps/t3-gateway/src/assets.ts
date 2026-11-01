import { createHash, randomBytes } from "node:crypto";
import { IncomingMessage } from "node:http";
import { posix } from "node:path";

import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import type { ProofArtifactId } from "@mend/domain";
import { PAGE_FRAME_TTL_MS } from "@mend/domain/workbench";
import type { AuthSessionId } from "@mend/t3-contracts";
import {
  Cause,
  Clock,
  Context,
  Duration,
  Effect,
  Layer,
  Redacted,
  Schema,
  type Scope,
  Stream,
} from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { type AdmissionLimits, makeAdmission } from "./admission.ts";
import { GatewayAuth } from "./auth.ts";
import { gateDeviceCalls } from "./device-gate.ts";
import { Projections } from "./hub.ts";
import { MEND_IMAGE_MAX_BYTES } from "./images.ts";
import { MendClient, type MendRawFile, type MendRawFileRequest } from "./mend-client.ts";
import { parseProofMediaPath, PROOF_MEDIA_PATH_PREFIX } from "./proof-media.ts";
import { type BearerSession, GatewayState } from "./state.ts";

export const ASSET_ROUTE_PREFIX = "/api/assets";
export const ASSET_URL_TTL_MS = 60 * 60_000;
/**
 * The life a page URL has when a mint returns it: t3code v0.1.2 mints once per frame mount and
 * discards a URL with 5 minutes or less left (HtmlRenderFrame.tsx).
 */
export const PAGE_URL_MIN_LIFE_MS = 15 * 60_000;
const PAGE_FILE_NAME = "page.html";

export class AssetUnavailable extends Schema.TaggedError<AssetUnavailable>()(
  "AssetUnavailable",
  {},
) {}

type ProofAsset = {
  readonly kind: "proof";
  readonly artifactId: ProofArtifactId;
  readonly fileName: string;
};

export type AssetSubject =
  | ProofAsset
  | { readonly kind: "page"; readonly pageId: string }
  | {
      readonly kind: "file";
      readonly worktreeId: string;
      readonly path: Redacted.Redacted<string>;
      readonly preview: "workspace" | "media";
    }
  | {
      readonly kind: "image";
      readonly imageId: string;
      readonly fileName: Redacted.Redacted<string>;
      /** Its size as kept, which a read holds of the image budget while it is sent. */
      readonly sizeBytes: number;
    };

interface IssuedAsset {
  readonly relativeUrl: string;
  readonly expiresAt: number;
  readonly fileRevision?: string;
}
interface AssetRequest {
  readonly target: Redacted.Redacted<string>;
  readonly method: "GET" | "HEAD";
  readonly range: string | undefined;
  readonly ifRange: string | undefined;
}
interface OpenedAsset {
  readonly status: 200 | 206 | 416;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Stream.Stream<Uint8Array, AssetUnavailable>;
}

/** The sole owner of asset grants, including message images. */
export class AssetUrls extends Context.Service<
  AssetUrls,
  {
    readonly issue: (
      sessionId: AuthSessionId,
      subject: AssetSubject,
    ) => Effect.Effect<IssuedAsset, AssetUnavailable>;
    readonly open: (
      input: AssetRequest,
    ) => Effect.Effect<OpenedAsset, AssetUnavailable, Scope.Scope>;
  }
>()("@mend/t3-gateway/AssetUrls") {}

export interface AssetLimits {
  readonly mints: AdmissionLimits;
  readonly reads: AdmissionLimits;
  /** Bytes of chat images held in memory at once while they are sent. */
  readonly imageBytes: number;
  /** How long a mint or a read waits for room before it is refused. */
  readonly wait: Duration.Duration;
  /** How long a body waits for its reader to take the next chunk before the socket is reset. */
  readonly stall: Duration.Duration;
  readonly grants: number;
  readonly grantsPerDevice: number;
  /** URLs kept for one device's one file or image; a newer mint retires the oldest past it. */
  readonly grantsPerSubject: number;
  readonly metadataBytes: number;
}

/**
 * Sized from how t3code v0.1.2 asks (client-runtime state/assets.ts): one createUrl per visible
 * image or preview, all at once and again every 30 minutes; a page of images loaded in parallel;
 * a video that stops reading when paused. Under the gateway's 256 MiB heap and 1,024 descriptors
 * (scripts/bundle-supervisor.mjs).
 */
export const DEFAULT_ASSET_LIMITS: AssetLimits = {
  // A thread can show ~100 images; they queue for 8 Mend round trips at a time per device.
  mints: { total: 32, perKey: 8, queue: 1024 },
  // A read holds the client's socket and one to Mend: 96 × 2 plus 384 waiting sockets.
  reads: { total: 96, perKey: 24, queue: 384 },
  // A quarter of the heap: eight images at the 8 MiB maximum, far more at a screenshot's size.
  imageBytes: 64 * 1024 * 1024,
  // A stalled reader frees its slot within `stall`, so a waiter outlasts one.
  wait: Duration.seconds(30),
  // Longer than a slow phone takes over one 64 KiB chunk; a paused video frees its slot.
  stall: Duration.seconds(30),
  // Re-mints retire their subject's oldest URL, so a device holds about three per file it showed
  // within the hour: a few hundred-image threads. A grant is a few hundred bytes.
  grants: 16_384,
  grantsPerDevice: 4096,
  // The current URL, the one it replaced while a view swaps over, and one more for a remount.
  grantsPerSubject: 3,
  metadataBytes: 16 * 1024 * 1024,
};

/** A reference so a test can shrink the limits. */
export const AssetLimits: Context.Reference<AssetLimits> = Context.Reference<AssetLimits>(
  "@mend/t3-gateway/AssetLimits",
  { defaultValue: () => DEFAULT_ASSET_LIMITS },
);
const cacheControl = "private, no-store";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const validPath = (value: string) =>
  Buffer.byteLength(value) <= 4096 &&
  !value.includes("\\") &&
  !value.includes("\0") &&
  value.split("/").every((s) => s !== "" && s !== "." && s !== ".." && s !== ".git");
const withinDirectory = (name: string, directory: string) =>
  directory === "" || name.startsWith(`${directory}/`);

const svgPolicy = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
// An opaque origin: the page's scripts run, the gateway's storage and credentials stay out of reach.
const htmlPolicy = "sandbox allow-scripts allow-forms allow-popups allow-downloads";
type Family = "image" | "video" | "audio" | "document" | "dependency";
/**
 * How t3code v0.1.2 serves each previewable extension (shared/filePreview.ts, shared/video.ts,
 * server/http.ts assetResponseHeaders, server/assets/AssetAccess.ts). A pin update checks it.
 */
const served: ReadonlyMap<
  string,
  { readonly family: Family; readonly contentType: string; readonly csp: string | null }
> = new Map(
  (
    [
      [".avif", "image", "image/avif"],
      [".gif", "image", "image/gif"],
      [".ico", "image", "image/x-icon"],
      [".jpeg", "image", "image/jpeg"],
      [".jpg", "image", "image/jpeg"],
      [".png", "image", "image/png"],
      [".svg", "image", "image/svg+xml", svgPolicy],
      [".webp", "image", "image/webp"],
      [".avi", "video", "video/x-msvideo"],
      [".m4v", "video", "video/mp4"],
      [".mkv", "video", "video/x-matroska"],
      [".mov", "video", "video/quicktime"],
      [".mp4", "video", "video/mp4"],
      [".ogv", "video", "video/ogg"],
      [".webm", "video", "video/webm"],
      [".mp3", "audio", "audio/mpeg"],
      [".wav", "audio", "audio/wav"],
      [".ogg", "audio", "audio/ogg"],
      [".oga", "audio", "audio/ogg"],
      [".flac", "audio", "audio/flac"],
      [".aac", "audio", "audio/aac"],
      [".m4a", "audio", "audio/mp4"],
      [".opus", "audio", "audio/ogg"],
      [".aiff", "audio", "audio/aiff"],
      [".pdf", "document", "application/pdf"],
      [".htm", "document", "text/html; charset=utf-8", htmlPolicy],
      [".html", "document", "text/html; charset=utf-8", htmlPolicy],
      [".css", "dependency", "text/css"],
      [".js", "dependency", "text/javascript"],
      [".mjs", "dependency", "text/javascript"],
      [".otf", "dependency", "font/otf"],
      [".ttf", "dependency", "font/ttf"],
      [".woff", "dependency", "font/woff"],
      [".woff2", "dependency", "font/woff2"],
    ] satisfies ReadonlyArray<readonly [string, Family, string, string?]>
  ).map(([extension, family, contentType, csp]) => [
    extension,
    { family, contentType, csp: csp ?? null },
  ]),
);
const typeOf = (name: string) =>
  validPath(name) ? (served.get(posix.extname(name).toLowerCase()) ?? null) : null;
const ranged = (family: Family) => family === "video" || family === "audio";
/** What a grant itself may name: no bare dependency, and audio or video only from a media-file. */
const grantable = (name: string, preview: "workspace" | "media") => {
  const type = typeOf(name);
  return type === null ||
    type.family === "dependency" ||
    (ranged(type.family) && preview !== "media")
    ? null
    : type;
};
/**
 * What a document's directory serves below it, as t3code's rule has it: no dot-segment under the
 * granted directory (the directory itself may sit in one), and no audio or video.
 */
const dependency = (suffix: string) => {
  const type = typeOf(suffix);
  return type === null || ranged(type.family) || suffix.split("/").some((s) => s.startsWith("."))
    ? null
    : type;
};
const headersFor = (contentType: string, csp: string | null): Record<string, string> => ({
  "content-type": contentType,
  "cache-control": cacheControl,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-disposition": "inline",
  ...(csp === null ? {} : { "content-security-policy": csp }),
});

type Source =
  | ProofAsset
  | { readonly kind: "page"; readonly pageId: string }
  | {
      readonly kind: "image";
      readonly imageId: string;
      readonly name: Redacted.Redacted<string>;
      readonly sizeBytes: number;
    }
  | {
      readonly kind: "file";
      readonly worktreeId: string;
      readonly captureId: string | null;
      /** The canonical worktree-relative path the grant was minted for. */
      readonly path: Redacted.Redacted<string>;
      readonly preview: "workspace" | "media";
      readonly extent:
        | {
            readonly kind: "exact";
            /** A media-file grant follows its file's device and inode, as t3code's does. */
            readonly identity: string | null;
          }
        /** A workspace document, with what its directory holds beside and below it. */
        | { readonly kind: "directory"; readonly directory: string };
    };
interface Grant {
  readonly sessionId: AuthSessionId;
  readonly userId: string;
  readonly deviceId: string;
  readonly expiresAt: number;
  readonly source: Source;
  /** The device's session and the file or image it names, which re-mints share. */
  readonly subject: string;
  readonly url: string | null;
  readonly cost: number;
}

interface Terms {
  readonly suffix: string;
  readonly keyParts: ReadonlyArray<string>;
  readonly ttlMs: number;
  readonly reuseMinLifeMs: number | null;
}

const termsOf = (source: Source): Terms => {
  switch (source.kind) {
    case "proof":
      return {
        suffix: source.fileName,
        keyParts: ["proof", source.artifactId, source.fileName],
        ttlMs: ASSET_URL_TTL_MS,
        reuseMinLifeMs: null,
      };
    case "page":
      return {
        suffix: PAGE_FILE_NAME,
        keyParts: ["page", source.pageId],
        ttlMs: PAGE_FRAME_TTL_MS,
        reuseMinLifeMs: PAGE_URL_MIN_LIFE_MS,
      };
    case "image":
      return {
        suffix: posix.basename(Redacted.value(source.name)),
        keyParts: ["image", source.imageId, Redacted.value(source.name)],
        ttlMs: ASSET_URL_TTL_MS,
        reuseMinLifeMs: null,
      };
    case "file":
      return {
        suffix: posix.basename(Redacted.value(source.path)),
        keyParts: ["file", source.worktreeId, source.preview, Redacted.value(source.path)],
        ttlMs: ASSET_URL_TTL_MS,
        reuseMinLifeMs: null,
      };
  }
};

export const AssetUrlsLive: Layer.Layer<
  AssetUrls,
  never,
  GatewayAuth | GatewayState | MendClient | Projections
> = Layer.effect(
  AssetUrls,
  Effect.gen(function* () {
    const auth = yield* GatewayAuth;
    const state = yield* GatewayState;
    const mend = yield* MendClient;
    const projections = yield* Projections;
    const grants = new Map<string, Grant>();
    const counts = new Map<string, number>();
    /** Each subject's grants by digest, oldest first. */
    const subjects = new Map<string, Array<string>>();
    let metadataBytes = 0;
    const limits = yield* AssetLimits;
    const mints = makeAdmission(limits.mints, limits.wait);
    const reads = makeAdmission(limits.reads, limits.wait);
    const imageBytes = makeAdmission(
      { total: limits.imageBytes, perKey: Number.POSITIVE_INFINITY, queue: limits.reads.queue },
      limits.wait,
    );
    const drop = (key: string) => {
      const grant = grants.get(key);
      if (grant === undefined) return;
      grants.delete(key);
      metadataBytes -= grant.cost;
      const remaining = (counts.get(grant.deviceId) ?? 1) - 1;
      if (remaining === 0) counts.delete(grant.deviceId);
      else counts.set(grant.deviceId, remaining);
      const siblings = (subjects.get(grant.subject) ?? []).filter((sibling) => sibling !== key);
      if (siblings.length === 0) subjects.delete(grant.subject);
      else subjects.set(grant.subject, siblings);
    };
    const sweep = (now: number) => {
      for (const [key, grant] of grants) if (grant.expiresAt <= now) drop(key);
    };
    const gated = (session: BearerSession) =>
      gateDeviceCalls(mend, (token) => projections.refuseDevice(session.mendUser.id, token));
    const opened = (session: BearerSession, worktreeId: string, input: MendRawFileRequest) =>
      gated(session)
        .openRawFile(Redacted.make(session.deviceToken), worktreeId, input)
        .pipe(Effect.mapError(() => new AssetUnavailable({})));

    const openPage = (
      session: BearerSession,
      source: Extract<Source, { kind: "page" }>,
      method: "GET" | "HEAD",
    ): Effect.Effect<OpenedAsset, AssetUnavailable, Scope.Scope> =>
      Effect.gen(function* () {
        if (!session.scopes.includes("orchestration:read")) return yield* new AssetUnavailable({});
        const body = yield* gated(session)
          .openPage(Redacted.make(session.deviceToken), source.pageId)
          .pipe(Effect.mapError(() => new AssetUnavailable({})));
        return {
          status: 200,
          // t3code's phone loads this as a top-level document, without an iframe sandbox.
          headers: headersFor("text/html; charset=utf-8", "sandbox allow-scripts allow-forms"),
          body:
            method === "HEAD"
              ? Stream.empty
              : body.pipe(Stream.mapError(() => new AssetUnavailable({}))),
        };
      });

    const openImage = (
      grant: Grant,
      source: Extract<Source, { kind: "image" }>,
      method: "GET" | "HEAD",
    ): Effect.Effect<OpenedAsset, AssetUnavailable> =>
      Effect.gen(function* () {
        const kept = yield* state
          .imageBytes(grant.userId, source.imageId)
          .pipe(Effect.mapError(() => new AssetUnavailable({})));
        if (kept === null || kept.bytes.byteLength > source.sizeBytes)
          return yield* new AssetUnavailable({});
        return {
          status: 200,
          headers: {
            ...headersFor(kept.image.mimeType, null),
            "content-length": String(kept.bytes.length),
          },
          body: method === "HEAD" ? Stream.empty : chunked(kept.bytes),
        };
      });

    const openFile = (
      session: BearerSession,
      source: Extract<Source, { kind: "file" }>,
      suffix: string,
      input: AssetRequest,
    ): Effect.Effect<OpenedAsset, AssetUnavailable, Scope.Scope> =>
      Effect.gen(function* () {
        if (!session.scopes.includes("filesystem:read")) return yield* new AssetUnavailable({});
        const extent = source.extent;
        const granted = Redacted.value(source.path);
        const directory = extent.kind === "directory" ? extent.directory : "";
        const name =
          extent.kind === "exact" ? granted : directory === "" ? suffix : `${directory}/${suffix}`;
        const requested =
          extent.kind === "exact" ? grantable(name, source.preview) : dependency(suffix);
        if (requested === null) return yield* new AssetUnavailable({});
        const ranges = ranged(requested.family);
        const file: MendRawFile = yield* opened(session, source.worktreeId, {
          path: Redacted.make(name),
          within: Redacted.make(directory),
          captureId: source.captureId,
          method: input.method,
          range:
            ranges && input.method === "GET" && input.ifRange === undefined
              ? input.range
              : undefined,
        });
        const canonical = Redacted.value(file.canonicalPath);
        const type =
          extent.kind === "exact"
            ? canonical === granted &&
              (extent.identity === null || extent.identity === file.identity)
              ? requested
              : null
            : withinDirectory(canonical, directory)
              ? dependency(directory === "" ? canonical : canonical.slice(directory.length + 1))
              : null;
        if (type === null || (!ranges && file.status !== 200))
          return yield* new AssetUnavailable({});
        const headers = headersFor(type.contentType, type.csp);
        headers["content-length"] = String(file.length);
        if (ranges) headers["accept-ranges"] = "bytes";
        if (file.contentRange !== undefined) headers["content-range"] = file.contentRange;
        return {
          status: file.status,
          headers,
          body:
            input.method === "HEAD" || file.status === 416
              ? Stream.empty
              : file.body.pipe(Stream.mapError(() => new AssetUnavailable({}))),
        };
      });

    const openProof = (
      session: BearerSession,
      source: ProofAsset,
      input: Pick<AssetRequest, "method" | "range" | "ifRange">,
    ): Effect.Effect<OpenedAsset, AssetUnavailable, Scope.Scope> =>
      Effect.gen(function* () {
        if (!session.scopes.includes("orchestration:read")) return yield* new AssetUnavailable({});
        const type = typeOf(source.fileName);
        if (type === null || (type.family !== "image" && type.family !== "video"))
          return yield* new AssetUnavailable({});
        const ranges = ranged(type.family);
        const media = yield* gated(session)
          .openProofMedia(Redacted.make(session.deviceToken), source.artifactId, {
            method: input.method,
            range:
              ranges && input.method === "GET" && input.ifRange === undefined
                ? input.range
                : undefined,
          })
          .pipe(Effect.mapError(() => new AssetUnavailable({})));
        if (media.mimeType !== type.contentType || (!ranges && media.status !== 200))
          return yield* new AssetUnavailable({});
        const headers = headersFor(type.contentType, type.csp);
        headers["content-length"] = String(media.length);
        if (ranges) headers["accept-ranges"] = "bytes";
        if (media.contentRange !== undefined) headers["content-range"] = media.contentRange;
        return {
          status: media.status,
          headers,
          body:
            input.method === "HEAD" || media.status === 416
              ? Stream.empty
              : media.body.pipe(Stream.mapError(() => new AssetUnavailable({}))),
        };
      });

    return {
      issue: (sessionId, subject) =>
        Effect.scoped(
          Effect.gen(function* () {
            const bearer = yield* auth
              .authenticateSession(sessionId)
              .pipe(Effect.mapError(() => new AssetUnavailable({})));
            const session = bearer.session;
            if (!(yield* mints(session.mendDeviceId))) return yield* new AssetUnavailable({});
            yield* auth.confirmDevice(bearer).pipe(Effect.mapError(() => new AssetUnavailable({})));
            let source: Source;
            let fileRevision: string | undefined;
            if (subject.kind === "proof") {
              const parsed = parseProofMediaPath(`${PROOF_MEDIA_PATH_PREFIX}/${subject.fileName}`);
              if (parsed.kind !== "proof" || parsed.artifactId !== subject.artifactId)
                return yield* new AssetUnavailable({});
              source = subject;
              yield* openProof(session, source, {
                method: "HEAD",
                range: undefined,
                ifRange: undefined,
              });
            } else if (subject.kind === "page") {
              if (!session.scopes.includes("orchestration:read"))
                return yield* new AssetUnavailable({});
              source = subject;
            } else if (subject.kind === "image") {
              const name = Redacted.value(subject.fileName);
              if (
                !validPath(name) ||
                name.includes("/") ||
                !Number.isSafeInteger(subject.sizeBytes) ||
                subject.sizeBytes < 0 ||
                subject.sizeBytes > MEND_IMAGE_MAX_BYTES
              )
                return yield* new AssetUnavailable({});
              source = {
                kind: "image",
                imageId: subject.imageId,
                name: subject.fileName,
                sizeBytes: subject.sizeBytes,
              };
            } else {
              if (
                !session.scopes.includes("filesystem:read") ||
                !validPath(Redacted.value(subject.path))
              )
                return yield* new AssetUnavailable({});
              const file = yield* opened(session, subject.worktreeId, {
                path: subject.path,
                within: Redacted.make(""),
                method: "HEAD",
              });
              if (file.status !== 200) return yield* new AssetUnavailable({});
              const name = Redacted.value(file.canonicalPath);
              const type = grantable(name, subject.preview);
              if (type === null) return yield* new AssetUnavailable({});
              const directory = posix.dirname(name);
              source = {
                kind: "file",
                worktreeId: subject.worktreeId,
                path: file.canonicalPath,
                captureId: file.captureId,
                preview: subject.preview,
                // As t3code: only a workspace document opens its directory; a media file is exact.
                extent:
                  type.family === "document" && subject.preview === "workspace"
                    ? { kind: "directory", directory: directory === "." ? "" : directory }
                    : {
                        kind: "exact",
                        identity: subject.preview === "media" ? file.identity : null,
                      },
              };
              if (subject.preview === "media") fileRevision = file.revision;
            }
            const { suffix, keyParts, ttlMs, reuseMinLifeMs } = termsOf(source);
            const now = yield* Clock.currentTimeMillis;
            if (reuseMinLifeMs !== null && session.expiresAt - now < reuseMinLifeMs)
              return yield* new AssetUnavailable({});
            if (source.kind === "page")
              yield* gated(session)
                .pageFrame(Redacted.make(session.deviceToken), source.pageId)
                .pipe(Effect.mapError(() => new AssetUnavailable({})));
            const subjectKey = [session.mendDeviceId, sessionId, ...keyParts].join("\0");
            sweep(now);
            const siblings = subjects.get(subjectKey) ?? [];
            if (reuseMinLifeMs !== null) {
              const kept = siblings
                .map((sibling) => grants.get(sibling))
                .findLast(
                  (grant) => grant !== undefined && grant.expiresAt - now >= reuseMinLifeMs,
                );
              if (kept !== undefined && kept.url !== null)
                return { relativeUrl: kept.url, expiresAt: kept.expiresAt };
            }
            const retired = siblings.length >= limits.grantsPerSubject ? siblings[0] : undefined;
            if (retired !== undefined && reuseMinLifeMs !== null)
              return yield* new AssetUnavailable({});
            const token = `ast_${randomBytes(32).toString("base64url")}`;
            const relativeUrl = `${ASSET_ROUTE_PREFIX}/${token}/${encodeURIComponent(suffix)}`;
            const url = reuseMinLifeMs === null ? null : relativeUrl;
            // The subject twice (its index and the grant's source), a kept URL, the digest and fields.
            const cost =
              2 * Buffer.byteLength(subjectKey) + (url === null ? 0 : Buffer.byteLength(url)) + 256;
            const freed = retired === undefined ? undefined : grants.get(retired);
            const room = freed === undefined ? 0 : 1;
            if (
              grants.size - room >= limits.grants ||
              (counts.get(session.mendDeviceId) ?? 0) - room >= limits.grantsPerDevice ||
              metadataBytes - (freed?.cost ?? 0) + cost > limits.metadataBytes
            )
              return yield* new AssetUnavailable({});
            if (retired !== undefined) drop(retired);
            const key = digest(token);
            const expiresAt = Math.min(now + ttlMs, session.expiresAt);
            grants.set(key, {
              sessionId,
              userId: session.mendUser.id,
              deviceId: session.mendDeviceId,
              expiresAt,
              source,
              subject: subjectKey,
              url,
              cost,
            });
            subjects.set(subjectKey, [...(subjects.get(subjectKey) ?? []), key]);
            counts.set(session.mendDeviceId, (counts.get(session.mendDeviceId) ?? 0) + 1);
            metadataBytes += cost;
            return {
              relativeUrl,
              expiresAt,
              ...(fileRevision === undefined ? {} : { fileRevision }),
            };
          }),
        ),
      open: (input) =>
        Effect.gen(function* () {
          const target = Redacted.value(input.target).split("?")[0] ?? "";
          if (!target.startsWith(`${ASSET_ROUTE_PREFIX}/`) || target.length > 16384)
            return yield* new AssetUnavailable({});
          const [token = "", ...encoded] = target.slice(ASSET_ROUTE_PREFIX.length + 1).split("/");
          if (!/^ast_[A-Za-z0-9_-]{43}$/.test(token)) return yield* new AssetUnavailable({});
          const grant = grants.get(digest(token));
          if (grant === undefined || grant.expiresAt <= (yield* Clock.currentTimeMillis))
            return yield* new AssetUnavailable({});
          const parts = yield* Effect.try({
            try: () => encoded.map((part) => decodeURIComponent(part)),
            catch: () => new AssetUnavailable({}),
          });
          if (parts.length === 0 || parts.some((part) => !validPath(part) || part.includes("/")))
            return yield* new AssetUnavailable({});
          const suffix = parts.join("/");
          const source = grant.source;
          const exact = source.kind !== "file" || source.extent.kind === "exact";
          if (exact && suffix !== termsOf(source).suffix) return yield* new AssetUnavailable({});
          if (
            !(yield* reads(grant.deviceId)) ||
            (source.kind === "image" && !(yield* imageBytes(grant.deviceId, source.sizeBytes)))
          )
            return yield* new AssetUnavailable({});
          const bearer = yield* auth
            .authenticateSession(grant.sessionId)
            .pipe(Effect.mapError(() => new AssetUnavailable({})));
          const session = bearer.session;
          if (session.mendDeviceId !== grant.deviceId || session.mendUser.id !== grant.userId)
            return yield* new AssetUnavailable({});
          yield* auth.confirmDevice(bearer).pipe(Effect.mapError(() => new AssetUnavailable({})));
          switch (source.kind) {
            case "proof":
              return yield* openProof(session, source, input);
            case "page":
              return yield* openPage(session, source, input.method);
            case "image":
              return yield* openImage(grant, source, input.method);
            case "file":
              return yield* openFile(session, source, suffix, input);
          }
        }),
    };
  }),
);

const CHUNK_BYTES = 64 * 1024;
/** In pieces, so a stalled reader shows as one that stopped taking chunks. */
const chunked = (bytes: Uint8Array) =>
  Stream.fromIterable(
    Array.from({ length: Math.ceil(bytes.byteLength / CHUNK_BYTES) }, (_, index) =>
      bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES),
    ),
  );

const notFound = () =>
  HttpServerResponse.text("Not Found", { status: 404, headers: { "cache-control": cacheControl } });

/** Asset failures before headers are indistinguishable; a failure after them resets the socket. */
export const AssetRouteLive: Layer.Layer<never, never, HttpRouter.HttpRouter | AssetUrls> =
  Layer.unwrap(
    Effect.gen(function* () {
      const urls = yield* AssetUrls;
      const stall = Duration.toMillis((yield* AssetLimits).stall);
      const handler = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const asset = yield* urls.open({
          target: Redacted.make(request.url),
          method: request.method === "HEAD" ? "HEAD" : "GET",
          range: request.headers.range,
          ifRange: request.headers["if-range"],
        });
        if (request.method === "HEAD" || asset.status === 416)
          return HttpServerResponse.empty({ status: asset.status, headers: asset.headers });
        // The one way to end a body whose headers went out: Node's adapter would end it short,
        // and a keep-alive client would wait for the rest.
        const reset = () => {
          if (request.source instanceof IncomingMessage)
            NodeHttpServerRequest.toServerResponse(request).destroy();
        };
        let taken = yield* Clock.currentTimeMillis;
        yield* Effect.forkScoped(
          Effect.gen(function* () {
            while ((yield* Clock.currentTimeMillis) - taken < stall) yield* Effect.sleep(stall / 4);
            reset();
          }),
        );
        return HttpServerResponse.stream(
          asset.body.pipe(
            Stream.tap(() =>
              Effect.map(Clock.currentTimeMillis, (now) => {
                taken = now;
              }),
            ),
            Stream.onError(() => Effect.sync(reset)),
          ),
          { status: asset.status, headers: asset.headers },
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.succeed(notFound()),
        ),
      );
      return HttpRouter.add("GET", `${ASSET_ROUTE_PREFIX}/*`, handler);
    }),
  );
