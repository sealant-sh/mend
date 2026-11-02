import type { PreviewNotOpenableReason } from "@mend/api-contracts";
import { PreviewsRepo, ServicesRepo } from "@mend/db";
import {
  previewOffersOpen,
  previewOpenTarget,
  type PreviewGatewayResolution,
  type PreviewPreparation,
  type PreviewView,
} from "@mend/domain/workbench";
import { Effect } from "effect";

import type { PreviewSetup } from "./preview-config.ts";
import { REFUSED } from "./preview-headers.ts";
import type { PreviewRouting } from "./preview-routing.ts";

export type PreviewOpen =
  | { readonly _tag: "Open"; readonly target: string; readonly routing: PreviewRouting }
  | {
      readonly _tag: "Refused";
      readonly reason: Extract<PreviewNotOpenableReason, "previews-off" | "not-served">;
      readonly message: string;
    };

const PREVIEWS_OFF = "Previews are off on this Mend server.";

const unservedLine = ({ preview, binding }: PreviewView): string =>
  `${preview.serviceName} · ${
    binding._tag === "Unbound" &&
    binding.reason !== "removed" &&
    binding.reason !== "no-live-attempt"
      ? REFUSED[binding.reason].fact
      : "the gateway serves nothing for it"
  } · nothing to open`;

export const previewOpenOf = (setup: PreviewSetup, view: PreviewView): PreviewOpen => {
  if (setup._tag === "Off")
    return { _tag: "Refused", reason: "previews-off", message: PREVIEWS_OFF };
  const target = previewOpenTarget(view);
  return target === null
    ? { _tag: "Refused", reason: "not-served", message: unservedLine(view) }
    : { _tag: "Open", target, routing: setup.routing };
};

/** The shared Open decision for the worktree read, Slack, and the phone's mint endpoint. */
export const readPreviewOpen = (
  setup: PreviewSetup,
  view: PreviewView,
  resolution: PreviewGatewayResolution | null,
  preparation: PreviewPreparation | null,
): Effect.Effect<PreviewOpen, never, PreviewsRepo | ServicesRepo> =>
  Effect.gen(function* () {
    const open = previewOpenOf(setup, view);
    if (open._tag === "Refused") return open;
    const source =
      resolution?._tag === "Dormant"
        ? yield* (yield* ServicesRepo).byId(resolution.source.serviceId)
        : null;
    const activity =
      resolution?._tag === "Dormant"
        ? yield* (yield* PreviewsRepo).activityOf(view.preview.id)
        : null;
    const idleStopped =
      resolution?._tag === "Dormant" &&
      activity?.idleStoppedAttemptId === resolution.source.sourceAttemptId;
    const preparing =
      preparation?.state._tag === "Starting" &&
      preparation.state.service === view.preview.serviceName;
    return previewOffersOpen(resolution, source, idleStopped, preparing)
      ? open
      : {
          _tag: "Refused",
          reason: "not-served",
          message: `${view.preview.serviceName} · stopped or unavailable · nothing to open`,
        };
  });
