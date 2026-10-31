// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient, httpLink } from "@trpc/client";
import { act, Suspense } from "react";
import { createRoot, type Root } from "react-dom/client";
import superjson, { parse, serialize } from "superjson";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TRPCProvider } from "#/lib/trpc";
import type { AppRouter } from "#/server/routers/index";

import { DopplerPanel } from "./doppler-panel.tsx";

interface Mapping {
  readonly projectId: string;
  readonly projectName: string;
  readonly dopplerProject: string;
  readonly config: string;
}
let root: Root;
let connected: boolean;
let mappings: ReadonlyArray<Mapping>;
let requests: Array<{ readonly operation: string; readonly input: unknown }>;
let unavailable: boolean;

const settle = async () => {
  for (let tick = 0; tick < 6; tick += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};
const button = (label: string) => {
  const found = Array.from(document.querySelectorAll("button")).find(
    (element) => element.textContent === label,
  );
  if (found === undefined) throw new Error(`No ${label} button`);
  return found;
};
const enter = async (selector: string, value: string) => {
  const input = document.querySelector<HTMLInputElement>(selector);
  if (input === null) throw new Error(`No input ${selector}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
};
const render = async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const client = createTRPCClient<AppRouter>({
    links: [
      httpLink({
        url: "http://mend.test/trpc",
        transformer: superjson,
        fetch: async (url, init) => {
          const operation = new URL(url.toString()).pathname.split("/").at(-1) ?? "";
          const input = init?.body === undefined ? undefined : parse<unknown>(String(init.body));
          requests.push({ operation, input });
          let output: unknown;
          switch (operation) {
            case "doppler.connect":
              connected = true;
              output = {};
              break;
            case "doppler.disconnect":
              connected = false;
              mappings = [];
              output = {};
              break;
            case "doppler.use": {
              const saved = parse<{ projectId: string; dopplerProject: string; config: string }>(
                String(init?.body),
              );
              mappings = [{ ...saved, projectName: "Mend" }];
              output = mappings[0];
              break;
            }
            case "doppler.removeMapping":
              mappings = [];
              output = {};
              break;
            case "projects.list":
              output = [{ id: "p1", name: "Mend" }];
              break;
            case "doppler.projects":
              if (unavailable) throw new Error("Doppler unavailable");
              output = { projects: [{ id: "mend-app", name: "Mend app" }] };
              break;
            case "doppler.configs":
              if (unavailable) throw new Error("Doppler unavailable");
              output = { configs: [{ name: "dev" }, { name: "stg" }] };
              break;
            default:
              output = {
                connected,
                name: connected ? "Yiannis" : null,
                updatedAt: connected ? new Date("2026-10-31T00:00:00Z") : null,
                mappings,
              };
          }
          return Response.json({ result: { data: serialize(output) } });
        },
      }),
    ],
  });
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <TRPCProvider trpcClient={client} queryClient={queryClient}>
          <Suspense fallback={null}>
            <DopplerPanel />
          </Suspense>
        </TRPCProvider>
      </QueryClientProvider>,
    ),
  );
  await settle();
};

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  connected = false;
  mappings = [];
  requests = [];
  unavailable = false;
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
});

describe("Doppler settings", () => {
  it("connects with a write-only token and clears the password input", async () => {
    await render();
    expect(document.body.textContent).toContain("Not connected");
    await enter('input[type="password"]', "dp.fake.test-token");
    await act(async () => button("Connect").click());
    await settle();
    expect(requests.find((request) => request.operation === "doppler.connect")?.input).toEqual({
      token: "dp.fake.test-token",
    });
    expect(document.body.textContent).toContain("Connected · Yiannis · set 2026-10-31");
    expect(document.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe("");
    expect(document.body.textContent).not.toContain("dp.fake.test-token");
  });

  it("lists Doppler projects and configs, saves a mapping, and disconnects", async () => {
    connected = true;
    await render();
    expect(document.querySelector('option[value="mend-app"]')).not.toBeNull();
    await enter('input[list$="-projects"]', "mend-app");
    expect(document.querySelector('option[value="dev"]')).not.toBeNull();
    await enter('input[list$="-configs"]', "dev");
    await act(async () => button("Save").click());
    await settle();
    expect(requests.find((request) => request.operation === "doppler.use")?.input).toEqual({
      projectId: "p1",
      dopplerProject: "mend-app",
      config: "dev",
    });
    expect(button("Remove")).toBeDefined();
    await act(async () => button("Disconnect").click());
    await settle();
    expect(document.body.textContent).toContain("Not connected");
    expect(document.querySelector('input[list$="-projects"]')).toBeNull();
  });

  it("still shows saved mappings and allows manual names when Doppler is unavailable", async () => {
    connected = true;
    unavailable = true;
    mappings = [
      { projectId: "p1", projectName: "Mend", dopplerProject: "mend-app", config: "dev" },
    ];
    await render();
    expect(document.body.textContent).toContain("project list could not be loaded");
    expect(document.querySelector<HTMLInputElement>('input[list$="-projects"]')?.value).toBe(
      "mend-app",
    );
    await enter('input[list$="-configs"]', "stg");
    await act(async () => button("Save").click());
    await settle();
    expect(mappings[0]?.config).toBe("stg");
  });
});
