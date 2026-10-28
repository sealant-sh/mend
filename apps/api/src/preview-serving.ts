import type { PreviewGrantsRepo, PreviewsRepo, UpgradeTicketsRepo } from "@mend/db";
import type { ForwardAdapter, SessionEngine, WorkspaceCaller } from "@mend/sessions";
import { Layer } from "effect";

import type { ProjectAccess } from "./access.ts";
import type { Budgets } from "./budgets.ts";
import type { ConnectionRegistry } from "./connections.ts";
import type { EventBus } from "./events-bus.ts";
import type { PreviewSetup } from "./preview-config.ts";
import { makePreviewGatewayLayer, type PreviewListenFailed } from "./preview-gateway.ts";
import { PreviewConfig, type PreviewIdentity } from "./preview-identity.ts";
import { PreviewTargetsLive } from "./preview-targets.ts";

type GatewayNeeds =
  | PreviewIdentity
  | PreviewConfig
  | PreviewsRepo
  | SessionEngine
  | WorkspaceCaller
  | ForwardAdapter
  | EventBus
  | Budgets
  | ConnectionRegistry;

const gatewayOf = (
  setup: PreviewSetup,
  trustedProxies: ReadonlyArray<string>,
): Layer.Layer<never, PreviewListenFailed, GatewayNeeds> =>
  setup._tag === "Off"
    ? Layer.empty
    : makePreviewGatewayLayer({ ...setup.gateway, trustedProxies }).pipe(
        Layer.provide(PreviewTargetsLive),
      );

export const previewConfigOf = (appUrl: string, setup: PreviewSetup): PreviewConfig["Service"] => ({
  appUrl,
  routing: setup._tag === "On" ? setup.routing : null,
});

/**
 * `router` and, when previews are on, the preview gateway beside it, on one `identity` built once
 * (ADR 0017, delivery 7): the router's `/api/preview-auth` mints the tickets the gateway exchanges.
 * Provide `EventBus` and `ConnectionRegistry` once beneath the result, so both halves share them
 * too: one registry, one sweep and one grant cleanup per process.
 */
export const servePreviews = <E, R>(
  router: Layer.Layer<never, E, R>,
  options: {
    readonly setup: PreviewSetup;
    readonly appUrl: string;
    readonly trustedProxies: ReadonlyArray<string>;
    readonly identity: Layer.Layer<
      PreviewIdentity,
      never,
      | PreviewConfig
      | PreviewGrantsRepo
      | PreviewsRepo
      | UpgradeTicketsRepo
      | ProjectAccess
      | EventBus
    >;
  },
) =>
  Layer.merge(router, gatewayOf(options.setup, options.trustedProxies)).pipe(
    Layer.provide(
      options.identity.pipe(
        Layer.provideMerge(
          Layer.succeed(PreviewConfig, previewConfigOf(options.appUrl, options.setup)),
        ),
      ),
    ),
  );
