// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GhosttyTerminal } from "@/components/ghostty-terminal";
import { saveConfig } from "@/data/live";
import { onlyWebView, resetWebViews, webViews } from "@/test/fake-webview";

vi.mock("react-native-webview", () => import("@/test/fake-webview"));
vi.mock("@react-native-async-storage/async-storage", async () => ({
  default: (await import("@/test/memory-storage")).storage,
}));
vi.mock("expo-secure-store", async () => (await import("@/test/memory-storage")).secureStore);
vi.mock("expo-notifications", () => ({}));
vi.mock("expo", () => ({
  requireNativeView: () => {
    throw new Error("no native terminal in this binary");
  },
}));

const SERVER = "https://a.example";
let tickets = 0;
const serve = async (input: RequestInfo | URL): Promise<Response> => {
  if (new URL(String(input)).pathname === "/api/upgrade-tickets") {
    tickets += 1;
    return new Response(JSON.stringify({ ticket: `ticket-${tickets}` }), { status: 200 });
  }
  return new Response(JSON.stringify({ _tag: "NotFound" }), { status: 404 });
};

let root: Root;
let host: HTMLDivElement;

beforeEach(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn(serve));
  tickets = 0;
  resetWebViews();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(() => saveConfig({ url: SERVER, token: "token-a", deviceName: null, pairedAt: null }));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the WebView terminal", () => {
  it("comes back in a new WebView with a fresh ticket when Android takes its renderer down", async () => {
    act(() =>
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <GhosttyTerminal serverUrl={SERVER} token="token-a" sessionId="session-1" />
        </QueryClientProvider>,
      ),
    );
    await act(() => vi.advanceTimersByTimeAsync(10));
    const first = onlyWebView();
    expect(first.props.source?.uri).toContain("ticket=ticket-1");

    act(() => first.props.onRenderProcessGone?.());
    await act(() => vi.advanceTimersByTimeAsync(10));
    const second = onlyWebView();
    expect(second).not.toBe(first);
    expect(second.props.source?.uri).toContain("ticket=ticket-2");
    expect(webViews.created).toBe(2);
  });
});
