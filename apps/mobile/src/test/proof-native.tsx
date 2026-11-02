import type { ImageProps } from "expo-image";
import type { VideoSource } from "expo-video";
import { useMemo, type ReactNode } from "react";

import { storage, secureStore } from "./memory-storage";

export default storage;
export const { WHEN_UNLOCKED_THIS_DEVICE_ONLY, getItemAsync, setItemAsync, deleteItemAsync } =
  secureStore;
export const useSafeAreaInsets = () => ({ top: 0, bottom: 0, left: 0, right: 0 });

export const mediaRequests: { kind: "image" | "video"; source: unknown; controls: boolean }[] = [];

export function Image({ source, accessibilityLabel, onError }: ImageProps) {
  mediaRequests.push({ kind: "image", source, controls: false });
  return <img alt={accessibilityLabel} onError={() => onError?.({ error: "Unavailable" })} />;
}

export function useVideoPlayer(source: VideoSource) {
  return useMemo(() => ({ source, status: "readyToPlay" }), [JSON.stringify(source)]);
}
export function useEvent(_player: unknown, _event: string, initial: { readonly status: string }) {
  return initial;
}
export function VideoView({
  player,
  nativeControls,
}: {
  readonly player: ReturnType<typeof useVideoPlayer>;
  readonly nativeControls: boolean;
}) {
  mediaRequests.push({ kind: "video", source: player.source, controls: nativeControls });
  return <video controls={nativeControls} />;
}
export function Link({
  href,
  children,
  onPress,
}: {
  readonly href: { readonly params: { readonly id: string } };
  readonly children: ReactNode;
  readonly onPress: () => void;
}) {
  return (
    <a href={`/session/${href.params.id}`} onClick={onPress}>
      {children}
    </a>
  );
}
