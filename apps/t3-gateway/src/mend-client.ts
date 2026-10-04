import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { GatewayConfig } from "./config.ts";
import {
  MendEventPointer,
  MendProject,
  MendProjectDetail,
  MendRequest,
  MendTurn,
} from "./mend-workbench.ts";

/**
 * The gateway's view of Mend: an ordinary HTTP client of `/api`, calling as the person who paired
 * (ADR 0012, "A gateway, not a provider"). It does not import `@mend/api-contracts` (Effect
 * beta.93); it decodes only the fields it reads, so Mend can add fields freely.
 */

/** The platforms Mend's `POST /api/pair` accepts (`DEVICE_PLATFORMS` in @mend/api-contracts). */
export type MendDevicePlatform = "ios" | "android" | "web" | "desktop" | "other";

/** What the gateway reads from Mend's `PairClaimResult`. */
const PairClaim = Schema.Struct({
  token: Schema.String,
  user: Schema.Struct({ id: Schema.String, name: Schema.String, email: Schema.String }),
  device: Schema.Struct({ id: Schema.String, name: Schema.String }),
});
export type PairClaim = typeof PairClaim.Type;

/**
 * What the gateway reads from one entry of Mend's `GET /api/harnesses/models`
 * (`HarnessModelCatalog` in @mend/domain): a harness's models in picker order, the efforts its CLI
 * accepts, and whether a launch may ask for priority processing.
 */
const MendHarnessModel = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  isDefault: Schema.Boolean,
  /** The efforts this model takes when fewer than its harness's; null means the harness's. */
  efforts: Schema.NullOr(Schema.Array(Schema.String)),
});
const MendHarnessCatalog = Schema.Struct({
  harness: Schema.String,
  models: Schema.Array(MendHarnessModel),
  defaultModel: Schema.NullOr(Schema.String),
  efforts: Schema.Array(Schema.String),
  fastCapable: Schema.Boolean,
});
export type MendHarnessCatalog = typeof MendHarnessCatalog.Type;
const decodeHarnessCatalogs = Schema.decodeUnknownEffect(Schema.Array(MendHarnessCatalog));

/** Mend refused the pairing code: unknown, already claimed or expired, or too many tries. */
export class MendPairingRefused extends Schema.TaggedError<MendPairingRefused>()(
  "MendPairingRefused",
  {
    reason: Schema.Literals(["unknown-code", "spent-code", "rate-limited"]),
  },
) {
  override get message(): string {
    return `Mend refused the pairing code (${this.reason}).`;
  }
}

/** Mend no longer accepts the device token: the device was revoked or its person deactivated. */
export class MendDeviceRefused extends Schema.TaggedError<MendDeviceRefused>()(
  "MendDeviceRefused",
  { operation: Schema.String },
) {
  override get message(): string {
    return `Mend refused the device token on ${this.operation}.`;
  }
}

/** Mend did not answer, or answered something the gateway cannot read. */
export class MendUnavailable extends Schema.TaggedError<MendUnavailable>()("MendUnavailable", {
  operation: Schema.String,
  status: Schema.NullOr(Schema.Number),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return this.status === null
      ? `Mend did not answer ${this.operation}.`
      : `Mend answered ${this.operation} with ${this.status}.`;
  }
}

/** Mend has no such thing, or the person may not see it: a 404 on a read. */
export class MendNotFound extends Schema.TaggedError<MendNotFound>()("MendNotFound", {
  operation: Schema.String,
}) {
  override get message(): string {
    return `Mend found nothing for ${this.operation}.`;
  }
}

/** A read of the person's workbench: Mend's answer, or why there is none. */
export type MendRead<A> = Effect.Effect<A, MendDeviceRefused | MendNotFound | MendUnavailable>;

