import type { ReactNode } from "react";
import { Modal } from "react-native";

import type { AskLayerProps } from "@/components/ask-layer-props";

export function AskLayer({ onRequestClose, children }: AskLayerProps): ReactNode {
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onRequestClose}>
      {children}
    </Modal>
  );
}
