// Button weight hierarchy (DESIGN.md §5): the one consequential action is
// filled cobalt with the cobalt-lift; cheaper actions stay quiet. `danger` is
// that action when it ends something: filled red, the web app's destructive.

import type { StyleProp, ViewStyle } from "react-native";
import { Pressable } from "react-native";

import { UiText } from "@/components/typography";
import { radius, useEvidenceTheme } from "@/theme/evidence";

export type ButtonVariant = "primary" | "danger" | "outline" | "ghost";

export function EvButton({
  label,
  variant = "primary",
  size = "md",
  onPress,
  disabled = false,
  style,
}: {
  readonly label: string;
  readonly variant?: ButtonVariant;
  readonly size?: "md" | "sm";
  readonly onPress?: () => void;
  readonly disabled?: boolean;
  readonly style?: StyleProp<ViewStyle>;
}) {
  const { colors, shadow } = useEvidenceTheme();
  const base: ViewStyle = {
    minHeight: size === "sm" ? 34 : 44,
    borderRadius: radius.xl,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: size === "sm" ? 14 : 20,
  };
  const byVariant: Record<ButtonVariant, ViewStyle> = {
    primary: { backgroundColor: colors.accent, boxShadow: shadow.cobalt },
    danger: { backgroundColor: colors.red, boxShadow: shadow.xs },
    outline: {
      backgroundColor: colors.panel,
      borderWidth: 1,
      borderColor: colors.rule,
      boxShadow: shadow.xs,
    },
    ghost: {},
  };
  const filled = variant === "primary" || variant === "danger";
  const tone = filled ? undefined : variant === "outline" ? "ink" : "accent";
  return (
    <Pressable
      accessibilityRole="button"
      {...(onPress ? { onPress } : {})}
      disabled={disabled}
      style={({ pressed }) => [
        base,
        byVariant[variant],
        pressed && { opacity: 0.82 },
        disabled && { opacity: 0.45 },
        style,
      ]}
    >
      <UiText
        weight="medium"
        size={size === "sm" ? 13 : 14}
        {...(tone ? { tone } : {})}
        style={filled ? { color: colors.accentForeground } : undefined}
      >
        {label}
      </UiText>
    </Pressable>
  );
}
