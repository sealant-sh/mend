import { createHash, randomBytes } from "node:crypto";
import { posix } from "node:path";

import type { AuthSessionId } from "@mend/t3-contracts";
import {
  Cause,
  Clock,
  Context,
  Effect,
  Layer,
  Option,
  Redacted,
  Schema,
  type Scope,
  Stream,
} from "effect";
import {
  HttpMiddleware,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  Mime,
} from "effect/http";

import { GatewayAuth } from "./auth.ts";
import { Projections } from "./hub.ts";
import { MEND_IMAGE_MAX_BYTES } from "./images.ts";
import { MendClient, type MendRawFile } from "./mend-client.ts";
import { GatewayState } from "./state.ts";

export const ASSET_ROUTE_PREFIX = "/api/assets";
export const ASSET_URL_TTL_MS = 60 * 60_000;

export class AssetUnavailable extends Schema.TaggedError<AssetUnavailable>()(
  "AssetUnavailable",
  {},
) {}

export type AssetSubject =
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
    };

interface IssuedAsset {
  readonly relativeUrl: string;
  readonly expiresAt: number;
  readonly fileRevision?: string;
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
    readonly open: (input: {
      readonly target: Redacted.Redacted<string>;
      readonly method: "GET" | "HEAD";
      readonly range: string | undefined;
      readonly ifRange: string | undefined;
    }) => Effect.Effect<OpenedAsset, AssetUnavailable, Scope.Scope>;
  }
>()("@mend/t3-gateway/AssetUrls") {}

const policy = {
  grants: 4096,
  grantsPerDevice: 256,
  metadataBytes: 8 * 1024 * 1024,
  mints: 8,
  mintsPerDevice: 2,
  reads: 32,
  readsPerDevice: 8,
  imageReads: 2,
  imageBytes: 2 * MEND_IMAGE_MAX_BYTES,
};
const cacheControl = "private, no-store";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const validPath = (value: string) =>
  Buffer.byteLength(value) <= 4096 &&
  !value.includes("\\") &&
  !value.includes("\0") &&
  value.split("/").every((s) => s !== "" && s !== "." && s !== ".." && s !== ".git");
const withinDirectory = (name: string, directory: string) =>
  directory === "" || name.startsWith(`${directory}/`);

