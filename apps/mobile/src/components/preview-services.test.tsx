// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PreviewServices } from "@/components/preview-services";
import type { WorktreePreviewsDto } from "@/data/previews";

vi.mock("@react-native-async-storage/async-storage", async () => ({
  default: (await import("@/test/memory-storage")).storage,
}));

const many = (count: number): WorktreePreviewsDto => ({
  previews: Array.from({ length: count }, (_, index) => ({
    preview: { id: `preview-${index}`, serviceName: `web-${index}` },
    status: [`preview · web-${index} · starting · setup`],
    facts: [{ _tag: "Starting", service: `web-${index}`, phase: "setup" }],
  })),
  unprepared: null,
});

let root: Root;
let host: HTMLDivElement;
const show = (read: WorktreePreviewsDto | undefined) =>
  act(() => root.render(<PreviewServices read={read} />));

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe("the session's Services strip", () => {
  it("runs no clock while it has nothing to show", () => {
    show(undefined);
    show({
      previews: [{ preview: { id: "p", serviceName: "web" }, status: [] }],
      unprepared: null,
    });
    expect(host.textContent).toBe("");
    expect(vi.getTimerCount()).toBe(0);
    show(many(1));
    expect(host.textContent).toContain("preview · web-0 · starting · setup");
    expect(vi.getTimerCount()).toBe(1);
  });

  it("keeps every preview's lines inside a bounded area", () => {
    show(many(12));
    const strip = host.querySelector<HTMLElement>('[data-testid="preview-services"]');
    const lines = [...(strip?.querySelectorAll<HTMLElement>("*") ?? [])].filter(
      (element) => element.textContent === "preview · web-11 · starting · setup",
    );
    const bounded = lines[0]?.closest<HTMLElement>('[style*="max-height"]');
    expect(bounded?.style.maxHeight).toBe("120px");
  });
});
