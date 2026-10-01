// Two panes and a divider a person drags: side by side open flat, one above the other upright.
// The first pane's share starts where the screen asks (half for two peers, most of the screen for
// the thing being read) and moves between a fifth and four fifths.

import { useRef, useState, type ReactNode } from "react";
import { PanResponder, View } from "react-native";

import { useEvidenceTheme } from "@/theme/evidence";

const SHARE_MIN = 0.2;
const SHARE_MAX = 0.8;
const HANDLE = 14;

export function ResizableSplit({
  sideBySide,
  initialShare = 0.5,
  label,
  first,
  second,
}: {
  /** Side by side (open flat); otherwise one above the other (upright). */
  readonly sideBySide: boolean;
  /** The first pane's starting share of the room. */
  readonly initialShare?: number;
  /** What the divider separates, for screen readers. */
  readonly label: string;
  readonly first: ReactNode;
  readonly second: ReactNode;
}) {
  const { colors } = useEvidenceTheme();
  const [share, setShare] = useState(initialShare);
  // The responder is made once; what it reads while dragging lives in refs, written by the
  // gesture and by layout, never during render.
  const shareRef = useRef(initialShare);
  const dragStart = useRef(initialShare);
  const extent = useRef(1);
  const horizontal = useRef(sideBySide);
  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        dragStart.current = shareRef.current;
      },
      onPanResponderMove: (_event, gesture) => {
        const moved = horizontal.current ? gesture.dx : gesture.dy;
        const next = Math.min(
          SHARE_MAX,
          Math.max(SHARE_MIN, dragStart.current + moved / Math.max(1, extent.current)),
        );
        shareRef.current = next;
        setShare(next);
      },
    }),
  ).current;

  return (
    <View
      style={{ flex: 1, flexDirection: sideBySide ? "row" : "column" }}
      onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout;
        horizontal.current = sideBySide;
        extent.current = sideBySide ? width : height;
      }}
    >
      <View style={{ flex: share }}>{first}</View>
      <View
        {...responder.panHandlers}
        accessibilityRole="adjustable"
        accessibilityLabel={label}
        hitSlop={sideBySide ? { left: 8, right: 8 } : { top: 8, bottom: 8 }}
        style={{
          width: sideBySide ? HANDLE : undefined,
          height: sideBySide ? undefined : HANDLE,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.sunken,
        }}
      >
        <View
          style={{
            width: sideBySide ? 3 : 36,
            height: sideBySide ? 36 : 3,
            borderRadius: 2,
            backgroundColor: colors.rule,
          }}
        />
      </View>
      <View style={{ flex: 1 - share }}>{second}</View>
    </View>
  );
}
