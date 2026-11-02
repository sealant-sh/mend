import { useEvent } from "expo";
import { useVideoPlayer, VideoView } from "expo-video";
import { View } from "react-native";

import { UiText } from "@/components/typography";
import type { proofMediaSource } from "@/data/proof-media";

export function ProofVideo({
  source,
  thumbnail = false,
}: {
  readonly source: ReturnType<typeof proofMediaSource>;
  readonly thumbnail?: boolean;
}) {
  const player = useVideoPlayer({ ...source, contentType: "progressive", useCaching: false });
  const { status } = useEvent(player, "statusChange", { status: player.status });
  return (
    <View style={{ width: "100%", aspectRatio: 1.6 }} pointerEvents={thumbnail ? "none" : "auto"}>
      <VideoView
        player={player}
        nativeControls={!thumbnail}
        contentFit="contain"
        style={{ width: "100%", height: "100%" }}
      />
      {status === "error" ? (
        <UiText size={13} tone="muted">
          This video could not be loaded.
        </UiText>
      ) : null}
    </View>
  );
}
