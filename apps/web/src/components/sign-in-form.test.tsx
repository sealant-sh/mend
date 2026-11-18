// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bodyText, urlText } from "#/test-fixtures/fake-fetch";

import { FirstAccountForm } from "./first-account-form.tsx";
import { SignInForm } from "./sign-in-form.tsx";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

/** Every request the forms sent to Better Auth, and what the fake server answers next. */
let sent: Array<{ readonly url: string; readonly body: unknown }> = [];
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
    sent.push({ url: urlText(input), body: JSON.parse(bodyText(init)) });
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

const render = async (node: ReactNode) => {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(node));
  return container;
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
    // The prototype's setter, past the one React puts on the element to notice its own writes.
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

describe("SignInForm", () => {
  it("says the email or password is wrong, and lets the person try again", async () => {
    const signedIn = vi.fn();
    await render(<SignInForm onSignedIn={signedIn} />);
    await type("Email", "ada@northwind.dev");
    await type("Password", "not her password");
    answer = json(401, { code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" });
    await press("Sign in");

    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toMatch(/\/api\/auth\/sign-in\/email$/);
    expect(sent[0]?.body).toEqual({ email: "ada@northwind.dev", password: "not her password" });
    expect(text()).toContain("Wrong email or password. Check both and try again.");
    expect(signedIn).not.toHaveBeenCalled();
    expect(button("Sign in").disabled).toBe(false);
  });

  it("says the server didn't answer, offers Try again, and signs in when it answers", async () => {
    const signedIn = vi.fn();
    await render(<SignInForm onSignedIn={signedIn} />);
    await type("Email", "ada@northwind.dev");
    await type("Password", "her password");
    answer = () => Promise.reject(new TypeError("Failed to fetch"));
    await press("Sign in");

    expect(text()).toContain("Mend's server didn't answer.");
    answer = json(200, { token: "t", user: { id: "u1", email: "ada@northwind.dev" } });
    await press("Try again");

    expect(signedIn).toHaveBeenCalledOnce();
    expect(text()).not.toContain("didn't answer");
    expect(button("Signing in…").disabled).toBe(true);
  });
});

describe("FirstAccountForm", () => {
  it("names each field to fix under it, sends nothing, and clears a problem once it's fixed", async () => {
    const created = vi.fn();
    await render(<FirstAccountForm onCreated={created} />);
    await type("Email", "ada@northwind");
    await type("Password", "long enough");
    await type("Confirm password", "long enougg");
    await press("Create account and continue");

    expect(sent).toHaveLength(0);
    expect(text()).toContain("Enter a whole email address, like ada@example.com.");
    expect(text()).toContain("The passwords don't match.");
    expect(text()).toContain("Fix the 2 fields above to continue.");
    expect(document.activeElement).toBe(field("Email"));
    expect(field("Email").getAttribute("aria-invalid")).toBe("true");

    await type("Email", "ada@northwind.dev");
    expect(text()).not.toContain("Enter a whole email address");
    expect(text()).toContain("Fix the field above to continue.");
  });

  it("creates the account, named by its email when no name was given", async () => {
    const created = vi.fn();
    await render(<FirstAccountForm onCreated={created} />);
    await type("Email", "ada@northwind.dev");
    await type("Password", "long enough");
    await type("Confirm password", "long enough");
    answer = json(200, { token: "t", user: { id: "u1", email: "ada@northwind.dev" } });
    await press("Create account and continue");

    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toMatch(/\/api\/auth\/sign-up\/email$/);
    expect(sent[0]?.body).toEqual({
      name: "ada@northwind.dev",
      email: "ada@northwind.dev",
      password: "long enough",
    });
    expect(created).toHaveBeenCalledOnce();
  });

  it("passes on the server's refusal in its own words", async () => {
    await render(<FirstAccountForm onCreated={vi.fn()} />);
    await type("Name", "Ada Lovelace");
    await type("Email", "ada@northwind.dev");
    await type("Password", "long enough");
    await type("Confirm password", "long enough");
    answer = json(403, { message: "Accounts are created by invitation." });
    await press("Create account and continue");

    expect(sent[0]?.body).toMatchObject({ name: "Ada Lovelace" });
    expect(text()).toContain("Mend didn't create the account. Accounts are created by invitation.");
  });
});
