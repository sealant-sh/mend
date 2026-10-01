// One session. On a phone (and a foldable's cover screen) the conversation fills the screen; on an
// unfolded screen it shares it with a rail of sessions and, when asked for, the diff or a shell.

import { Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback } from "react";
import { View } from "react-native";

import { SessionPane } from "@/components/session-pane";
import { companionOf, SessionWorkspace } from "@/components/session-workspace";
import { watchSession } from "@/data/notification-presence";
import { usePosture } from "@/data/use-posture";
import { useEvidenceTheme } from "@/theme/evidence";

export default function SessionScreen() {
  const { id, mode, pane } = useLocalSearchParams<{ id: string; mode?: string; pane?: string }>();
  // While this screen has focus, a push about this session is already on screen.
  useFocusEffect(useCallback(() => watchSession(id), [id]));
  const { colors } = useEvidenceTheme();
  const posture = usePosture();

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        {posture === "compact" ? (
          <SessionPane sessionId={id} {...(mode === undefined ? {} : { mode })} topInset />
        ) : (
          <SessionWorkspace
            sessionId={id}
            mode={mode}
            posture={posture}
            initialCompanion={companionOf(pane)}
          />
        )}
      </View>
    </>
  );
}
