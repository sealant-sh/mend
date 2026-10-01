// The full-screen terminal route: one shell (or a legacy agent terminal) with its key bar. Going
// back detaches; Stop ends the shell.

import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback } from "react";
import { Alert, Pressable } from "react-native";

import { TerminalPane } from "@/components/terminal-pane";
import { MonoText } from "@/components/typography";
import { useSessionActions } from "@/data/live";
import { watchSession } from "@/data/notification-presence";

export default function TerminalScreen() {
  const { id, process } = useLocalSearchParams<{ id: string; process?: string }>();
  const router = useRouter();
  // The session's terminal counts as the session on screen: its pushes stay silent here.
  useFocusEffect(useCallback(() => watchSession(id), [id]));
  const { stopShell } = useSessionActions();

  const confirmStop = () => {
    if (process === undefined) {
      return;
    }
    Alert.alert("Stop this shell?", "This ends the shell process. Going back only detaches.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Stop shell",
        style: "destructive",
        onPress: () =>
          stopShell.mutate(process, {
            onSuccess: () => router.back(),
          }),
      },
    ]);
  };
  const screenOptions =
    process === undefined
      ? { title: "Terminal" }
      : {
          title: "Shell",
          headerRight: () => (
            <Pressable disabled={stopShell.isPending} onPress={confirmStop}>
              <MonoText tone="danger" size={12}>
                {stopShell.isPending ? "stopping…" : "Stop"}
              </MonoText>
            </Pressable>
          ),
        };

  return (
    <>
      <Stack.Screen options={screenOptions} />
      {id === undefined ? null : (
        <TerminalPane sessionId={id} {...(process === undefined ? {} : { processId: process })} />
      )}
    </>
  );
}
