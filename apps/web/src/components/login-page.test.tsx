// @vitest-environment jsdom
import { RouterProvider } from "@tanstack/react-router";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { serialize } from "superjson";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getRouter } from "#/router";

// A person signing in at /login: the page, its router and its clients are the app's own. Only the
// network is faked, answering as the API does: tRPC's batched superjson replies, and better-auth's
// sign-in endpoint.
interface SignIn {
  readonly email: string;
  readonly password: string;
}

const server = vi.hoisted(() => {
  const state = {
    signIns: [] as Array<{ readonly email: unknown; readonly password: unknown }>,
    answer: "refuse" as "refuse" | "accept",
  };
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  // Before the app's modules load: better-auth's createAuthClient keeps the fetch it finds then.
  vi.stubGlobal("fetch", async (input: unknown, init?: { readonly body?: unknown }) => {
    const url = new URL(input instanceof Request ? input.url : String(input), "http://mend.test");
    if (url.pathname.endsWith("/api/auth/sign-in/email")) {
      const body: unknown = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
      state.signIns.push({
        email: typeof body === "object" && body !== null ? Reflect.get(body, "email") : undefined,
        password:
          typeof body === "object" && body !== null ? Reflect.get(body, "password") : undefined,
      });
      return state.answer === "refuse"
        ? Response.json(
            { code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" },
            { status: 401 },
          )
        : Response.json({
            redirect: false,
            token: "session-token",
            user: {
              id: "u1",
              email: "carol@example.test",
              name: "Carol",
              emailVerified: true,
              image: null,
              createdAt: "2026-11-15T00:00:00.000Z",
              updatedAt: "2026-11-15T00:00:00.000Z",
            },
          });
    }
    const trpc = url.pathname.match(/\/trpc\/(.+)$/);
    if (trpc?.[1] !== undefined) {
      // One reply per procedure the batch names; only the instance query is answered.
      const replies = decodeURIComponent(trpc[1])
        .split(",")
        .map((procedure) =>
          procedure === "platform.instance"
            ? { result: { data: serialize({ users: "some", registration: "open" }) } }
            : {
                error: serialize({
                  message: "not answered",
                  code: -32603,
                  data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500, path: procedure },
                }),
              },
        );
      // tRPC answers a batch with any failed procedure as 207 Multi-Status.
      return Response.json(replies, {
        status: replies.every((reply) => "result" in reply) ? 200 : 207,
      });
    }
    return Response.json({ message: "not answered" }, { status: 500 });
  });
  return state;
});

let root: Root;
let host: HTMLDivElement;

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 100)));

const open = async (href: string) => {
  window.history.replaceState(null, "", href);
  await act(async () => root.render(<RouterProvider router={getRouter()} />));
  await settle();
};

const field = (id: string): HTMLInputElement => {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLInputElement)) throw new Error(`no field #${id}`);
  return element;
};

/** As a person types: the value changes and React hears the input event. */
const type = (id: string, value: string) => {
  const input = field(id);
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

const button = (name: string): HTMLButtonElement => {
  const found = [...host.querySelectorAll("button")].find((b) => b.textContent === name);
  if (found === undefined) throw new Error(`no button "${name}"`);
  return found;
};

const signIn = async ({ email, password }: SignIn) => {
  await act(async () => {
    type("login-email", email);
    type("login-password", password);
  });
  await act(async () => button("Sign in").click());
};

const alertText = () => host.querySelector('[role="alert"]')?.textContent ?? null;

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  server.signIns.length = 0;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("signing in at /login", () => {
  it("shows the server's refusal and keeps the person on the form to try again", async () => {
    server.answer = "refuse";
    await open("/login");
    await signIn({ email: "carol@example.test", password: "not her password" });

    await vi.waitFor(() => expect(alertText()).toBe("Invalid email or password"));
    expect(server.signIns).toEqual([{ email: "carol@example.test", password: "not her password" }]);
    expect(window.location.pathname).toBe("/login");
    expect(button("Sign in").disabled, "the form can be submitted again").toBe(false);
  });

  it("lets the person in with the details they typed", async () => {
    server.answer = "accept";
    await open("/login");
    await signIn({ email: "carol@example.test", password: "her real password" });

    await vi.waitFor(() => expect(window.location.pathname).toBe("/"));
    expect(server.signIns).toEqual([
      { email: "carol@example.test", password: "her real password" },
    ]);
    expect(alertText()).toBeNull();
  });
});
