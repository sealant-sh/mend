// Where a conversation sits decides how its composer meets the keyboard. Full screen (the phone),
// the composer rides the keyboard (`KeyboardStickyView`) and clears the home indicator. In a pane
// of a wide layout it sits under the conversation in the pane's own flow: the layout's
// `KeyboardAvoidingView` shrinks every pane at once, and only a pane that reaches the bottom edge
// clears the home indicator.

import { createContext, useContext, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useEvidenceTheme } from "@/theme/evidence";

export interface PaneEdges {
  /** The composer rides the keyboard; false when a wide layout avoids it for every pane. */
  readonly sticky: boolean;
  /** Room to leave under the composer while the keyboard is down. */
  readonly bottom: number;
}

const PaneContext = createContext<PaneEdges | null>(null);

/** A pane of a wide layout. `atBottom` for one that reaches the screen's bottom edge. */
export function Pane({
  atBottom,
  children,
}: {
  readonly atBottom: boolean;
  readonly children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <PaneContext.Provider value={{ sticky: false, bottom: atBottom ? insets.bottom : 0 }}>
      {children}
    </PaneContext.Provider>
  );
}

/** The edges of the pane this renders in; outside any pane, the full screen's. */
export const usePaneEdges = (): PaneEdges => {
  const insets = useSafeAreaInsets();
  return useContext(PaneContext) ?? { sticky: true, bottom: insets.bottom };
};

/** The strip under a conversation that holds its composer: riding the keyboard, or in the pane. */
export function ComposerDock({ children }: { readonly children: ReactNode }) {
  const { sticky } = usePaneEdges();
  if (!sticky) return <View>{children}</View>;
  return (
    <KeyboardStickyView
      style={{ position: "absolute", bottom: 0, left: 0, right: 0 }}
      offset={{ closed: 0, opened: 0 }}
    >
      {children}
    </KeyboardStickyView>
  );
}

/** The rule between two panes: upright between top and bottom, open flat between left and right. */
export function PaneDivider({ vertical }: { readonly vertical: boolean }) {
  const { colors } = useEvidenceTheme();
  return (
    <View
      style={
        vertical
          ? { width: StyleSheet.hairlineWidth, backgroundColor: colors.rule }
          : { height: StyleSheet.hairlineWidth, backgroundColor: colors.rule }
      }
    />
  );
}
