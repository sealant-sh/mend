import { createHash, randomBytes } from "node:crypto";
import { IncomingMessage } from "node:http";

import * as NodeStream from "@effect/platform-node/NodeStream";
import {
  AuthOrchestrationOperateScope,
  type AttachmentCreateUploadUrlInput,
  type AttachmentCreateUploadUrlResult,
  type AuthSessionId,
} from "@mend/t3-contracts";
import { Clock, Context, Duration, Effect, Layer, Schema, Stream } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { makeAdmission } from "./admission.ts";
import { GatewayAuth } from "./auth.ts";
import { Projections } from "./hub.ts";
import { MEND_IMAGE_MAX_BYTES, newAttachmentId } from "./images.ts";

const UPLOAD_PREFIX = "/api/attachments/upload";
/** URLs are transient capabilities; a restart asks the client to mint another one. */
export const IMAGE_UPLOAD_URL_TTL_MS = 5 * 60_000;
const MAX_GRANTS = 1024;
const MAX_GRANTS_PER_PERSON = 128;
const digest = (token: string) => createHash("sha256").update(token).digest("hex");

export class ImageUploadRefused extends Schema.TaggedError<ImageUploadRefused>()(
  "ImageUploadRefused",
  { status: Schema.Number, message: Schema.String },
) {}

/** Owns bounded, single-use upload capabilities. Completed images belong to the person's hub. */
export class AttachmentUploads extends Context.Service<
  AttachmentUploads,
  {
    readonly issue: (
      sessionId: AuthSessionId,
      input: AttachmentCreateUploadUrlInput,
    ) => Effect.Effect<AttachmentCreateUploadUrlResult, ImageUploadRefused>;
    readonly receive: (
      token: string,
      contentType: string | undefined,
      body: Stream.Stream<Uint8Array, ImageUploadRefused>,
    ) => Effect.Effect<void, ImageUploadRefused>;
    readonly remove: (
      sessionId: AuthSessionId,
      attachmentId: string,
    ) => Effect.Effect<void, ImageUploadRefused>;
  }
>()("@mend/t3-gateway/AttachmentUploads") {}

type Grant = {
  readonly sessionId: AuthSessionId;
  readonly person: string;
  readonly attachmentId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly expiresAt: number;
  cancelled: boolean;
};

const refused = (status: number, message: string) => new ImageUploadRefused({ status, message });

