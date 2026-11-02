// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Kept, KeptSlot, useKeptNode } from "./kept";

/** A stand-in for the terminal: it opens its socket once, as it mounts, and closes it as it goes. */
const sockets = { opened: 0, closed: 0 };
const open = () => {
  sockets.opened += 1;
  return () => {
    sockets.closed += 1;
  };
};
function Socket() {
  return (
    <p data-testid="socket" ref={open}>
      live
    </p>
  );
}

let place: (next: "main" | "work" | "none") => void = () => undefined;

function Harness() {
  const [where, setWhere] = useState<"main" | "work" | "none">("main");
  place = setWhere;
  const node = useKeptNode("kept");
  const keep = (
    <Kept node={node}>
      <Socket />
    </Kept>
  );
  // As the session view does: a different tree per layout, the kept part first in each.
  return where === "work" ? (
    <>
      {keep}
      <aside data-testid="work">
        <KeptSlot node={node} />
      </aside>
    </>
  ) : (
    <>
      {keep}
      <main data-testid="main">
        {where === "main" ? <KeptSlot node={node} /> : <p>conversation</p>}
      </main>
    </>
  );
}

let host: HTMLDivElement;

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  sockets.opened = 0;
  sockets.closed = 0;
  host = document.createElement("div");
  document.body.append(host);
});

afterEach(() => host.remove());

describe("a kept part of the page", () => {
  it("keeps one socket open through tab and layout changes, wherever it shows", async () => {
    const root = createRoot(host);
    await act(async () => root.render(<Harness />));
    const socket = () => host.querySelector('[data-testid="socket"]');
    expect(host.querySelector('[data-testid="main"]')?.contains(socket())).toBe(true);
    // Another tab: no slot, so the node leaves the page, and what it holds stays mounted.
    await act(async () => place("none"));
    expect(socket()).toBeNull();
    // Back, then into another layout.
    await act(async () => place("main"));
    expect(host.querySelector('[data-testid="main"]')?.contains(socket())).toBe(true);
    await act(async () => place("work"));
    expect(host.querySelector('[data-testid="work"]')?.contains(socket())).toBe(true);
    expect(sockets).toEqual({ opened: 1, closed: 0 });
    // A render that changes nothing about where it shows does not move the node.
    const before = socket()?.parentElement;
    await act(async () => place("work"));
    expect(socket()?.parentElement).toBe(before);
    await act(async () => root.unmount());
    expect(sockets).toEqual({ opened: 1, closed: 1 });
  });
});
