// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { LandingReportDto } from "#/lib/api";
import { TRPCProvider, makeTrpcClient } from "#/lib/trpc";

import { type LandDraft, useLanding } from "./land-panel";

const trpcClient = makeTrpcClient();

/** The landing as a panel shows it: pending or not, and its Land button. */
function Panel({ send }: { readonly send: (draft: LandDraft) => Promise<LandingReportDto> }) {
  const landing = useLanding("change-1", "session-1", send);
  return (
    <button
      type="button"
      disabled={landing.pending}
      onClick={() => landing.land({ title: "Tabs", body: "" }, () => undefined)}
    >
      {landing.pending ? "Landing…" : "Land"}
    </button>
  );
}

let host: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

const render = async (send: (draft: LandDraft) => Promise<LandingReportDto>) =>
  act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
          <Panel send={send} />
        </TRPCProvider>
      </QueryClientProvider>,
    ),
  );

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  queryClient = new QueryClient();
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("landing from a dialog that closes", () => {
  it("keeps one landing pending across close and reopen, and starts no second", async () => {
    const sent: Array<LandDraft> = [];
    const send = (draft: LandDraft) => {
      sent.push(draft);
      // The push takes its time: it is still out when the dialog closes and opens again.
      return new Promise<LandingReportDto>(() => undefined);
    };
    await render(send);
    await act(async () => host.querySelector("button")?.click());
    expect(host.textContent).toBe("Landing…");
    // Closing the dialog unmounts the panel.
    await act(async () => root.unmount());
    root = createRoot(host);
    // Reopening it mounts a new one: the same landing is still pending there.
    await render(send);
    expect(host.textContent).toBe("Landing…");
    expect(host.querySelector("button")?.disabled).toBe(true);
    await act(async () => host.querySelector("button")?.click());
    expect(sent).toEqual([{ title: "Tabs", body: "" }]);
  });
});
