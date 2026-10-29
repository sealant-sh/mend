import type { ReactNode } from "react";

export interface AskLayerProps {
  readonly onRequestClose: () => void;
  readonly children: ReactNode;
}
