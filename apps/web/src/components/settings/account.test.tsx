// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient, httpLink } from "@trpc/client";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import superjson, { serialize } from "superjson";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TRPCProvider } from "#/lib/trpc";
import type { AppRouter } from "#/server/routers/index";

import { LoginDialog } from "./account-login-dialog.tsx";
import { repositoryChanges } from "./workspace.tsx";

let root: Root;
let answers: Array<"refuse" | "accept">;
let sent: Array<string>;
let closed: number;

const settle = async () => {
  for (let tick = 0; tick < 6; tick += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const render = async () => {
  const queryClient = new QueryClient();
  const client = createTRPCClient<AppRouter>({
    links: [
      httpLink({
        url: "http://mend.test/trpc",
        transformer: superjson,
        fetch: async (url, init) => {
          if (!new URL(url.toString()).pathname.endsWith("platform.connectAccount")) {
            return Response.json({ result: { data: serialize({ accounts: [] }) } });
          }
          sent.push(String(init?.body));
          if (answers.shift() === "refuse") {
            return Response.json(
              {
                error: serialize({
                  message: "GitHub refused the token",
                  code: -32603,
                  data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
                }),
              },
              { status: 500 },
            );
          }
          return Response.json({ result: { data: serialize({ id: "a1" }) } });
        },
      }),
    ],
  });
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <TRPCProvider trpcClient={client} queryClient={queryClient}>
          <LoginDialog
            target={{ provider: "github", replacing: null }}
            onClose={() => {
              closed += 1;
            }}
          />
        </TRPCProvider>
      </QueryClientProvider>,
    ),
  );
  await settle();
};

const field = () => {
  const input = document.querySelector<HTMLInputElement>('input[type="password"]');
  if (input === null) throw new Error("no login field");
  return input;
};

const type = (input: HTMLInputElement, value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

const save = () => {
  const found = Array.from(document.querySelectorAll("button")).find(
    (button) => button.textContent === "Save login",
  );
  if (found === undefined) throw new Error("no Save login");
  return found;
};

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  answers = [];
  sent = [];
  closed = 0;
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
});

describe("the agent login dialog", () => {
  it("names the dialog for the login and keeps Save off until something is pasted", async () => {
    await render();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "Connect your GitHub login",
    );
    expect(save().disabled).toBe(true);
    await type(field(), "gho_secret");
    expect(save().disabled).toBe(false);
  });

  it("announces a refusal and keeps the dialog open, then closes it once Sealant accepts", async () => {
    answers = ["refuse", "accept"];
    await render();
    await type(field(), "gho_secret");
    await act(async () => save().click());
    await settle();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "GitHub refused the token",
    );
    expect(closed).toBe(0);
    expect(sent).toHaveLength(1);

    await act(async () => save().click());
    await settle();
    expect(sent).toHaveLength(2);
    expect(closed).toBe(1);
    expect(field().value).toBe("");
  });
});

describe("the dotfiles save bar", () => {
  const saved = {
    url: "https://github.com/me/dots.git",
    ref: null,
    subdirectory: null,
    manager: "auto" as const,
    bootstrap: true,
  };
  const draft = {
    url: "https://github.com/me/dots.git",
    ref: "",
    subdirectory: "",
    manager: "auto" as const,
    bootstrap: true,
  };

  it("counts nothing when the draft would save what is saved", () => {
    expect(repositoryChanges(saved, { ...draft, url: ` ${draft.url} ` })).toBe(0);
  });

  it("counts each field a save would change", () => {
    expect(repositoryChanges(saved, { ...draft, ref: "main", manager: "stow" })).toBe(2);
    expect(repositoryChanges(null, draft)).toBe(1);
  });
});
