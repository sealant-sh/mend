// The lines around a pinned slice, shared by Review and Diff: what the slice
// was observed on, whether a newer one is opening or waiting, what failed,
// and the body that stands in for the diff when there is none to draw. The
// decisions live in data/review-state.ts; this only renders them.

import { View } from "react-native";

import { EvButton } from "@/components/button";
import { Panel, PanelRow } from "@/components/panel";
import { MonoText } from "@/components/typography";
import type { ReviewDiffDto } from "@/data/review";
import { movedLine, observationLine, type ChangeBody } from "@/data/review-state";

type Step = "open" | "diff";

/** Loading, failed (with retry) or empty — never one dressed as another. */
export function BodyPanel({
  body,
  onRetry,
}: {
  readonly body: Exclude<ChangeBody, { readonly kind: "files" }>;
  readonly onRetry: (step: Step) => void;
}) {
  return (
    <Panel>
      <PanelRow first>
        {body.kind === "failed" ? (
          <View style={{ gap: 8 }}>
            <MonoText tone="danger">{body.line}</MonoText>
            <MonoText size={11} tone="ink2" numberOfLines={6}>
              {body.detail}
            </MonoText>
            <View style={{ flexDirection: "row" }}>
              <EvButton
                size="sm"
                variant="outline"
                label="Retry"
                onPress={() => onRetry(body.step)}
              />
            </View>
          </View>
        ) : (
          <MonoText tone={body.kind === "loading" ? "faint" : "ink"}>{body.line}</MonoText>
        )}
      </PanelRow>
    </Panel>
  );
}

/** Observation, advance and failure lines for the slice on screen. */
export function SliceStatus({
  review,
  advancing,
  heldFor,
  failure,
  onRetry,
}: {
  readonly review: ReviewDiffDto | null;
  readonly advancing: boolean;
  /** A newer checkpoint's ordinal while a draft keeps this slice; null otherwise. */
  readonly heldFor: number | null;
  readonly failure: { readonly step: Step; readonly line: string } | null;
  readonly onRetry: (step: Step) => void;
}) {
  if (review === null) return null;
  const observed = observationLine(review.observation);
  const moved = advancing || heldFor !== null ? null : movedLine(review);
  return (
    <View style={{ gap: 4 }}>
      {observed === null ? null : (
        <MonoText size={10.5} tone="faint">
          {observed}
        </MonoText>
      )}
      {advancing ? (
        <MonoText size={10.5} tone="label">
          newer checkpoint · opening it…
        </MonoText>
      ) : null}
      {heldFor === null ? null : (
        <MonoText size={10.5} tone="label">
          checkpoint {heldFor} landed · this review stays on checkpoint {review.checkpointB.ordinal}{" "}
          while you write
        </MonoText>
      )}
      {moved === null ? null : (
        <MonoText size={10.5} tone="warning">
          {moved}
        </MonoText>
      )}
      {failure === null ? null : (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <MonoText size={10.5} tone="danger" numberOfLines={3} style={{ flex: 1 }}>
            {failure.line}
          </MonoText>
          <EvButton size="sm" variant="ghost" label="Retry" onPress={() => onRetry(failure.step)} />
        </View>
      )}
    </View>
  );
}
