import type { ReactNode } from "react";
import { FullWindowOverlay } from "react-native-screens";

import type { AskLayerProps } from "@/components/ask-layer-props";

/**
 * Above every screen, modal ones too: an iOS `Modal` presents from the root view controller,
 * which cannot present a second one while a modal screen (`adopt`) is up.
 */
export function AskLayer({ children }: AskLayerProps): ReactNode {
  return <FullWindowOverlay>{children}</FullWindowOverlay>;
}
