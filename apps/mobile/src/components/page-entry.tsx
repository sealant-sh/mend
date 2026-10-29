import type { PageRef } from "@mend/domain/workbench";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { Maximize2 } from "lucide-react-native";
import { Pressable, View } from "react-native";

import { PageFrame } from "@/components/page-frame";
import { UiText } from "@/components/typography";
import { pageKey, pageRouteParams } from "@/data/pages";
import { useEvidenceTheme } from "@/theme/evidence";

export function PageEntry({ page }: { readonly page: PageRef }) {
  const { colors } = useEvidenceTheme();
  const router = useRouter();
  const queryClient = useQueryClient();
  const open = () => {
    queryClient.setQueryData(pageKey(page.sessionId, page.id), page);
    router.push({ pathname: "/page/[id]", params: pageRouteParams(page) });
  };
  return (
    <View style={{ gap: 8, paddingHorizontal: 2 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open ${page.title}`}
        accessibilityHint="Shows the page full screen"
        hitSlop={8}
        onPress={open}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          opacity: pressed ? 0.6 : 1,
        })}
      >
        <UiText weight="medium" size={13.5} style={{ flex: 1 }} numberOfLines={2}>
          {page.title}
        </UiText>
        <UiText tone="accent" weight="medium" size={12.5}>
          Open
        </UiText>
        <Maximize2 size={14} color={colors.accent} strokeWidth={2} />
      </Pressable>
      <PageFrame page={page} />
    </View>
  );
}
