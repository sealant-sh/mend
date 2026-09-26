import { createHash, randomBytes } from "node:crypto";

import {
  CliAuthApproved,
  CliAuthDenied,
  CliAuthNotFound,
  CliAuthPending,
  CliAuthRequestView,
  CliAuthSpent,
  CliAuthStartView,
  CurrentUser,
  DeviceView,
  MendApi,
  NotFound,
  MintedDevice,
  PairClaimResult,
  PairingCodeNotFound,
  PairingCodeSpent,
  PairingRateLimited,
  PairingView,
} from "@mend/api-contracts";
import {
  DevicesRepo,
  type CliAuthRequest,
  type CliAuthSpentError,
  type CliAuthUnknownError,
  type PairedDevice,
} from "@mend/db";
import {
  clientAddressOf,
  inCidr,
  NetworkConfig,
  trustedProxyCidrs,
  type PublicNetwork,
  type PublicOrigin,
} from "@mend/network";
import { Effect, Layer, Option } from "effect";
import { HttpServerRequest } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";

/**
 * Device pairing: the operator mints a code on a machine they are signed in on,
 * a phone claims it once, and the claim hands back a bearer token that Mend
 * stores only as a hash. The code is short enough to type and short-lived
 * enough that reading it aloud is the whole security model it needs.
 */

/** Crockford base32 minus the shapes people mistype: 0, O, 1, I and L are all absent. */
export const PAIRING_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

export const PAIRING_CODE_LENGTH = 8;

/** Ten minutes: long enough to walk to the phone, short enough to be worthless later. */
export const PAIRING_TTL_MS = 10 * 60 * 1000;

export const DEVICE_TOKEN_PREFIX = "mdt_";

/** A code as stored and compared: upper case, dashes and spaces stripped. */
export const normalisePairingCode = (input: string): string =>
  input.toUpperCase().replaceAll(/[^0-9A-Z]/g, "");

/** "ABCDEFGH" → "ABCD-EFGH". The grouping is for reading aloud, never for storage. */
export const groupPairingCode = (code: string): string =>
  code.length === PAIRING_CODE_LENGTH ? `${code.slice(0, 4)}-${code.slice(4)}` : code;

/**
 * A code drawn uniformly from the alphabet: bytes at or above the largest whole
 * multiple of the alphabet length are discarded rather than folded, so no
 * character is more likely than any other.
 */
export const generatePairingCode = (
  bytes: (count: number) => Uint8Array = (count) => randomBytes(count),
): string => {
  const limit = 256 - (256 % PAIRING_ALPHABET.length);
  let code = "";
  while (code.length < PAIRING_CODE_LENGTH) {
    for (const byte of bytes(PAIRING_CODE_LENGTH)) {
      if (byte >= limit) continue;
      code += PAIRING_ALPHABET.charAt(byte % PAIRING_ALPHABET.length);
      if (code.length === PAIRING_CODE_LENGTH) break;
    }
  }
  return code;
};

