import { Component, createElement } from "react";

export interface FakeWebViewProps {
  readonly source?: { readonly html?: string; readonly uri?: string };
  readonly onLoadEnd?: () => void;
  readonly onContentProcessDidTerminate?: () => void;
  readonly onRenderProcessGone?: () => void;
}

export const webViews = { mounted: [] as WebView[], created: 0 };

export class WebView extends Component<FakeWebViewProps> {
  readonly injected: string[] = [];

  override componentDidMount() {
    webViews.created += 1;
    webViews.mounted.push(this);
  }

  override componentWillUnmount() {
    webViews.mounted = webViews.mounted.filter((view) => view !== this);
  }

  injectJavaScript(script: string) {
    this.injected.push(script);
  }

  override render() {
    return createElement("div", { "data-webview": this.props.source?.uri ?? "html" });
  }
}

export const resetWebViews = () => {
  webViews.mounted = [];
  webViews.created = 0;
};

export const onlyWebView = (): WebView => {
  const [view, ...others] = webViews.mounted;
  if (view === undefined || others.length > 0) {
    throw new Error(`${webViews.mounted.length} WebViews mounted, not 1`);
  }
  return view;
};