export class MendClient extends Context.Service<
  MendClient,
  {
    /** `POST /api/pair`: spends the code and returns a device token for its person. */
    readonly claimPairing: (input: {
      readonly code: string;
      readonly name: string;
      readonly platform: MendDevicePlatform;
    }) => Effect.Effect<PairClaim, MendPairingRefused | MendUnavailable>;
    /**
     * Whether Mend still accepts a device token. Mend has no `GET /api/me`; `GET /api/me/devices`
     * is the smallest read every signed-in person may make, and it answers 401 once the device is
     * revoked or its person deactivated.
     */
    readonly checkDevice: (
      deviceToken: string,
    ) => Effect.Effect<"accepted" | "refused", MendUnavailable>;
    /** `GET /api/harnesses/models`, as the person who paired: Mend's model catalog. */
    readonly listHarnessModels: (
      deviceToken: string,
    ) => Effect.Effect<ReadonlyArray<MendHarnessCatalog>, MendDeviceRefused | MendUnavailable>;
    /** `GET /api/projects`: the projects the person can see. */
    readonly listProjects: (deviceToken: string) => MendRead<ReadonlyArray<MendProject>>;
    /** `GET /api/projects/:id`: the project, its sessions and their list facts. */
    readonly projectDetail: (deviceToken: string, projectId: string) => MendRead<MendProjectDetail>;
    /** `GET /api/sessions/:id/turns`: the session's protocol turns, oldest first. */
    readonly listTurns: (
      deviceToken: string,
      sessionId: string,
    ) => MendRead<ReadonlyArray<MendTurn>>;
    /** `GET /api/sessions/:id/requests`: what its agent asked, answered or not. */
    readonly listRequests: (
      deviceToken: string,
      sessionId: string,
    ) => MendRead<ReadonlyArray<MendRequest>>;
    /**
     * `GET /api/events`: Mend's SSE pointers, filtered by Mend to what the person can see. The
     * stream ends when the connection does; the caller reconnects and re-reads.
     */
    readonly events: (
      deviceToken: string,
    ) => Stream.Stream<MendEventPointer, MendDeviceRefused | MendUnavailable>;
  }
>()("@mend/t3-gateway/MendClient") {}

const decodeProjects = Schema.decodeUnknownEffect(Schema.Array(MendProject));
const decodeProjectDetail = Schema.decodeUnknownEffect(MendProjectDetail);
const decodeTurns = Schema.decodeUnknownEffect(Schema.Array(MendTurn));
const decodeRequests = Schema.decodeUnknownEffect(Schema.Array(MendRequest));
const decodePointer = Schema.decodeUnknownOption(Schema.fromJsonString(MendEventPointer));

/** The pointer an SSE `data:` line carries, or null for a heartbeat, a blank or a stray line. */
export const pointerOfSseLine = (line: string): MendEventPointer | null => {
  if (!line.startsWith("data:")) return null;
  const pointer = decodePointer(line.slice("data:".length).trim());
  return pointer._tag === "Some" ? pointer.value : null;
};