/** The token handed to the claimer once. 32 random bytes, base64url, prefixed so it is recognisable. */
export const mintDeviceToken = (): string =>
  `${DEVICE_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;

export const DEVICE_CODE_PREFIX = "mdc_";

/**
 * The CLI's polling secret for one authorize request — same entropy as a
 * device token, distinct prefix so a leaked log line is legible. Stored
 * hashed, like everything else that grants access.
 */
export const mintCliDeviceCode = (): string =>
  `${DEVICE_CODE_PREFIX}${randomBytes(32).toString("base64url")}`;

/** How often the CLI should ask again. LAN-local; two seconds feels immediate. */
export const CLI_AUTH_POLL_SECONDS = 2;

/** Where a browser approves the code — resolved against whichever base URL the CLI called. */
export const cliAuthVerifyPath = (userCode: string): string =>
  `/authorize?code=${groupPairingCode(userCode)}`;

/**
 * What is kept at rest. `packages/auth` computes the same hash on the way in —
 * the two must stay identical, which is why it is one line of stock sha256.
 */
export const hashDeviceToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

/**
 * `/pair` is unauthenticated by construction, so failed claims are counted per
 * address: ten a minute buys an attacker nothing against a 30^8 code space.
 * In-memory on purpose — the floor should cost nothing and survive nothing.
 */
export interface ClaimLimiter {
  /** Seconds to wait when the address is over its budget, null when it is not. */
  readonly retryAfter: (address: string, now: number) => number | null;
  readonly recordFailure: (address: string, now: number) => void;
}

const LIMITER_SWEEP_SIZE = 1_000;

export const makeClaimLimiter = (max = 10, windowMs = 60_000): ClaimLimiter => {
  const failures = new Map<string, ReadonlyArray<number>>();

  const recent = (address: string, now: number): ReadonlyArray<number> => {
    const kept = (failures.get(address) ?? []).filter((at) => now - at < windowMs);
    if (kept.length === 0) failures.delete(address);
    else failures.set(address, kept);
    return kept;
  };

  return {
    retryAfter: (address, now) => {
      const kept = recent(address, now);
      const oldest = kept[0];
      if (kept.length < max || oldest === undefined) return null;
      return Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000));
    },
    recordFailure: (address, now) => {
      // Rotating addresses would otherwise grow the map without bound. Deleting
      // during iteration is defined behaviour for a Map.
      if (failures.size > LIMITER_SWEEP_SIZE) {
        for (const key of failures.keys()) recent(key, now);
      }
      failures.set(address, [...recent(address, now), now]);
    },
  };
};

const claimLimiter = makeClaimLimiter();

/**
 * The CLI authorize surface keeps its own budget: opening a request and
 * polling with an unknown device code both count, so an address can neither
 * fill the table with pending requests nor fish for device codes.
 */
const cliAuthLimiter = makeClaimLimiter();

/** What a failed claim is counted against: the one client address resolver (`@mend/network`). */
export const claimAddress = clientAddressOf;
export { inCidr };

const toDeviceView = (device: PairedDevice): DeviceView =>
  new DeviceView({
    id: device.id,
    name: device.name,
    platform: device.platform,
    createdAt: device.createdAt.toISOString(),
    lastUsedAt: device.lastUsedAt === null ? null : device.lastUsedAt.toISOString(),
  });

const toCliAuthView = (request: CliAuthRequest): CliAuthRequestView =>
  new CliAuthRequestView({
    code: request.userCode,
    name: request.name,
    createdAt: request.createdAt.toISOString(),
    expiresAt: request.expiresAt.toISOString(),
  });

/** Repo misses as the contract speaks them: unknown is 404, anything spent is 410. */
const mapCliAuthMiss = <A, R>(
  effect: Effect.Effect<A, CliAuthUnknownError | CliAuthSpentError, R>,
): Effect.Effect<A, CliAuthNotFound | CliAuthSpent, R> =>
  effect.pipe(
    Effect.catchTag("CliAuthUnknownError", () => Effect.fail(new CliAuthNotFound())),
    Effect.catchTag("CliAuthSpentError", () => Effect.fail(new CliAuthSpent())),
  );

/**
 * Choose only from configured origins for the address a claiming device stores.
 * Origin and Host headers may select an allowed value but can never introduce one.
 */
export const configuredOriginForRequest = (
  network: PublicNetwork,
  headers: Readonly<Record<string, string | undefined>>,
): PublicOrigin => {
  const origin = network.allowedOrigins.find((allowed) => allowed === headers["origin"]);
  if (origin !== undefined) return origin;

  const host = headers["host"];
  if (host === undefined) return network.appUrl;
  return network.allowedOrigins.find((allowed) => new URL(allowed).host === host) ?? network.appUrl;
};

/**
 * Both pairing groups, built over one repo resolved at layer construction: an
 * HttpApi handler that yields a service turns it into a per-request requirement
 * the serve boundary has to satisfy, and this pairing owns its own storage.
 */
const devicePairingGroups = Effect.gen(function* () {
  const devices = yield* DevicesRepo;
  const network = yield* NetworkConfig;

  /** Who this unauthenticated request is, for rate-limiting purposes. */
  const requestAddress = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const trusted = yield* trustedProxyCidrs.pipe(Effect.orDie);
    return claimAddress(
      Option.getOrUndefined(request.remoteAddress),
      request.headers["x-forwarded-for"],
      trusted,
    );
  });

  const userDevices = HttpApiBuilder.group(MendApi, "userDevices", (handlers) =>
    handlers
      .handle("createPairing", () =>
        Effect.gen(function* () {
          const caller = yield* CurrentUser;
          const pairing = yield* devices.createPairing({
            userId: caller.user.id,
            code: generatePairingCode(),
            expiresAt: new Date(Date.now() + PAIRING_TTL_MS),
          });
          return new PairingView({
            code: pairing.code,
            expiresAt: pairing.expiresAt.toISOString(),
            urls: network.allowedOrigins,
          });
        }),
      )
      // The owner mints the token themselves, for a device that cannot scan a
      // code: an App Review tester, a headless box. Same row, same revoke.
      .handle("create", ({ payload }) =>
        Effect.gen(function* () {
          const caller = yield* CurrentUser;
          const name = payload.name.trim();
          const token = mintDeviceToken();
          const device = yield* devices.create({
            userId: caller.user.id,
            name: name === "" ? payload.platform : name,
            platform: payload.platform,
            tokenHash: hashDeviceToken(token),
          });
          return new MintedDevice({
            token,
            urls: network.allowedOrigins,
            device: toDeviceView(device),
          });
        }),
      )
      .handle("list", () =>
        Effect.gen(function* () {
          const caller = yield* CurrentUser;
          const rows = yield* devices.list(caller.user.id);
          return rows.map(toDeviceView);
        }),
      )
      .handle("revoke", ({ params }) =>
        Effect.gen(function* () {
          const caller = yield* CurrentUser;
          const device = yield* devices
            .revoke(caller.user.id, params.id)
            .pipe(Effect.mapError(() => new NotFound({ id: params.id })));
          return toDeviceView(device);
        }),
      )
      .handle("cliAuthRequest", ({ params }) =>
        Effect.gen(function* () {
          const request = yield* mapCliAuthMiss(
            devices.getCliAuth(normalisePairingCode(params.code)),
          );
          return toCliAuthView(request);
        }),
      )
      .handle("approveCliAuth", ({ params }) =>
        Effect.gen(function* () {
          const caller = yield* CurrentUser;
          const request = yield* mapCliAuthMiss(
            devices.approveCliAuth({
              userCode: normalisePairingCode(params.code),
              userId: caller.user.id,
            }),
          );
          return toCliAuthView(request);
        }),
      )
      .handle("denyCliAuth", ({ params }) =>
        Effect.gen(function* () {
          const request = yield* mapCliAuthMiss(
            devices.denyCliAuth(normalisePairingCode(params.code)),
          );
          return toCliAuthView(request);
        }),
      ),
  );

  const pair = HttpApiBuilder.group(MendApi, "pair", (handlers) =>
    handlers.handle("claim", ({ payload }) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const trusted = yield* trustedProxyCidrs.pipe(Effect.orDie);
        const address = claimAddress(
          Option.getOrUndefined(request.remoteAddress),
          request.headers["x-forwarded-for"],
          trusted,
        );

        const retryAfterSeconds = claimLimiter.retryAfter(address, Date.now());
        if (retryAfterSeconds !== null) {
          return yield* Effect.fail(new PairingRateLimited({ retryAfterSeconds }));
        }

        const name = payload.name.trim();
        const token = mintDeviceToken();
        const claimed = yield* devices
          .claim({
            code: normalisePairingCode(payload.code),
            name: name === "" ? payload.platform : name,
            platform: payload.platform,
            tokenHash: hashDeviceToken(token),
          })
          .pipe(
            Effect.tapError(() =>
              Effect.sync(() => claimLimiter.recordFailure(address, Date.now())),
            ),
            Effect.catchTag("PairingCodeUnknownError", () =>
              Effect.fail(new PairingCodeNotFound()),
            ),
            Effect.catchTag("PairingCodeSpentError", () => Effect.fail(new PairingCodeSpent())),
          );

        return new PairClaimResult({
          token,
          url: configuredOriginForRequest(network, request.headers),
          user: { id: claimed.user.id, name: claimed.user.name, email: claimed.user.email },
          device: { id: claimed.device.id, name: claimed.device.name },
        });
      }),
    ),
  );

  const cliAuth = HttpApiBuilder.group(MendApi, "cliAuth", (handlers) =>
    handlers
      .handle("start", ({ payload }) =>
        Effect.gen(function* () {
          const address = yield* requestAddress;
          const retryAfterSeconds = cliAuthLimiter.retryAfter(address, Date.now());
          if (retryAfterSeconds !== null) {
            return yield* Effect.fail(new PairingRateLimited({ retryAfterSeconds }));
          }
          // Every open request spends budget — pending rows are not free.
          cliAuthLimiter.recordFailure(address, Date.now());

          const deviceCode = mintCliDeviceCode();
          const name = payload.name.trim();
          const opened = yield* devices.createCliAuth({
            deviceCodeHash: hashDeviceToken(deviceCode),
            userCode: generatePairingCode(),
            name: name === "" ? "cli" : name,
            expiresAt: new Date(Date.now() + PAIRING_TTL_MS),
          });
          return new CliAuthStartView({
            deviceCode,
            code: opened.userCode,
            verifyPath: cliAuthVerifyPath(opened.userCode),
            expiresAt: opened.expiresAt.toISOString(),
            intervalSeconds: CLI_AUTH_POLL_SECONDS,
          });
        }),
      )
      .handle("poll", ({ payload }) =>
        Effect.gen(function* () {
          const address = yield* requestAddress;
          const retryAfterSeconds = cliAuthLimiter.retryAfter(address, Date.now());
          if (retryAfterSeconds !== null) {
            return yield* Effect.fail(new PairingRateLimited({ retryAfterSeconds }));
          }

          // The token is minted for this poll and kept only if the collection
          // wins; a pending request answers pending and the mint is forgotten.
          const token = mintDeviceToken();
          return yield* devices
            .collectCliAuth({
              deviceCodeHash: hashDeviceToken(payload.deviceCode),
              platform: "cli",
              tokenHash: hashDeviceToken(token),
            })
            .pipe(
              Effect.map(
                (claimed) =>
                  new CliAuthApproved({
                    status: "approved",
                    token,
                    user: {
                      id: claimed.user.id,
                      name: claimed.user.name,
                      email: claimed.user.email,
                    },
                    device: { id: claimed.device.id, name: claimed.device.name },
                  }),
              ),
              Effect.catchTag("CliAuthPendingError", () =>
                Effect.succeed(new CliAuthPending({ status: "pending" })),
              ),
              // Only unknown codes count as fishing; a real CLI seeing its own
              // request denied or expired is not an attack.
              Effect.catchTag("CliAuthUnknownError", () => {
                cliAuthLimiter.recordFailure(address, Date.now());
                return Effect.fail(new CliAuthNotFound());
              }),
              Effect.catchTag("CliAuthDeniedError", () => Effect.fail(new CliAuthDenied())),
              Effect.catchTag("CliAuthSpentError", () => Effect.fail(new CliAuthSpent())),
            );
        }),
      ),
  );

  return Layer.mergeAll(userDevices, pair, cliAuth);
});

export const DevicePairingLive = Layer.unwrap(devicePairingGroups);
