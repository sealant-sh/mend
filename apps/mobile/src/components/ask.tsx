// `useAsk`: every confirm-first action and every notice in the app goes through it (data/ask.ts).

import { useSyncExternalStore } from "react";
import { Platform, Pressable, StyleSheet, View } from "react-native";

import { AskLayer } from "@/components/ask-layer";
import { EvButton, type ButtonVariant } from "@/components/button";
import { UiText } from "@/components/typography";
import type { Ask, AskButton } from "@/data/ask";
import { usePairing } from "@/data/pairing-scope";
import { radius, useEvidenceTheme } from "@/theme/evidence";

export const useAsk = (): Ask => usePairing().asker.ask;

/** The one consequential choice is filled; Cancel stays quiet (DESIGN.md §5). */
const variantOf = (button: AskButton, buttons: ReadonlyArray<AskButton>): ButtonVariant => {
  if (button.style === "destructive") return "danger";
  if (button.style === "cancel") return "ghost";
  const choices = buttons.filter((entry) => entry.style !== "cancel");
  return choices.length === 1 ? "primary" : "outline";
};

export function AskDialog() {
  const { colors, shadow } = useEvidenceTheme();
  const { asker } = usePairing();
  const question = useSyncExternalStore(asker.subscribe, asker.showing, () => null);
  if (question === null) return null;
  const dismiss = () => asker.dismiss(question.id);

  return (
    <AskLayer onRequestClose={dismiss}>
      <Pressable
        onPress={dismiss}
        style={{
          flex: 1,
          backgroundColor: "rgba(0,0,0,0.35)",
          justifyContent: "center",
          alignItems: "center",
          paddingHorizontal: 24,
        }}
      >
        <Pressable
          role="alertdialog"
          aria-label={question.title}
          aria-modal
          onPress={(event) => event.stopPropagation()}
          style={{
            width: "100%",
            maxWidth: 400,
            backgroundColor: colors.panel,
            borderRadius: radius.xl2,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: colors.softRule,
            boxShadow: shadow.overlay,
            padding: 18,
            gap: 8,
          }}
        >
          <UiText weight="semibold" size={15}>
            {question.title}
          </UiText>
          {question.message !== null && (
            <UiText tone="ink2" size={14}>
              {question.message}
            </UiText>
          )}
          <View
            style={{
              marginTop: 8,
              flexDirection: "row",
              flexWrap: "wrap",
              justifyContent: "flex-end",
              gap: 8,
            }}
          >
            {question.buttons.map((button, index) => (
              <EvButton
                key={`${index}:${button.text ?? ""}`}
                size={Platform.OS === "web" ? "sm" : "md"}
                variant={variantOf(button, question.buttons)}
                label={button.text ?? "OK"}
                onPress={() => asker.answer(question.id, button)}
              />
            ))}
          </View>
        </Pressable>
      </Pressable>
    </AskLayer>
  );
}
