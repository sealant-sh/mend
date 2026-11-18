import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach } from "vitest";

// The kit has no testing library: a test mounts what it renders into the jsdom document with
// React's own `act`, and finds things the way a screen reader would, by role and name.

let mounted: Array<{ host: HTMLElement; root: Root }> = [];

afterEach(() => {
  for (const { host, root } of mounted) {
    act(() => root.unmount());
    host.remove();
  }
  mounted = [];
});

/** Mounts `ui` and returns a function that renders new UI into the same root. */
export function render(ui: ReactNode) {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ host, root });
  act(() => root.render(ui));
  return {
    host,
    rerender: (next: ReactNode) => act(() => root.render(next)),
  };
}

/** The accessible name of an element, as far as these tests need it. */
function nameOf(element: Element): string {
  if (element instanceof HTMLInputElement && element.labels !== null && element.labels.length > 0) {
    return [...element.labels]
      .map((label) => label.textContent ?? "")
      .join(" ")
      .trim();
  }
  const label = element.getAttribute("aria-label");
  if (label !== null) return label;
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy !== null) {
    return labelledBy
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ")
      .trim();
  }
  return (element.textContent ?? "").trim();
}

const implicitRoles: Record<string, string> = {
  button: "button",
  textarea: "textbox",
  "input[type=radio]": "radio",
  "input[type=checkbox]": "checkbox",
};

/** Every element with `role`, by explicit role or the tag that implies it. */
function allByRole(role: string, container: ParentNode = document): Element[] {
  const selectors = [`[role="${role}"]`];
  for (const [selector, implied] of Object.entries(implicitRoles)) {
    if (implied === role) selectors.push(`${selector}:not([role])`);
  }
  return [...container.querySelectorAll(selectors.join(","))];
}

/** The one element with `role` whose name contains `name`. */
export function getByRole(
  role: string,
  name: string | RegExp,
  container: ParentNode = document,
): HTMLElement {
  const matches = allByRole(role, container).filter((element): element is HTMLElement => {
    if (!(element instanceof HTMLElement)) return false;
    const text = nameOf(element);
    return typeof name === "string" ? text.includes(name) : name.test(text);
  });
  if (matches.length !== 1) {
    throw new Error(`Expected one ${role} named ${String(name)}, found ${matches.length}`);
  }
  const [match] = matches;
  if (match === undefined) throw new Error(`No ${role} named ${String(name)}`);
  return match;
}

/** Clicks like a person: pointer and mouse events, then the click. */
export function click(element: Element) {
  act(() => {
    element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

/** Presses `key` on `element`, with Shift when asked. */
export function press(element: Element, key: string, { shiftKey = false } = {}) {
  act(() => {
    element.dispatchEvent(
      new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true }),
    );
  });
}

/** Types `text` into a textarea the way React hears it. */
export function type(element: HTMLElement, text: string) {
  if (!(element instanceof HTMLTextAreaElement)) throw new Error("Not a textarea");
  act(() => {
    // Through the prototype's setter, as a browser does, so React sees the value change.
    Reflect.set(HTMLTextAreaElement.prototype, "value", text, element);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
