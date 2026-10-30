// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient, httpLink } from "@trpc/client";
import { act, Suspense } from "react";
import { createRoot, type Root } from "react-dom/client";
import superjson, { parse, serialize } from "superjson";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TRPCProvider } from "#/lib/trpc";
import type { AppRouter } from "#/server/routers/index";

import { MessageSettingsPanel } from "./message-settings.tsx";

let root: Root;
let stored: { sendSteersRunningTurn: boolean };
let saves: Array<unknown>;

const render = async () => {
  const queryClient = new QueryClient();
  const client = createTRPCClient<AppRouter>({
    links: [
      httpLink({
        url: "http://mend.test/trpc",
        transformer: superjson,
        fetch: async (url, init) => {
          if (new URL(url.toString()).pathname.endsWith("platform.setMessageSettings")) {
            const saved = parse<{ sendSteersRunningTurn: boolean }>(String(init?.body));
            saves.push(saved);
            stored = { sendSteersRunningTurn: saved.sendSteersRunningTurn };
          }
          return Response.json({ result: { data: serialize(stored) } });
        },
      }),
    ],
  });
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <TRPCProvider trpcClient={client} queryClient={queryClient}>
          <Suspense fallback={null}>
            <MessageSettingsPanel />
          </Suspense>
        </TRPCProvider>
      </QueryClientProvider>,
    ),
  );
  await settle();
};

const settle = async () => {
  for (let tick = 0; tick < 5; tick += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const choice = (label: "on" | "off") => {
  const found = Array.from(document.querySelectorAll("button")).find(
    (item) => item.textContent === label,
  );
  if (found === undefined) throw new Error(`No ${label} choice`);
  return found;
};
const lit = () =>
  Array.from(document.querySelectorAll('button[aria-pressed="true"]')).map(
    (item) => item.textContent,
  );

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  saves = [];
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
});

describe("Settings, Messages", () => {
  it("shows the saved setting under its name", async () => {
    stored = { sendSteersRunningTurn: false };
    await render();

    expect(document.body.textContent).toContain("Send steers the running turn");
    expect(lit()).toEqual(["off"]);
  });

  it("saves a change and shows what the server kept", async () => {
    stored = { sendSteersRunningTurn: true };
    await render();
    expect(lit()).toEqual(["on"]);

    await act(async () => choice("off").click());
    await settle();

    expect(saves).toEqual([{ sendSteersRunningTurn: false }]);
    expect(lit()).toEqual(["off"]);
  });
});
