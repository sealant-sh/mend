// A session's header in one row, the way t3code keeps its thread header: the title, one line of
// status and worktree under it, and the actions as icon buttons. Past the room for them, the rest
// wait behind a "more" button. Pinned actions (a tile's expand and close) always show.

import { Ellipsis, type LucideIcon } from "lucide-react-native";
import { useState, type ReactNode } from "react";
import { Modal, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { UiText } from "@/components/typography";
import { splitHeaderActions } from "@/data/header-actions";
import { radius, useEvidenceTheme } from "@/theme/evidence";

export interface HeaderAction {
  readonly key: string;
  /** What the button does, for screen readers and the "more" menu. */
  readonly label: string;
  readonly icon: LucideIcon;
  readonly onPress: () => void;
  /** Toggled on: the diff or shell it opens is showing. */
  readonly active?: boolean;
  readonly tone?: "accent" | "danger";
  readonly disabled?: boolean;
  /** Only ever in the "more" menu, never a button (`splitHeaderActions`). */
  readonly menuOnly?: boolean;
}

const BUTTON = 40;

function IconAction({ action }: { readonly action: HeaderAction }) {
  const { colors } = useEvidenceTheme();
  const Icon = action.icon;
  let color = colors.ink2;
  if (action.active === true || action.tone === "accent") color = colors.accent;
  else if (action.tone === "danger") color = colors.red;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={action.label}
      accessibilityState={{ selected: action.active === true, disabled: action.disabled === true }}
      disabled={action.disabled}
      hitSlop={4}
      onPress={action.onPress}
      style={({ pressed }) => ({
        width: BUTTON,
        height: BUTTON,
        borderRadius: radius.md,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: action.active === true ? colors.wash : "transparent",
        opacity: action.disabled === true ? 0.4 : pressed ? 0.55 : 1,
      })}
    >
      <Icon size={19} color={color} strokeWidth={1.9} />
    </Pressable>
  );
}

function MoreMenu({ actions }: { readonly actions: ReadonlyArray<HeaderAction> }) {
  const { colors } = useEvidenceTheme();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  return (
    <>
      <IconAction
        action={{
          key: "more",
          label: "More actions",
          icon: Ellipsis,
          onPress: () => setOpen(true),
        }}
      />
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={{ flex: 1 }} onPress={() => setOpen(false)}>
          <View
            style={{
              position: "absolute",
              top: insets.top + 52,
              right: 12,
              minWidth: 220,
              paddingVertical: 6,
              borderRadius: radius.lg,
              backgroundColor: colors.panel,
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: colors.rule,
              boxShadow: "0 14px 34px -16px rgba(27, 27, 29, 0.28)",
            }}
          >
            {actions.map((action) => {
              const Icon = action.icon;
              return (
                <Pressable
                  key={action.key}
                  accessibilityRole="menuitem"
                  disabled={action.disabled}
                  onPress={() => {
                    setOpen(false);
                    action.onPress();
                  }}
                  style={({ pressed }) => ({
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 12,
                    paddingHorizontal: 14,
                    paddingVertical: 11,
                    backgroundColor: pressed ? colors.sunken : "transparent",
                    opacity: action.disabled === true ? 0.4 : 1,
                  })}
                >
                  <Icon
                    size={17}
                    color={action.tone === "danger" ? colors.red : colors.ink2}
                    strokeWidth={1.9}
                  />
                  <UiText size={14} tone={action.tone === "danger" ? "danger" : "ink"}>
                    {action.label}
                  </UiText>
                </Pressable>
              );
            })}
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

export function SessionHeader({
  title,
  subtitle,
  actions,
  pinned = [],
  direct,
  topInset,
}: {
  readonly title: string;
  /** One line under the title: status, harness, worktree. */
  readonly subtitle: ReactNode;
  /** In order of importance; the first `direct` show as buttons. */
  readonly actions: ReadonlyArray<HeaderAction>;
  /** Always shown, after the others. */
  readonly pinned?: ReadonlyArray<HeaderAction>;
  readonly direct: number;
  readonly topInset: number;
}) {
  const { colors } = useEvidenceTheme();
  const { shown, rest } = splitHeaderActions(actions, direct);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 2,
        minHeight: 52,
        paddingTop: topInset + 4,
        paddingBottom: 4,
        paddingLeft: 16,
        paddingRight: 6,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: colors.softRule,
      }}
    >
      <View style={{ flex: 1, minWidth: 0, gap: 1, paddingRight: 6 }}>
        <UiText weight="semibold" size={15.5} numberOfLines={1}>
          {title}
        </UiText>
        {subtitle}
      </View>
      {shown.map((action) => (
        <IconAction key={action.key} action={action} />
      ))}
      {rest.length === 0 ? null : <MoreMenu actions={rest} />}
      {pinned.map((action) => (
        <IconAction key={action.key} action={action} />
      ))}
    </View>
  );
}
