// @vitest-environment jsdom
import { pageThemes } from "@mend/ui/page-theme";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PageDocument } from "@/components/page-document";
import { PageFrame } from "@/components/page-frame";
import { api, clearConfig, saveConfig } from "@/data/live";
import { pageHostThemeCall } from "@/data/page-host";
import { pageOf } from "@/data/pages";
import { PairingBoundary } from "@/data/pairing-scope";
import { onlyWebView, resetWebViews, webViews } from "@/test/fake-webview";

vi.mock("react-native-webview", () => import("@/test/fake-webview"));
vi.mock("@react-native-async-storage/async-storage", async () => ({
  default: (await import("@/test/memory-storage")).storage,
}));
vi.mock("expo-secure-store", async () => (await import("@/test/memory-storage")).secureStore);
vi.mock("expo-notifications", () => ({}));

const page = pageOf({
  id: "page-1",
  sessionId: "session-1",
  title: "Latency by route",
  height: 420,
  publishedAt: "2026-10-29T12:05:00.000Z",
});
if (page === null) throw new Error("no page");

const MACHINE_A = { url: "https://a.example", token: "token-a", deviceName: null, pairedAt: null };
const MACHINE_B = { url: "https://b.example", token: "token-b", deviceName: null, pairedAt: null };

const network = { offline: false, silentHost: "", frameBody: "", mints: [] as string[] };
const serve = async (input: RequestInfo | URL): Promise<Response> => {
  if (network.offline) throw new TypeError("Network request failed");
  const url = new URL(String(input));
  if (url.host === network.silentHost) return new Promise(() => undefined);
  if (url.pathname === "/api/pages/page-1/frame") {
    network.mints.push(url.host);
    const body =
      network.frameBody === ""
        ? JSON.stringify({ url: `/api/page-view?view=${url.host}-${network.mints.length}` })
        : network.frameBody;
    return new Response(body, { status: 200 });
  }
  return new Response(JSON.stringify({ _tag: "NotFound" }), { status: 404 });
};

let root: Root;
let host: HTMLDivElement;
let pairingCache: QueryClient | undefined;

const CacheOfPairing = () => {
  pairingCache = useQueryClient();
  return null;
};

const settle = () => act(() => vi.advanceTimersByTimeAsync(10));
const show = (node: ReactNode) => act(() => root.render(<PairingBoundary>{node}</PairingBoundary>));
const text = () => host.textContent ?? "";
const framedUrl = () =>
  /<iframe id="page" src="([^"#]*)/.exec(onlyWebView().props.source?.html ?? "")?.[1];

beforeEach(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  Reflect.set(globalThis, "__DEV__", false);
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn(serve));
  Object.assign(network, { offline: false, silentHost: "", frameBody: "", mints: [] });
  resetWebViews();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(() => saveConfig(MACHINE_A));
});

afterEach(async () => {
  // The pairing's cache outlives an unmount: end the pairing where the boundary sees it.
  await act(() => clearConfig());
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("a page under a pairing", () => {
  it("leaves with its pairing: another machine mints its own, and unpairing shows none", async () => {
    show(<PageFrame page={page} />);
    await settle();
    expect(framedUrl()).toBe("https://a.example/api/page-view?view=a.example-1");

    await act(() => saveConfig(MACHINE_B));
    await settle();
    expect(framedUrl()).toBe("https://b.example/api/page-view?view=b.example-2");

    await act(() => clearConfig());
    await settle();
    expect(webViews.mounted).toEqual([]);
    expect(text()).toContain("loading page…");
  });

  it("starts the next pairing reachable though the last one was not", async () => {
    network.offline = true;
    show(<PageFrame page={page} />);
    await settle();
    expect(text()).toContain("Shown when the phone is back online");

    network.offline = false;
    network.silentHost = "b.example";
    await act(() => saveConfig(MACHINE_B));
    await settle();
    expect(text()).not.toContain("Shown when the phone is back online");
    expect(text()).toContain("loading page…");
  });
});

describe("a page that takes its WebView down", () => {
  it("is loaded once more with a fresh URL, then refused with Try again", async () => {
    show(<PageFrame page={page} />);
    await settle();
    for (const crash of [1, 2, 3, 4, 5]) {
      const [view] = webViews.mounted;
      act(() =>
        crash % 2 === 0
          ? view?.props.onContentProcessDidTerminate?.()
          : view?.props.onRenderProcessGone?.(),
      );
      await settle();
    }
    expect(webViews.created).toBe(2);
    expect(network.mints).toEqual(["a.example", "a.example"]);
    expect(webViews.mounted).toEqual([]);
    expect(text()).toContain("This page could not be loaded.");
    expect(text()).toContain("Try again");
  });
});

describe("offline", () => {
  it("is a mint no answer came back for, and nothing else", async () => {
    network.offline = true;
    show(<PageFrame page={page} />);
    await settle();
    expect(text()).toContain("Shown when the phone is back online");

    act(() =>
      root.render(
        <PairingBoundary>
          <CacheOfPairing />
        </PairingBoundary>,
      ),
    );
    pairingCache?.clear();
    network.offline = false;
    // A server that answers `null`: reading its URL throws a TypeError in the phone's own code.
    network.frameBody = "null";
    show(<PageFrame page={page} />);
    await settle();
    expect(text()).not.toContain("Shown when the phone is back online");
    expect(text()).toContain("This page could not be loaded.");
  });

  it("shows a page that scrolls back into view as offline at once when nothing answers", async () => {
    show(<PageFrame page={page} />);
    await settle();
    expect(webViews.mounted).toHaveLength(1);
    act(() => root.render(<PairingBoundary>{null}</PairingBoundary>));

    network.offline = true;
    await act(() => api("GET", "/sessions/session-1/transcript").catch(() => undefined));
    show(<PageFrame page={page} />);
    await settle();
    expect(webViews.mounted).toEqual([]);
    expect(text()).toContain("Shown when the phone is back online");

    network.offline = false;
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    await settle();
    expect(webViews.mounted).toHaveLength(1);
    expect(text()).not.toContain("Shown when the phone is back online");
  });
});

describe("the theme", () => {
  it("reaches a host that loads after the theme changed", () => {
    const props = {
      title: page.title,
      src: "https://a.example/api/page-view?view=t",
      initialHeight: 420,
      fill: false,
      onLoadError: () => undefined,
    };
    show(<PageDocument {...props} theme={pageThemes.light} />);
    show(<PageDocument {...props} theme={pageThemes.dark} />);
    const view = onlyWebView();
    const beforeLoad = view.injected.length;
    act(() => view.props.onLoadEnd?.());
    expect(view.injected.slice(beforeLoad)).toEqual([pageHostThemeCall(pageThemes.dark)]);
  });
});