const readJson = (
  operation: string,
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<unknown, MendUnavailable> =>
  response.json.pipe(
    Effect.mapError((cause) => new MendUnavailable({ operation, status: response.status, cause })),
  );

/** Speaks to the configured Mend through whatever `HttpClient` it is given. */
export const MendClientLive: Layer.Layer<MendClient, never, GatewayConfig | HttpClient.HttpClient> =
  Layer.effect(
    MendClient,
    Effect.gen(function* () {
      const config = yield* GatewayConfig;
      const http = yield* HttpClient.HttpClient;
      const url = (path: string) => new URL(path, config.mendUrl);

      const send = (operation: string, request: HttpClientRequest.HttpClientRequest) =>
        http
          .execute(request)
          .pipe(
            Effect.mapError((cause) => new MendUnavailable({ operation, status: null, cause })),
          );

      const claimPairing = Effect.fn("MendClient.claimPairing")(function* (input: {
        readonly code: string;
        readonly name: string;
        readonly platform: MendDevicePlatform;
      }) {
        const operation = "POST /api/pair";
        const response = yield* send(
          operation,
          HttpClientRequest.post(url("/api/pair")).pipe(
            HttpClientRequest.acceptJson,
            HttpClientRequest.bodyJsonUnsafe(input),
          ),
        );
        switch (response.status) {
          case 200: {
            const body = yield* readJson(operation, response);
            return yield* Schema.decodeUnknownEffect(PairClaim)(body).pipe(
              Effect.mapError(
                (cause) => new MendUnavailable({ operation, status: response.status, cause }),
              ),
            );
          }
          case 404:
            return yield* new MendPairingRefused({ reason: "unknown-code" });
          case 410:
            return yield* new MendPairingRefused({ reason: "spent-code" });
          case 429:
            return yield* new MendPairingRefused({ reason: "rate-limited" });
          default:
            return yield* new MendUnavailable({
              operation,
              status: response.status,
              cause: null,
            });
        }
      });

      const checkDevice = Effect.fn("MendClient.checkDevice")(function* (deviceToken: string) {
        const operation = "GET /api/me/devices";
        const response = yield* send(
          operation,
          HttpClientRequest.get(url("/api/me/devices")).pipe(
            HttpClientRequest.acceptJson,
            HttpClientRequest.bearerToken(deviceToken),
          ),
        );
        if (response.status === 200) return "accepted" as const;
        if (response.status === 401) return "refused" as const;
        return yield* new MendUnavailable({ operation, status: response.status, cause: null });
      });

      const listHarnessModels = Effect.fn("MendClient.listHarnessModels")(function* (
        deviceToken: string,
      ) {
        const operation = "GET /api/harnesses/models";
        const response = yield* send(
          operation,
          HttpClientRequest.get(url("/api/harnesses/models")).pipe(
            HttpClientRequest.acceptJson,
            HttpClientRequest.bearerToken(deviceToken),
          ),
        );
        if (response.status === 401) return yield* new MendDeviceRefused({ operation });
        if (response.status !== 200) {
          return yield* new MendUnavailable({ operation, status: response.status, cause: null });
        }
        const body = yield* readJson(operation, response);
        return yield* decodeHarnessCatalogs(body).pipe(
          Effect.mapError(
            (cause) => new MendUnavailable({ operation, status: response.status, cause }),
          ),
        );
      });

      /** A JSON read as the person: 401 is a refused device, 404 is nothing there. */
      const read = <A>(
        operation: string,
        path: string,
        deviceToken: string,
        decode: (body: unknown) => Effect.Effect<A, Schema.SchemaError>,
      ): MendRead<A> =>
        Effect.gen(function* () {
          const response = yield* send(
            operation,
            HttpClientRequest.get(url(path)).pipe(
              HttpClientRequest.acceptJson,
              HttpClientRequest.bearerToken(deviceToken),
            ),
          );
          if (response.status === 401) return yield* new MendDeviceRefused({ operation });
          if (response.status === 404) return yield* new MendNotFound({ operation });
          if (response.status !== 200) {
            return yield* new MendUnavailable({ operation, status: response.status, cause: null });
          }
          const body = yield* readJson(operation, response);
          return yield* decode(body).pipe(
            Effect.mapError(
              (cause) => new MendUnavailable({ operation, status: response.status, cause }),
            ),
          );
        }).pipe(Effect.withSpan(`MendClient ${operation}`));

      const listProjects = (deviceToken: string) =>
        read("GET /api/projects", "/api/projects", deviceToken, decodeProjects);

      const projectDetail = (deviceToken: string, projectId: string) =>
        read(
          "GET /api/projects/:id",
          `/api/projects/${encodeURIComponent(projectId)}`,
          deviceToken,
          decodeProjectDetail,
        );

      const listTurns = (deviceToken: string, sessionId: string) =>
        read(
          "GET /api/sessions/:id/turns",
          `/api/sessions/${encodeURIComponent(sessionId)}/turns`,
          deviceToken,
          decodeTurns,
        );

      const listRequests = (deviceToken: string, sessionId: string) =>
        read(
          "GET /api/sessions/:id/requests",
          `/api/sessions/${encodeURIComponent(sessionId)}/requests`,
          deviceToken,
          decodeRequests,
        );

      const events = (deviceToken: string) => {
        const operation = "GET /api/events";
        return Stream.unwrap(
          Effect.gen(function* () {
            const response = yield* send(
              operation,
              HttpClientRequest.get(url("/api/events")).pipe(
                HttpClientRequest.accept("text/event-stream"),
                HttpClientRequest.bearerToken(deviceToken),
              ),
            );
            if (response.status === 401) return yield* new MendDeviceRefused({ operation });
            if (response.status !== 200) {
              return yield* new MendUnavailable({
                operation,
                status: response.status,
                cause: null,
              });
            }
            return response.stream.pipe(
              Stream.mapError(
                (cause) => new MendUnavailable({ operation, status: response.status, cause }),
              ),
            );
          }),
        ).pipe(
          Stream.decodeText,
          Stream.splitLines,
          Stream.map(pointerOfSseLine),
          Stream.filter((pointer): pointer is MendEventPointer => pointer !== null),
        );
      };

      return {
        claimPairing,
        checkDevice,
        listHarnessModels,
        listProjects,
        projectDetail,
        listTurns,
        listRequests,
        events,
      };
    }),
  );
