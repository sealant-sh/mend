import { useWindowDimensions } from "react-native";

import { postureOf, type Posture } from "@/data/posture";

/** The posture of the window the app draws in; follows folding, unfolding and rotation. */
export const usePosture = (): Posture => {
  const { width, height } = useWindowDimensions();
  return postureOf({ width, height });
};
