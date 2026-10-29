import { fitPageHeight, pageLinkResult, usePageLoadDeadline } from "@mend/ui/page-frame";
import type { PageTheme } from "@mend/ui/page-theme";
import { useEffect, useRef, useState } from "react";
import { Linking, Platform } from "react-native";
import { WebView } from "react-native-webview";

import {
  pageHostDocument,
  pageHostPostCall,
  pageHostSecret,
  pageHostThemeCall,
  pageNavigationAllowed,
  readPageHostRequest,
} from "@/data/page-host";

// react-native-webview types its class with extra props defaulting to `undefined`, so its props are
// `WebViewProps & undefined`, never, and a ref on it cannot typecheck.
const HostView = WebView<Record<never, never>>;

export interface PageDocumentProps {
  readonly title: string;
  readonly src: string;
  readonly theme: PageTheme;
  readonly initialHeight: number;
  readonly fill: boolean;
  readonly onLoadError: () => void;
}

export function PageDocument({
  title,
  src,
  theme,
  initialHeight,
  fill,
  onLoadError,
}: PageDocumentProps) {
  const view = useRef<InstanceType<typeof HostView>>(null);
  const [secret] = useState(pageHostSecret);
  const [height, setHeight] = useState(initialHeight);
  // Written once: a new host document would load the page again.
  const [html] = useState(() =>
    pageHostDocument({ src, title, theme, height: initialHeight, secret }),
  );
  // A theme injected before the host's script ran is lost; the host gets the latest once it loads.
  const shownTheme = useRef(theme);
  const loaded = usePageLoadDeadline(onLoadError);

  useEffect(() => {
    shownTheme.current = theme;
    view.current?.injectJavaScript(pageHostThemeCall(theme));
  }, [theme]);

  return (
    <HostView
      ref={view}
      source={{ html }}
      accessibilityLabel={title}
      style={[
        fill ? { flex: 1 } : { height, flex: 0 },
        { backgroundColor: theme.variables["--background"] },
      ]}
      containerStyle={fill ? { flex: 1 } : { height, flex: 0 }}
      // Every navigation the platform reports reaches onShouldStartLoadWithRequest: one outside the
      // default allow-list would otherwise go straight to Linking.openURL.
      originWhitelist={["*"]}
      onShouldStartLoadWithRequest={(request) => pageNavigationAllowed(request, src)}
      onOpenWindow={() => undefined}
      setSupportMultipleWindows={false}
      javaScriptCanOpenWindowsAutomatically={false}
      allowFileAccess={false}
      allowFileAccessFromFileURLs={false}
      allowUniversalAccessFromFileURLs={false}
      // Android's incognito clears every cookie in the app's process, the terminal's too; iOS's
      // gives this WebView a store of its own.
      incognito={Platform.OS === "ios"}
      cacheEnabled={false}
      thirdPartyCookiesEnabled={false}
      sharedCookiesEnabled={false}
      geolocationEnabled={false}
      mediaCapturePermissionGrantType="deny"
      allowsLinkPreview={false}
      dataDetectorTypes="none"
      allowsBackForwardNavigationGestures={false}
      setBuiltInZoomControls={false}
      textZoom={100}
      scrollEnabled={fill}
      bounces={fill}
      overScrollMode="never"
      showsHorizontalScrollIndicator={false}
      showsVerticalScrollIndicator={fill}
      automaticallyAdjustContentInsets={false}
      contentInsetAdjustmentBehavior="never"
      webviewDebuggingEnabled={__DEV__}
      onMessage={(event) => {
        const request = readPageHostRequest(event.nativeEvent.data, secret);
        if (request === undefined) return;
        if (request.kind === "size") {
          loaded();
          setHeight(fitPageHeight(request.height));
          return;
        }
        void Linking.openURL(request.url).then(
          () => view.current?.injectJavaScript(pageHostPostCall(pageLinkResult(request.id))),
          () => undefined,
        );
      }}
      onLoadEnd={() => view.current?.injectJavaScript(pageHostThemeCall(shownTheme.current))}
      onContentProcessDidTerminate={onLoadError}
      onRenderProcessGone={onLoadError}
    />
  );
}
