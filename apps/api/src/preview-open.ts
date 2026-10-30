import type { PreviewNotOpenableReason } from "@mend/api-contracts";
import { previewOpenTarget, type PreviewView } from "@mend/domain/workbench";

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
