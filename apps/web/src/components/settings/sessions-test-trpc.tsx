import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient, httpLink } from "@trpc/client";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import superjson, { parse, serialize } from "superjson";

import { TRPCProvider } from "#/lib/trpc";
import type { AppRouter } from "#/server/routers/index";

/** What a fake procedure answers: data, or a refusal with its message. */
export type Answer = { readonly data: unknown } | { readonly refuse: string };

/**
 * Render a settings tab against a fake tRPC server: `answer` gets each call's procedure path and
 * decoded input. Returns the root to unmount.
 */
export const renderWithTrpc = async (
  node: ReactNode,
  answer: (path: string, input: unknown) => Answer,
  queryClient: QueryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
): Promise<Root> => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const client = createTRPCClient<AppRouter>({
    links: [
      httpLink({
        url: "http://mend.test/trpc",
        transformer: superjson,
        methodOverride: "POST",
        fetch: async (url, init) => {
          const path = new URL(url.toString()).pathname.replace(/^\/trpc\//, "");
          const body = init?.body;
          const reply = answer(path, typeof body === "string" && body !== "" ? parse(body) : null);
          return "refuse" in reply
            ? Response.json(
                {
                  error: serialize({
                    message: reply.refuse,
                    code: -32603,
                    data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
                  }),
                },
                { status: 500 },
              )
            : Response.json({ result: { data: serialize(reply.data) } });
        },
      }),
    ],
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <TRPCProvider trpcClient={client} queryClient={queryClient}>
          {node}
        </TRPCProvider>
      </QueryClientProvider>,
    ),
  );
  await settle();
  return root;
};

/** Everything both caches still hold, as text: what a credential must not appear in. */
export const cachedText = (queryClient: QueryClient): string =>
  JSON.stringify([
    queryClient
      .getMutationCache()
      .getAll()
      .map((mutation) => mutation.state),
    queryClient
      .getQueryCache()
      .getAll()
      .map((query) => [query.queryKey, query.state.data]),
  ]);

export const settle = async () => {
  for (let tick = 0; tick < 8; tick += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

export const byText = (selector: string, text: string | RegExp): HTMLElement => {
  const found = [...document.querySelectorAll<HTMLElement>(selector)].find((element) => {
    const label = element.getAttribute("aria-label") ?? element.textContent ?? "";
    return typeof text === "string" ? label.trim() === text : text.test(label);
  });
  if (found === undefined) throw new Error(`no ${selector} named ${String(text)}`);
  return found;
};

export const click = async (element: HTMLElement) => {
  await act(async () => element.click());
  await settle();
};
