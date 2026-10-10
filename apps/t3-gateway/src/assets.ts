import { randomBytes } from "node:crypto";

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpMiddleware from "effect/unstable/http/HttpMiddleware";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { GatewayState } from "./state.ts";

/**
 * The URL a t3code client fetches an image of a message from (`assets.createUrl` for an
 * `attachment`, ADR 0012 phase 2). t3code's own server signs `/api/assets/<token>/<file name>`
 * and serves it without a bearer, because an `<img>` carries none; the gateway does the same with
 * a random token it keeps in memory: one person's one image, for ten minutes. A restart forgets
 * them, and the client asks again. The token is the credential, and it is in the path, so these
 * requests are neither logged nor traced (`AssetTracingDisabledLive`).
 */

export const ASSET_ROUTE_PREFIX = "/api/assets";
export const ASSET_URL_TTL_MS = 10 * 60_000;

export interface AssetGrant {
  readonly mendUserId: string;
  readonly imageId: string;
}

export class AssetUrls extends Context.Service<
  AssetUrls,
  {
    /** A URL path for one of a person's images, and when it stops working (epoch ms). */
    readonly issue: (
      grant: AssetGrant & { readonly fileName: string },
    ) => Effect.Effect<{ readonly relativeUrl: string; readonly expiresAt: number }>;
    /** What a token grants while it is live. */
    readonly resolve: (token: string) => Effect.Effect<Option.Option<AssetGrant>>;
  }
>()("@mend/t3-gateway/AssetUrls") {}

export const AssetUrlsLive: Layer.Layer<AssetUrls> = Layer.sync(AssetUrls, () => {
  const live = new Map<string, AssetGrant & { readonly expiresAt: number }>();
  const sweep = (now: number) => {
    for (const [token, grant] of live) {
      if (grant.expiresAt <= now) live.delete(token);
    }
  };
  return {
    issue: ({ fileName, ...grant }) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        sweep(now);
        const token = `ast_${randomBytes(32).toString("base64url")}`;
        const expiresAt = now + ASSET_URL_TTL_MS;
        live.set(token, { ...grant, expiresAt });
        return {
          relativeUrl: `${ASSET_ROUTE_PREFIX}/${token}/${encodeURIComponent(fileName)}`,
          expiresAt,
        };
      }),
    resolve: (token) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const grant = live.get(token);
        if (grant === undefined || grant.expiresAt <= now) return Option.none<AssetGrant>();
        return Option.some({ mendUserId: grant.mendUserId, imageId: grant.imageId });
      }),
  };
});

const notFound = () =>
  HttpServerResponse.text("Not Found", {
    status: 404,
    headers: { "cache-control": "no-store" },
  });

/** `GET /api/assets/<token>/<file name>`: the image a live token grants, else 404. */
export const AssetRouteLive: Layer.Layer<
  never,
  never,
  HttpRouter.HttpRouter | AssetUrls | GatewayState
> = Layer.unwrap(
  Effect.gen(function* () {
    const urls = yield* AssetUrls;
    const state = yield* GatewayState;
    return HttpRouter.add(
      "GET",
      `${ASSET_ROUTE_PREFIX}/*`,
      // The path carries the credential: the request log would write it out.
      HttpMiddleware.withLoggerDisabled(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const url = HttpServerRequest.toURL(request);
          if (Option.isNone(url)) return notFound();
          const [token = ""] = url.value.pathname.slice(`${ASSET_ROUTE_PREFIX}/`.length).split("/");
          const grant = yield* urls.resolve(token);
          if (Option.isNone(grant)) return notFound();
          const kept = yield* state
            .imageBytes(grant.value.mendUserId, grant.value.imageId)
            .pipe(Effect.orElseSucceed(() => null));
          if (kept === null) return notFound();
          return HttpServerResponse.uint8Array(kept.bytes, {
            contentType: kept.image.mimeType,
            headers: {
              "cache-control": "private, max-age=600",
              "x-content-type-options": "nosniff",
              "content-disposition": "inline",
            },
          });
        }),
      ),
    );
  }),
);

/** Whether a request is for an asset: its path carries a credential. */
export const isAssetRequest = (request: HttpServerRequest.HttpServerRequest) =>
  request.url.startsWith(`${ASSET_ROUTE_PREFIX}/`);

/** No trace span for an asset request: a span records the path, and with it the credential. */
export const AssetTracingDisabledLive: Layer.Layer<never> = Layer.succeed(
  HttpMiddleware.TracerDisabledWhen,
)(isAssetRequest);
