// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Pressable, Text } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearConfig, saveConfig } from "@/data/pairing-config";
import { PairingBoundary } from "@/data/pairing-scope";
import { usePreviewOpen } from "@/data/preview-queries";
import type { PreviewToOpen } from "@/data/previews";

const browser = vi.hoisted(() => ({
  answer: (): Promise<{ readonly type: string }> => new Promise(() => undefined),
  opened: [] as Array<string>,
}));
vi.mock("expo-web-browser", () => ({
  openBrowserAsync: (url: string) => {
    browser.opened.push(url);
    return browser.answer();
  },
}));
vi.mock("@react-native-async-storage/async-storage", async () => ({
  default: (await import("@/test/memory-storage")).storage,
}));
vi.mock("expo-secure-store", async () => (await import("@/test/memory-storage")).secureStore);
vi.mock("expo-notifications", () => ({}));

const MACHINE = { url: "https://box.example", token: "token-a", deviceName: null, pairedAt: null };
const URL_TO_OPEN = "https://web.preview.test/__mend/auth?ticket=t&path=%2F";
const WEB: PreviewToOpen = {
  id: "preview-web",
  serviceName: "web",
  open: "/preview-auth?preview=preview-web&path=%2F",
};

const server = { refuse: false, mints: 0 };
const serve = async (input: RequestInfo | URL): Promise<Response> => {
  const url = new URL(String(input));
  if (url.pathname !== "/api/previews/preview-web/open") {
    return new Response(JSON.stringify({ _tag: "NotFound" }), { status: 404 });
  }
  server.mints += 1;
  return server.refuse
    ? new Response(
        JSON.stringify({
          _tag: "PreviewNotOpenable",
          reason: "not-served",
          message: "web · the gateway serves nothing for it · nothing to open",
        }),
        { status: 409 },
      )
    : new Response(JSON.stringify({ url: URL_TO_OPEN }), { status: 200 });
};

function Probe({ preview }: { readonly preview: PreviewToOpen | null }) {
  const opening = usePreviewOpen(preview);
  return (
    <>
      <Pressable accessibilityRole="button" disabled={opening.pending} onPress={opening.open}>
        <Text>{opening.pending ? "Opening" : "Preview"}</Text>
      </Pressable>
      <Text>{opening.failure ?? "no failure"}</Text>
    </>
  );
}

let root: Root;
let host: HTMLDivElement;
const show = (preview: PreviewToOpen | null) =>
  act(() =>
    root.render(
      <PairingBoundary>
        <Probe preview={preview} />
      </PairingBoundary>,
    ),
  );
const settle = () => act(() => vi.advanceTimersByTimeAsync(10));
const text = () => host.textContent ?? "";
const press = async () => {
  const target = [...host.querySelectorAll<HTMLElement>("*")].find(
    (element) => element.children.length === 0 && element.textContent === "Preview",
  );
  if (target === undefined) throw new Error("no Preview button on screen");
  act(() => target.click());
  await settle();
};

beforeEach(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  Reflect.set(globalThis, "__DEV__", false);
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn(serve));
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  Object.assign(server, { refuse: false, mints: 0 });
  browser.opened = [];
  browser.answer = () => new Promise(() => undefined);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(() => saveConfig(MACHINE));
});

afterEach(async () => {
  await act(() => clearConfig());
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("the session's Preview", () => {
  it("opens the minted URL in the in-app browser, and is ready again while the browser is up", async () => {
    show(WEB);
    await settle();
    await press();
    expect(browser.opened).toEqual([URL_TO_OPEN]);
    expect(text()).toBe("Previewno failure");
  });

  it("says when the in-app browser rejects the URL", async () => {
    browser.answer = () => Promise.reject(new Error("No matching browser activity found"));
    show(WEB);
    await settle();
    await press();
    expect(text()).toContain(
      "preview · the in-app browser did not open · No matching browser activity found",
    );
  });

  it("says when another in-app browser holds the screen", async () => {
    browser.answer = () => Promise.resolve({ type: "locked" });
    show(WEB);
    await settle();
    await press();
    expect(text()).toContain(
      "preview · the in-app browser did not open · another in-app browser is already open",
    );
  });

  it("shows the server's refusal, and opens nothing", async () => {
    server.refuse = true;
    show(WEB);
    await settle();
    await press();
    expect(browser.opened).toEqual([]);
    expect(text()).toContain("preview · web · the gateway serves nothing for it · nothing to open");
  });

  it("drops a refusal once the preview it described has moved on, and keeps it dropped", async () => {
    server.refuse = true;
    show(WEB);
    await settle();
    await press();
    expect(text()).toContain("nothing to open");
    show(null);
    await settle();
    show(WEB);
    await settle();
    expect(text()).toBe("Previewno failure");
  });
});