// t3code v0.1.2: shared/filePreview.ts, shared/video.ts and server/assets/AssetAccess.ts.
const images = new Set([".avif", ".gif", ".ico", ".jpeg", ".jpg", ".png", ".svg", ".webp"]);
const documents = new Set([".htm", ".html", ".pdf"]);
const dependencies = new Set([".css", ".js", ".mjs", ".otf", ".ttf", ".woff", ".woff2"]);
const media: Readonly<Record<string, string>> = {
  ".avi": "video/x-msvideo",
  ".m4v": "video/mp4",
  ".mp4": "video/mp4",
  ".mkv": "video/x-matroska",
  ".mov": "video/quicktime",
  ".ogv": "video/ogg",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".flac": "audio/flac",
  ".aac": "audio/aac",
  ".m4a": "audio/mp4",
  ".aiff": "audio/aiff",
};
const classify = (name: string, preview: "workspace" | "media", child: boolean) => {
  const extension = posix.extname(name).toLowerCase();
  if (!validPath(name) || (child && name.split("/").some((s) => s.startsWith(".")))) return null;
  const mediaType = preview === "media" && !child ? media[extension] : undefined;
  if (
    !images.has(extension) &&
    !documents.has(extension) &&
    !(child && dependencies.has(extension)) &&
    mediaType === undefined
  )
    return null;
  const contentType =
    extension === ".html" || extension === ".htm"
      ? "text/html; charset=utf-8"
      : extension === ".pdf"
        ? "application/pdf"
        : (mediaType ??
          (preview === "media" && extension === ".ico"
            ? "image/x-icon"
            : Option.getOrElse(Mime.getType(name), () => "application/octet-stream")));
  const csp =
    extension === ".svg"
      ? "default-src 'none'; style-src 'unsafe-inline'; sandbox"
      : extension === ".html" || extension === ".htm"
        ? "sandbox allow-scripts allow-forms allow-popups allow-downloads"
        : null;
  return { contentType, csp, ranges: mediaType !== undefined, directory: documents.has(extension) };
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
  | { readonly kind: "image"; readonly imageId: string; readonly suffix: Redacted.Redacted<string> }
  | {
      readonly kind: "file";
      readonly worktreeId: string;
      readonly path: Redacted.Redacted<string>;
      readonly directory: Redacted.Redacted<string>;
      readonly suffix: Redacted.Redacted<string>;
      readonly preview: "workspace" | "media";
      readonly extent: "exact" | "directory";
      readonly revision: string | null;
    };
interface Grant {
  readonly sessionId: AuthSessionId;
  readonly userId: string;
  readonly deviceId: string;
  readonly expiresAt: number;
  readonly source: Source;
  readonly cost: number;
}

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
    let metadataBytes = 0;
    const activeMints = new Map<string, number>();
    const activeReads = new Map<string, number>();
    let mints = 0;
    let reads = 0;
    let imageReads = 0;
    let imageBytes = 0;
    const sweep = (now: number) => {
      for (const [key, grant] of grants) {
        if (grant.expiresAt > now) continue;
        grants.delete(key);
        metadataBytes -= grant.cost;
        const remaining = (counts.get(grant.deviceId) ?? 1) - 1;
        if (remaining === 0) counts.delete(grant.deviceId);
        else counts.set(grant.deviceId, remaining);
      }
    };
    const reserve = (device: string, mint: boolean, image: boolean) =>
      Effect.acquireRelease(
        Effect.suspend(() => {
          const map = mint ? activeMints : activeReads;
          const count = map.get(device) ?? 0;
          if (
            (mint
              ? mints >= policy.mints || count >= policy.mintsPerDevice
              : reads >= policy.reads || count >= policy.readsPerDevice) ||
            (image &&
              (imageReads >= policy.imageReads ||
                imageBytes + MEND_IMAGE_MAX_BYTES > policy.imageBytes))
          )
            return Effect.fail(new AssetUnavailable({}));
          map.set(device, count + 1);
          if (mint) mints++;
          else reads++;
          if (image) {
            imageReads++;
            imageBytes += MEND_IMAGE_MAX_BYTES;
          }
          return Effect.void;
        }),
        () =>
          Effect.sync(() => {
            const map = mint ? activeMints : activeReads;
            const count = (map.get(device) ?? 1) - 1;
            if (count === 0) map.delete(device);
            else map.set(device, count);
            if (mint) mints--;
            else reads--;
            if (image) {
              imageReads--;
              imageBytes -= MEND_IMAGE_MAX_BYTES;
            }
          }),
      );
    const opened = (
      session: import("./state.ts").BearerSession,
      worktreeId: string,
      input: Parameters<MendClient["Service"]["openRawFile"]>[2],
    ) =>
      mend.openRawFile(Redacted.make(session.deviceToken), worktreeId, input).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            if (error.status === 401)
              yield* projections.refuseDevice(session.mendUser.id, session.deviceToken);
            return yield* new AssetUnavailable({});
          }),
        ),
      );
    return {
      issue: (sessionId, subject) =>
        Effect.scoped(
          Effect.gen(function* () {
            const bearer = yield* auth
              .authenticateSession(sessionId)
              .pipe(Effect.mapError(() => new AssetUnavailable({})));
            const session = bearer.session;
            yield* reserve(session.mendDeviceId, true, false);
            yield* auth.confirmDevice(bearer).pipe(Effect.mapError(() => new AssetUnavailable({})));
            const now = yield* Clock.currentTimeMillis;
            sweep(now);
            if (
              grants.size >= policy.grants ||
              (counts.get(session.mendDeviceId) ?? 0) >= policy.grantsPerDevice
            )
              return yield* new AssetUnavailable({});
            let source: Source;
            if (subject.kind === "image") {
              const name = Redacted.value(subject.fileName);
              if (!validPath(name) || name.includes("/")) return yield* new AssetUnavailable({});
              source = { kind: "image", imageId: subject.imageId, suffix: subject.fileName };
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
              const type = classify(name, subject.preview, false);
              if (type === null) return yield* new AssetUnavailable({});
              const directory = posix.dirname(name);
              source = {
                kind: "file",
                worktreeId: subject.worktreeId,
                path: file.canonicalPath,
                directory: Redacted.make(directory === "." ? "" : directory),
                suffix: Redacted.make(posix.basename(name)),
                preview: subject.preview,
                extent: type.directory ? "directory" : "exact",
                revision: type.ranges ? file.revision : null,
              };
            }
            const suffix = Redacted.value(source.suffix);
            const cost =
              Buffer.byteLength(
                JSON.stringify({
                  sessionId,
                  deviceId: session.mendDeviceId,
                  userId: session.mendUser.id,
                  source:
                    source.kind === "image"
                      ? { imageId: source.imageId, suffix }
                      : {
                          ...source,
                          suffix,
                          path: Redacted.value(source.path),
                          directory: Redacted.value(source.directory),
                        },
                }),
              ) + 128;
            // Other mints may have published while this one waited for descriptor metadata.
            if (
              grants.size >= policy.grants ||
              (counts.get(session.mendDeviceId) ?? 0) >= policy.grantsPerDevice ||
              metadataBytes + cost > policy.metadataBytes
            )
              return yield* new AssetUnavailable({});
            const token = `ast_${randomBytes(32).toString("base64url")}`;
            const expiresAt = Math.min(now + ASSET_URL_TTL_MS, session.expiresAt);
            grants.set(digest(token), {
              sessionId,
              userId: session.mendUser.id,
              deviceId: session.mendDeviceId,
              expiresAt,
              source,
              cost,
            });
            counts.set(session.mendDeviceId, (counts.get(session.mendDeviceId) ?? 0) + 1);
            metadataBytes += cost;
            return {
              relativeUrl: `${ASSET_ROUTE_PREFIX}/${token}/${encodeURIComponent(suffix)}`,
              expiresAt,
              ...(source.kind === "file" && source.revision !== null
                ? { fileRevision: source.revision }
                : {}),
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
          if (
            (source.kind === "image" || source.extent === "exact") &&
            suffix !== Redacted.value(source.suffix)
          )
            return yield* new AssetUnavailable({});
          yield* reserve(grant.deviceId, false, source.kind === "image");
          const bearer = yield* auth
            .authenticateSession(grant.sessionId)
            .pipe(Effect.mapError(() => new AssetUnavailable({})));
          const session = bearer.session;
          if (session.mendDeviceId !== grant.deviceId || session.mendUser.id !== grant.userId)
            return yield* new AssetUnavailable({});
          yield* auth.confirmDevice(bearer).pipe(Effect.mapError(() => new AssetUnavailable({})));
          if (source.kind === "image") {
            const kept = yield* state
              .imageBytes(grant.userId, source.imageId)
              .pipe(Effect.mapError(() => new AssetUnavailable({})));
            if (kept === null || kept.bytes.byteLength > MEND_IMAGE_MAX_BYTES)
              return yield* new AssetUnavailable({});
            return {
              status: 200,
              headers: {
                ...headersFor(kept.image.mimeType, null),
                "content-length": String(kept.bytes.length),
              },
              body: input.method === "HEAD" ? Stream.empty : Stream.make(kept.bytes),
            };
          }
          if (!session.scopes.includes("filesystem:read")) return yield* new AssetUnavailable({});
          const directory = Redacted.value(source.directory);
          const child = source.extent === "directory";
          const name = child
            ? directory === ""
              ? suffix
              : `${directory}/${suffix}`
            : Redacted.value(source.path);
          const type = classify(name, source.preview, child);
          if (type === null) return yield* new AssetUnavailable({});
          const file: MendRawFile = yield* opened(session, source.worktreeId, {
            path: Redacted.make(name),
            within: source.directory,
            method: input.method,
            range:
              type.ranges && input.method === "GET" && input.ifRange === undefined
                ? input.range
                : undefined,
          });
          const canonical = Redacted.value(file.canonicalPath);
          if (
            !withinDirectory(canonical, directory) ||
            (!child && canonical !== name) ||
            (source.revision !== null && source.revision !== file.revision)
          )
            return yield* new AssetUnavailable({});
          const actual = classify(canonical, source.preview, child);
          if (
            actual === null ||
            actual.ranges !== type.ranges ||
            (!type.ranges && file.status !== 200)
          )
            return yield* new AssetUnavailable({});
          const headers = headersFor(actual.contentType, actual.csp);
          headers["content-length"] = String(file.length);
          if (actual.ranges) headers["accept-ranges"] = "bytes";
          if (file.contentRange !== undefined) headers["content-range"] = file.contentRange;
          return {
            status: file.status,
            headers,
            body:
              input.method === "HEAD" || file.status === 416
                ? Stream.empty
                : file.body.pipe(Stream.mapError(() => new AssetUnavailable({}))),
          };
        }),
    };
  }),
);

