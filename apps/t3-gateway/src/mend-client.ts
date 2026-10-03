import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { GatewayConfig } from "./config.ts";

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
  }
>()("@mend/t3-gateway/MendClient") {}

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

      return { claimPairing, checkDevice, listHarnessModels };
    }),
  );
