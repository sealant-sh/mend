// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { CopyButton } from "./copy-button";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  document.body.replaceChildren();
  Reflect.deleteProperty(document, "execCommand");
});

/** Mend opened over plain HTTP on a private network: no Clipboard API, only the old command. */
const plainHttp = (copies: boolean) => {
  Reflect.deleteProperty(navigator, "clipboard");
  const copied: Array<string> = [];
  Reflect.set(document, "execCommand", (command: string) => {
    const area = document.querySelector("textarea");
    if (command === "copy" && copies && area !== null) copied.push(area.value);
    return copies;
  });
  return copied;
};

const press = async () => {
  const button = document.querySelector("button");
  if (button === null) throw new Error("no button");
  await act(async () => {
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

const render = () => {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(<CopyButton text="ssh-ed25519 AAAA mend" label="Mend's public key" />));
};

const statuses = () =>
  [...document.querySelectorAll('[role="status"]')].map((el) => el.textContent).join("|");

describe("Copy over plain HTTP", () => {
  it("copies through the fallback and says Copied", async () => {
    const copied = plainHttp(true);
    render();
    await press();
    expect(copied).toEqual(["ssh-ed25519 AAAA mend"]);
    expect(statuses()).toContain("Copied");
  });

  it("says the copy failed when nothing could copy, never Copied", async () => {
    plainHttp(false);
    render();
    await press();
    expect(statuses()).toContain("Copy failed, select the text");
    expect(statuses()).not.toContain("Copied");
  });
});
