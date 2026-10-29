import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { PageFrame } from "@/components/page-frame";
import { MonoText, UiText } from "@/components/typography";
import { usePage } from "@/data/live";
import { pageRouteOf } from "@/data/pages";
import { useEvidenceTheme } from "@/theme/evidence";

export default function PageScreen() {
  const route = pageRouteOf(useLocalSearchParams<{ id: string; session?: string }>());
  const found = usePage(route);
  const page = found.data ?? null;
  const router = useRouter();
  const { colors } = useEvidenceTheme();
  const insets = useSafeAreaInsets();
  const close = router.canGoBack()
    ? undefined
    : () =>
        route === null
          ? router.replace("/")
          : router.replace({ pathname: "/session/[id]", params: { id: route.sessionId } });
  const notice =
    route === null
      ? "this page link is missing its details · open the page from its session"
      : found.isPending
        ? "loading page…"
        : found.isError
          ? found.error.message
          : "this page is not in its session on this machine · open the page from its session";
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
            {notice}
          </MonoText>
        ) : (
          <PageFrame page={page} fill />
        )}
      </View>
    </>
  );
}
