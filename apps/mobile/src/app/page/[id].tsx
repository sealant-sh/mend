import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { PageFrame } from "@/components/page-frame";
import { MonoText, UiText } from "@/components/typography";
import { pageOfRoute } from "@/data/pages";
import { useEvidenceTheme } from "@/theme/evidence";

export default function PageScreen() {
  const params = useLocalSearchParams<{
    id: string;
    session?: string;
    title?: string;
    height?: string;
    published?: string;
  }>();
  const page = pageOfRoute(params);
  const router = useRouter();
  const { colors } = useEvidenceTheme();
  const insets = useSafeAreaInsets();
  const close = router.canGoBack()
    ? undefined
    : () =>
        page === null
          ? router.replace("/")
          : router.replace({ pathname: "/session/[id]", params: { id: page.sessionId } });
  return (
    <>
      <Stack.Screen
        options={{
          title: page?.title ?? "Page",
          ...(close === undefined
            ? {}
            : {
                headerLeft: () => (
                  <Pressable accessibilityRole="button" onPress={close} hitSlop={8}>
                    <UiText tone="accent" weight="medium">
                      Close
                    </UiText>
                  </Pressable>
                ),
              }),
        }}
      />
      <View
        style={{
          flex: 1,
          backgroundColor: colors.bg,
          paddingHorizontal: 16,
          paddingTop: 8,
          paddingBottom: insets.bottom,
        }}
      >
        {page === null ? (
          <MonoText tone="faint" style={{ paddingVertical: 16 }}>
            this page link is missing its details · open the page from its session
          </MonoText>
        ) : (
          <PageFrame page={page} fill />
        )}
      </View>
    </>
  );
}
