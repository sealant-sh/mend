// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { clearConfig, saveConfig } from "@/data/pairing-config";
import { PairingBoundary } from "@/data/pairing-scope";
import { proofMediaSource } from "@/data/proof-media";
import type { ProofArtifactViewDto } from "@/data/review";
import { mediaRequests } from "@/test/proof-native";

import { ChangeProofArtifacts } from "./change-proof-artifacts";

let root: Root;
let host: HTMLDivElement;
let listed: ProofArtifactViewDto[];
let refused: boolean;
const reads: { path: string; headers: Headers }[] = [];
const connection = {
  url: "https://mend.test",
  token: "phone-credential",
  deviceName: null,
  pairedAt: null,
};
const item = (
  id: string,
  capture: ProofArtifactViewDto["artifact"]["capture"],
): ProofArtifactViewDto => ({
  label: `${id} · checkpoint #2 · ${capture._tag === "Recording" ? "recording · " : capture._tag === "NotCaptured" ? `not captured · ${capture.reason} · ` : ""}observed 14:02 UTC`,
  mediaPath:
    capture._tag === "Screenshot" || capture._tag === "Video"
      ? `/api/proof-artifacts/${id}/media`
      : null,
  artifact: {
    id,
    sessionId: "session-1",
    title: id,
    caption: "Completed task is visible",
    source: { _tag: "Checkpoint", ordinal: 2 },
    capture,
    launch: "pnpm dev",
    differences: "Seeded account",
  },
});
const settle = () => act(() => vi.advanceTimersByTimeAsync(20));
const click = (label: string) => {
  const button = [...document.querySelectorAll<HTMLElement>('[role="button"]')].find(
    (element) => element.getAttribute("aria-label") === label || element.textContent === label,
  );
  if (button === undefined) throw new Error(`No button: ${label}`);
  act(() => button.click());
};
const show = async () => {
  act(() =>
    root.render(
      <PairingBoundary>
        <ChangeProofArtifacts changeId="change-1" />
      </PairingBoundary>,
    ),
  );
  await settle();
  await settle();
};
beforeEach(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  Reflect.set(globalThis, "__DEV__", false);
  vi.useFakeTimers();
  listed = [];
  refused = false;
  reads.length = 0;
  mediaRequests.length = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    reads.push({ path: new URL(String(input)).pathname, headers: new Headers(init?.headers) });
    return refused
      ? Response.json({ message: "Unavailable" }, { status: 500 })
      : Response.json(listed);
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(() => saveConfig(connection));
});
afterEach(async () => {
  await act(() => clearConfig());
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("shows labels before opening and passes authenticated image and video sources to native media", async () => {
  const screenshot = item("Board", { _tag: "Screenshot", moment: { seq: 12 } });
  const video = item("Flow", { _tag: "Video", span: { fromSeq: 12, toSeq: 20 } });
  listed = [screenshot, video];
  await show();
  expect(reads[0]?.path).toBe("/api/changes/change-1/proof-artifacts");
  expect(reads[0]?.headers.get("authorization")).toBe("Bearer phone-credential");
  expect(host.textContent).toContain(screenshot.label);
  expect(host.textContent).toContain(video.label);
  expect(mediaRequests).toContainEqual({
    kind: "image",
    controls: false,
    source: proofMediaSource(connection, "/api/proof-artifacts/Board/media"),
  });
  expect(mediaRequests).toContainEqual({
    kind: "video",
    controls: false,
    source: {
      ...proofMediaSource(connection, "/api/proof-artifacts/Flow/media"),
      contentType: "progressive",
      useCaching: false,
    },
  });
  click(screenshot.label);
  await settle();
  expect(document.body.textContent).toContain("Completed task is visible");
  expect(document.body.textContent).toContain("screen log · seq 12");
  expect(document.body.textContent).toContain("pnpm dev");
  expect(document.body.textContent).toContain("Seeded account");
  expect(document.querySelector("a")?.getAttribute("href")).toBe("/session/session-1");
  click("Close");
  await settle();
  click(video.label);
  await settle();
  expect(document.querySelector("video[controls]")).not.toBeNull();
  expect(document.body.textContent).toContain("screen log · seq 12–20");
  expect(mediaRequests.some((request) => request.kind === "video" && request.controls)).toBe(true);
  for (const request of mediaRequests)
    expect(JSON.stringify(request.source)).not.toContain("?token");
});
it("polls an empty panel, then a recording every 3 seconds and settles it while open", async () => {
  await show();
  expect(host.textContent).toBe("");
  listed = [item("Flow", { _tag: "Recording", fromSeq: 12 })];
  await act(() => vi.advanceTimersByTimeAsync(15_000));
  await settle();
  const recording = listed[0];
  if (recording === undefined) throw new Error("No recording");
  expect(host.textContent).toContain(recording.label);
  click(recording.label);
  await settle();
  listed = [item("Flow", { _tag: "Video", span: { fromSeq: 12, toSeq: 20 } })];
  const before = reads.length;
  await act(() => vi.advanceTimersByTimeAsync(3_000));
  await settle();
  expect(reads.length).toBeGreaterThan(before);
  expect(document.querySelector("video[controls]")).not.toBeNull();
  expect(document.body.textContent).not.toContain("Recording…");
});
it("shows a missing capture and retries a failed list", async () => {
  refused = true;
  await show();
  await act(() => vi.advanceTimersByTimeAsync(2_000));
  await settle();
  expect(host.textContent).toContain("Try again");
  refused = false;
  listed = [item("Board", { _tag: "NotCaptured", reason: "Missing test account" })];
  click("Try again");
  await settle();
  const missing = listed[0];
  if (missing === undefined) throw new Error("No missing item");
  click(missing.label);
  await settle();
  expect(document.body.textContent).toContain("Not captured · Missing test account");
  expect(mediaRequests).toEqual([]);
});
it("never puts authentication in the media URL", () => {
  for (const path of ["/api/proof-artifacts/image/media", "/api/proof-artifacts/video/media"]) {
    const source = proofMediaSource(connection, path);
    expect(source.uri).toBe(`${connection.url}${path}`);
    expect(new URL(source.uri).search).toBe("");
    expect(source.headers).toEqual({ authorization: "Bearer phone-credential" });
  }
});