const notFound = () =>
  HttpServerResponse.text("Not Found", { status: 404, headers: { "cache-control": cacheControl } });

/** Asset failures before headers are indistinguishable; stream errors propagate to the server. */
export const AssetRouteLive: Layer.Layer<never, never, HttpRouter.HttpRouter | AssetUrls> =
  Layer.unwrap(
    Effect.gen(function* () {
      const urls = yield* AssetUrls;
      const handler = HttpMiddleware.withLoggerDisabled(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const asset = yield* urls.open({
            target: Redacted.make(request.url),
            method: request.method === "HEAD" ? "HEAD" : "GET",
            range: request.headers.range,
            ifRange: request.headers["if-range"],
          });
          return request.method === "HEAD" || asset.status === 416
            ? HttpServerResponse.empty({ status: asset.status, headers: asset.headers })
            : HttpServerResponse.stream(asset.body, {
                status: asset.status,
                headers: asset.headers,
              });
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.succeed(notFound()),
          ),
        ),
      );
      return Layer.merge(
        HttpRouter.middleware(
          (effect) =>
            Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
              isAssetRequest(request) ? HttpMiddleware.withLoggerDisabled(effect) : effect,
            ),
          { global: true },
        ),
        HttpRouter.add("GET", `${ASSET_ROUTE_PREFIX}/*`, handler),
      );
    }),
  );

/** Match before URL parsing, including malformed targets and preflight requests. */
export const isAssetRequest = (request: HttpServerRequest.HttpServerRequest): boolean =>
  request.url.startsWith(`${ASSET_ROUTE_PREFIX}/`);
export const AssetTracingDisabledLive: Layer.Layer<never> = Layer.succeed(
  HttpMiddleware.TracerDisabledWhen,
)(isAssetRequest);
