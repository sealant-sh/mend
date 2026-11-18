// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bodyText, urlText } from "#/test-fixtures/fake-fetch";

import { JoinWithAccount } from "./join-account.tsx";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

/** Every request the page sent to Better Auth, and what the fake server answers next. */
let sent: Array<{ readonly url: string; readonly body: unknown; readonly headers: Headers }> = [];
let answer: () => Promise<Response> = () => Promise.reject(new Error("no answer set"));

// Better Auth's client keeps the `fetch` it saw when it was made, at import: the fake goes in first
// and hands each request to whatever this test set.
const fake = vi.hoisted(() => {
  const handler: { current: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> } =
    { current: () => Promise.reject(new Error("no fake server")) };
  globalThis.fetch = (input, init) => handler.current(input, init);
  return handler;
});

beforeEach(() => {
  sent = [];
  fake.current = (input, init) => {
    sent.push({
      url: urlText(input),
      body: JSON.parse(bodyText(init)),
      headers: new Headers(init?.headers),
    });
    return answer();
  };
});

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

const json = (status: number, body: unknown) => () =>
  Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );

const TOKEN = "invitation-token-1234";

const render = async (props: { onCreated?: () => void; reread?: () => void } = {}) => {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <JoinWithAccount
        invitation={{
          organizationName: "Northwind",
          role: "member",
          expiresAt: new Date(2026, 10, 20, 10, 42),
        }}
        token={TOKEN}
        reread={props.reread ?? vi.fn()}
        onCreated={props.onCreated ?? vi.fn()}
      />,
    ),
  );
};

const field = (label: string): HTMLInputElement => {
  const labelled = [...document.querySelectorAll("label")].find((l) => l.textContent === label);
  const input = labelled === undefined ? null : document.getElementById(labelled.htmlFor);
  if (!(input instanceof HTMLInputElement)) throw new Error(`no field labelled ${label}`);
  return input;
};

/** Types into a controlled input the way a browser does: React reads the native value. */
const type = async (label: string, value: string) => {
  const input = field(label);
  await act(async () => {
    Reflect.set(HTMLInputElement.prototype, "value", value, input);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const button = (name: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll("button")].find((b) => b.textContent === name);
  if (found === undefined) throw new Error(`no button named ${name}`);
  return found;
};

const press = async (name: string) => {
  await act(async () => button(name).click());
  // Better Auth's client reads the answer over a few turns of the event loop.
  await act(() => new Promise((resolve) => setTimeout(resolve, 300)));
};

const text = () => document.body.textContent ?? "";

const fillAccount = async (email: string) => {
  await type("Name", "Linus Pauling");
  await type("Email", email);
  await type("Password", "long enough");
  await type("Confirm password", "long enough");
};

describe("JoinWithAccount", () => {
  it("creates the account with the invitation's token, which the server needs to admit it", async () => {
    const created = vi.fn();
    await render({ onCreated: created });
    await fillAccount("linus@northwind.dev");
    answer = json(200, { token: "t", user: { id: "u2", email: "linus@northwind.dev" } });
    await press("Create account and join");

    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toMatch(/\/api\/auth\/sign-up\/email$/);
    expect(sent[0]?.headers.get("x-mend-invitation")).toBe(TOKEN);
    expect(sent[0]?.body).toEqual({
      name: "Linus Pauling",
      email: "linus@northwind.dev",
      password: "long enough",
    });
    expect(created).toHaveBeenCalledOnce();
  });

  it("names an email that has an account, and signs in with it instead", async () => {
    await render();
    await fillAccount("linus@northwind.dev");
    answer = json(422, {
      code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
      message: "User already exists. Use another email.",
    });
    await press("Create account and join");

    expect(text()).toContain("There's already an account for linus@northwind.dev on this server.");
    expect(text()).toContain("Fix the field above to continue.");
    expect(field("Email").getAttribute("aria-invalid")).toBe("true");

    await press("Sign in instead");
    expect(document.querySelector("form")?.getAttribute("aria-label")).toBe("Sign in");
    expect(field("Email").value).toBe("linus@northwind.dev");
    expect(button("Back to invitation")).toBeDefined();
  });

  it("drops the email problem once the field holds another email", async () => {
    await render();
    await fillAccount("linus@northwind.dev");
    answer = json(422, { code: "USER_ALREADY_EXISTS", message: "User already exists." });
    await press("Create account and join");
    await type("Email", "linus.pauling@northwind.dev");

    expect(text()).not.toContain("There's already an account");
    expect(field("Email").getAttribute("aria-invalid")).toBeNull();
  });

  it("reads the invitation again when the server refuses it, in case it was spent meanwhile", async () => {
    const reread = vi.fn();
    await render({ reread });
    await fillAccount("linus@northwind.dev");
    answer = json(403, {
      message: "This invitation was already used. Ask an owner for a new link.",
    });
    await press("Create account and join");

    expect(text()).toContain(
      "Mend didn't create the account. This invitation was already used. Ask an owner for a new link.",
    );
    expect(reread).toHaveBeenCalledOnce();
  });
});