const make: Effect.Effect<AttachmentUploads["Service"], never, GatewayAuth | Projections> =
  Effect.gen(function* () {
    const auth = yield* GatewayAuth;
    const projections = yield* Projections;
    const grants = new Map<string, Grant>();
    const transfers = new Map<string, Grant>();
    const slots = makeAdmission({ total: 6, perKey: 3, queue: 64 }, Duration.seconds(30));
    // Collecting and joining a body can hold two copies. At most 40 MiB before SQLite copies it.
    const bytes = makeAdmission(
      { total: 20 * 1024 * 1024, perKey: 3, queue: 64 },
      Duration.seconds(30),
    );
    const sweep = (now: number) => {
      for (const [key, grant] of grants) if (grant.expiresAt <= now) grants.delete(key);
    };
    const authenticate = (sessionId: AuthSessionId) =>
      Effect.gen(function* () {
        const bearer = yield* auth
          .authenticateSession(sessionId)
          .pipe(
            Effect.mapError(() =>
              refused(403, "This upload's device is no longer paired. Pair again from Mend."),
            ),
          );
        if (!bearer.session.scopes.includes(AuthOrchestrationOperateScope))
          return yield* refused(403, "Uploading images requires orchestration:operate.");
        yield* auth
          .confirmDevice(bearer)
          .pipe(
            Effect.mapError((error) =>
              refused(error._tag === "GatewayDeviceUnconfirmed" ? 503 : 403, error.message),
            ),
          );
        return bearer.session;
      });

    const issue: AttachmentUploads["Service"]["issue"] = Effect.fn("AttachmentUploads.issue")(
      function* (sessionId, input) {
        const session = yield* authenticate(sessionId);
        if (input.type === "file")
          return yield* refused(
            400,
            "Mend accepts PNG, JPEG, GIF and WebP images only. File attachments are not supported.",
          );
        if (input.sizeBytes > MEND_IMAGE_MAX_BYTES)
          return yield* refused(413, "An image can be up to 10 MiB. Use a smaller image.");
        const now = yield* Clock.currentTimeMillis;
        sweep(now);
        if (
          grants.size >= MAX_GRANTS ||
          [...grants.values()].filter((grant) => grant.person === session.mendUser.id).length >=
            MAX_GRANTS_PER_PERSON
        )
          return yield* refused(
            429,
            "Too many pending image uploads. Remove unused images or try again shortly.",
          );
        const token = randomBytes(32).toString("base64url");
        const grant: Grant = {
          sessionId,
          person: session.mendUser.id,
          attachmentId: newAttachmentId(),
          name: input.name,
          mimeType: input.mimeType,
          sizeBytes: input.sizeBytes,
          expiresAt: now + IMAGE_UPLOAD_URL_TTL_MS,
          cancelled: false,
        };
        grants.set(digest(token), grant);
        return {
          attachmentId: grant.attachmentId,
          relativeUrl: `${UPLOAD_PREFIX}/${token}`,
          expiresAt: grant.expiresAt,
        };
      },
    );

    const receive: AttachmentUploads["Service"]["receive"] = Effect.fn("AttachmentUploads.receive")(
      (token, contentType, body) =>
        Effect.scoped(
          Effect.gen(function* () {
            const key = digest(token);
            const now = yield* Clock.currentTimeMillis;
            const grant = grants.get(key);
            // Consume before any asynchronous work: a concurrent POST cannot reuse the capability.
            grants.delete(key);
            sweep(now);
            if (grant === undefined || grant.expiresAt <= now)
              return yield* refused(
                404,
                "This image upload URL expired or was already used. Retry the upload.",
              );
            transfers.set(grant.attachmentId, grant);
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                transfers.delete(grant.attachmentId);
              }),
            );
            const session = yield* authenticate(grant.sessionId);
            if (contentType?.split(";", 1)[0]?.trim().toLowerCase() !== grant.mimeType)
              return yield* refused(400, "The image's content type does not match its upload URL.");
            if (
              !(yield* slots(session.mendDeviceId)) ||
              !(yield* bytes(session.mendDeviceId, grant.sizeBytes))
            )
              return yield* refused(429, "Image uploads are busy. Retry the upload shortly.");
            const hub = yield* projections.hub(session);
            let received = 0;
            const chunks = yield* Stream.runCollect(
              body.pipe(
                Stream.mapEffect((chunk) => {
                  received += chunk.byteLength;
                  return received > grant.sizeBytes
                    ? Effect.fail(
                        refused(
                          413,
                          "The image exceeds its declared size or the 10 MiB image limit.",
                        ),
                      )
                    : Effect.succeed(chunk);
                }),
              ),
            );
            if (received !== grant.sizeBytes)
              return yield* refused(400, "The image upload was incomplete. Retry the upload.");
            if (grant.cancelled) return yield* refused(404, "This image upload was removed.");
            // A cancellation that races the SQLite write removes the result before we acknowledge it.
            yield* Effect.uninterruptible(
              Effect.gen(function* () {
                yield* hub
                  .persistUploadedImage({
                    id: grant.attachmentId,
                    name: grant.name,
                    mimeType: grant.mimeType,
                    sizeBytes: grant.sizeBytes,
                    bytes: Buffer.concat(chunks),
                  })
                  .pipe(Effect.mapError((error) => refused(400, error.message)));
                if (grant.cancelled) {
                  yield* hub
                    .deleteUploadedImage(grant.attachmentId)
                    .pipe(Effect.mapError((error) => refused(500, error.message)));
                  return yield* refused(404, "This image upload was removed.");
                }
              }),
            );
          }),
        ).pipe(
          Effect.timeoutOrElse({
            duration: "1 minute",
            orElse: () =>
              Effect.fail(refused(408, "The image upload timed out. Retry the upload.")),
          }),
        ),
    );

    const remove: AttachmentUploads["Service"]["remove"] = Effect.fn("AttachmentUploads.remove")(
      (sessionId, attachmentId) =>
        Effect.scoped(
          Effect.gen(function* () {
            const session = yield* authenticate(sessionId);
            for (const [key, grant] of grants) {
              if (grant.attachmentId === attachmentId && grant.person === session.mendUser.id)
                grants.delete(key);
            }
            const transfer = transfers.get(attachmentId);
            if (transfer?.person === session.mendUser.id) transfer.cancelled = true;
            const hub = yield* projections.hub(session);
            yield* hub
              .deleteUploadedImage(attachmentId)
              .pipe(Effect.mapError((error) => refused(500, error.message)));
          }),
        ),
    );
    return AttachmentUploads.of({ issue, receive, remove });
  });

export const AttachmentUploadsLive: Layer.Layer<
  AttachmentUploads,
  never,
  GatewayAuth | Projections
> = Layer.effect(AttachmentUploads, make);

/** The desktop and web clients POST raw image bytes without a bearer to the minted capability. */
export const AttachmentUploadRouteLive: Layer.Layer<
  never,
  never,
  HttpRouter.HttpRouter | AttachmentUploads
> = Layer.unwrap(
  Effect.gen(function* () {
    const uploads = yield* AttachmentUploads;
    return HttpRouter.add(
      "POST",
      `${UPLOAD_PREFIX}/:token`,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const { token = "" } = yield* HttpRouter.params;
        const readFailure = () =>
          refused(400, "The image upload could not be read. Retry the upload.");
        const source = request.source;
        // The default Node request stream destroys its socket when a size check stops reading.
        // Leave it open until the HTTP refusal has been sent, then close the connection.
        const body =
          source instanceof IncomingMessage
            ? NodeStream.fromReadable<Uint8Array, ImageUploadRefused>({
                evaluate: () => source,
                closeOnDone: false,
                chunkSize: 64 * 1024,
                onError: readFailure,
              })
            : request.stream.pipe(Stream.mapError(readFailure));
        yield* uploads.receive(token, request.headers["content-type"], body);
        return HttpServerResponse.empty({ status: 204, headers: { "cache-control": "no-store" } });
      }).pipe(
        Effect.catchTag("ImageUploadRefused", (error) =>
          Effect.succeed(
            HttpServerResponse.jsonUnsafe(
              { error: error.message },
              {
                status: error.status,
                headers: { "cache-control": "no-store", connection: "close" },
              },
            ),
          ),
        ),
      ),
    );
  }),
);
