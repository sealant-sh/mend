import type { PageRef } from "@mend/domain/workbench";
import { fitPageHeight, pageFrameSrc } from "@mend/ui/page-frame";
import { pageThemes } from "@mend/ui/page-theme";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { StyleSheet, View } from "react-native";

import { EvButton } from "@/components/button";
import { PageDocument } from "@/components/page-document";
import { MonoText, UiText } from "@/components/typography";
import { ApiError, api, useConfig } from "@/data/live";
import {
  PAGE_OFFLINE_RETRY_MS,
  pageFrameKey,
  pageFrameQuery,
  resolvePageUrl,
  type PageConnection,
} from "@/data/pages";
import { Unreachable, useUnreachable } from "@/data/reachability";
import { radius, useEvidenceScheme, useEvidenceTheme } from "@/theme/evidence";

const mintFrame = async (
  connection: PageConnection,
  pageId: string,
  appearance: string,
): Promise<string> => {
  const frame = await api<{ readonly url?: unknown }>(
    "GET",
    `/pages/${encodeURIComponent(pageId)}/frame?appearance=${appearance}`,
  );
  const url = typeof frame.url === "string" ? resolvePageUrl(connection.url, frame.url) : null;
  if (url === null) throw new ApiError("The server sent a page address the phone cannot open.", 0);
  return url;
};

const NO_CONNECTION: PageConnection = { url: "", token: "" };

export function PageFrame({
  page,
  fill = false,
}: {
  readonly page: PageRef;
  readonly fill?: boolean;
}) {
  const connection = useConfig() ?? NO_CONNECTION;
  return (
    <PageLifecycle
      key={pageFrameKey(connection, page.id).join("\n")}
      page={page}
      connection={connection}
      fill={fill}
    />
  );
}

function PageLifecycle({
  page,
  connection,
  fill,
}: {
  readonly page: PageRef;
  readonly connection: PageConnection;
  readonly fill: boolean;
}) {
  const queryClient = useQueryClient();
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const retry = () => {
    void queryClient.invalidateQueries({ queryKey: pageFrameKey(connection, page.id) });
    setFailed(false);
    setAttempt((current) => current + 1);
  };
  if (failed) return <PageNotice kind="failed" fill={fill} onRetry={retry} />;
  return (
    <PageLoader
      key={attempt}
      page={page}
      connection={connection}
      fill={fill}
      onRetry={retry}
      onLoadError={() => (attempt === 0 ? retry() : setFailed(true))}
    />
  );
}

function PageLoader({
  page,
  connection,
  fill,
  onRetry,
  onLoadError,
}: {
  readonly page: PageRef;
  readonly connection: PageConnection;
  readonly fill: boolean;
  readonly onRetry: () => void;
  readonly onLoadError: () => void;
}) {
  const theme = pageThemes[useEvidenceScheme()];
  const [appearance] = useState(theme.appearance);
  const [src, setSrc] = useState<string | null>(null);
  const unreachable = useUnreachable();
  const frame = useQuery({
    ...pageFrameQuery(connection, page.id, () => mintFrame(connection, page.id, appearance)),
    enabled: connection.url !== "",
    retry: false,
    // Mint even when the OS reports no network, so the answer decides what the reader sees.
    networkMode: "always",
    refetchOnWindowFocus: false,
    refetchInterval: (query) =>
      src === null && (unreachable || query.state.error instanceof Unreachable)
        ? PAGE_OFFLINE_RETRY_MS
        : false,
  });
  if (src === null && frame.data !== undefined && !frame.isStale && !unreachable) {
    setSrc(pageFrameSrc(frame.data, theme));
  }
  if (src === null) {
    if (unreachable || frame.error instanceof Unreachable) {
      return <PageNotice kind="offline" fill={fill} />;
    }
    if (frame.isError) return <PageNotice kind="failed" fill={fill} onRetry={onRetry} />;
    return <PageNotice kind="loading" fill={fill} height={fitPageHeight(page.height)} />;
  }
  return (
    <PageDocument
      title={page.title}
      src={src}
      theme={theme}
      initialHeight={fitPageHeight(page.height)}
      fill={fill}
      onLoadError={onLoadError}
    />
  );
}

function PageNotice({
  kind,
  fill,
  height,
  onRetry,
}: {
  readonly kind: "loading" | "offline" | "failed";
  readonly fill: boolean;
  readonly height?: number;
  readonly onRetry?: () => void;
}) {
  const { colors } = useEvidenceTheme();
  if (kind === "loading") {
    return (
      <View
        accessibilityRole="progressbar"
        style={fill ? { flex: 1, paddingVertical: 16 } : { height, paddingVertical: 4 }}
      >
        <MonoText tone="faint" size={11}>
          loading page…
        </MonoText>
      </View>
    );
  }
  const notice = (
    <View
      accessibilityRole="summary"
      accessibilityLiveRegion="polite"
      style={{
        alignItems: "flex-start",
        gap: 8,
        paddingHorizontal: 14,
        paddingVertical: 12,
        borderRadius: radius.lg,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colors.softRule,
        borderLeftWidth: kind === "failed" ? 2 : StyleSheet.hairlineWidth,
        borderLeftColor: kind === "failed" ? colors.red : colors.softRule,
        backgroundColor: colors.sunken,
      }}
    >
      <UiText tone="ink2" size={13}>
        {kind === "offline"
          ? "Shown when the phone is back online"
          : "This page could not be loaded."}
      </UiText>
      {kind === "failed" && onRetry !== undefined ? (
        <EvButton size="sm" variant="outline" label="Try again" onPress={onRetry} />
      ) : null}
    </View>
  );
  return fill ? <View style={{ flex: 1, paddingVertical: 16 }}>{notice}</View> : notice;
}
