// @vitest-environment jsdom
import { act, Component, type ComponentType, type ReactNode, Suspense } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { lazyBody, ViewLoadError } from "./lazy-body.tsx";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

interface Props {
  readonly place: string;
}

function Shown({ place }: Props) {
  return <p>Terminal of {place}</p>;
}

/** A fetch of a body's code that the test settles by hand, counting how often it starts. */
const fetches = () => {
  const started: Array<{
    readonly resolve: (component: ComponentType<Props>) => void;
    readonly reject: (cause: unknown) => void;
  }> = [];
  const load = () =>
    new Promise<ComponentType<Props>>((resolve, reject) => started.push({ resolve, reject }));
  return { started, load };
};

/** The tile's boundary, as `TabFailed` works: the error's words, and Try again. */
class Boundary extends Component<
  { readonly children: ReactNode },
  { readonly error: unknown; readonly key: number }
> {
  override state = { error: null as unknown, key: 0 };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  retry = () => {
    if (this.state.error instanceof ViewLoadError) this.state.error.retry();
    this.setState(({ key }) => ({ error: null, key: key + 1 }));
  };
  override render() {
    if (this.state.error !== null)
      return (
        <p role="alert">{this.state.error instanceof Error ? this.state.error.message : ""}</p>
      );
    return <div key={this.state.key}>{this.props.children}</div>;
  }
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let boundary: Boundary | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
});

/** Renders the tile's body. React retries a suspended render only after an awaited `act`. */
const show = async (Body: ComponentType<Props>) => {
  host ??= document.body.appendChild(document.createElement("div"));
  root ??= createRoot(host);
  await act(async () =>
    root?.render(
      <Boundary
        ref={(instance) => {
          boundary = instance;
        }}
      >
        <Suspense fallback={<p role="status">Opening Terminal…</p>}>
          <Body place="fix-retry" />
        </Suspense>
      </Boundary>,
    ),
  );
  return host;
};

const settle = async (step: () => void) => {
  await act(async () => {
    step();
    // React retries a suspended render on a later task once the fetch settles.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

describe("a view's body, fetched when its tab first shows", () => {
  it("shows the tile's loading line while its code is fetched, then the body", async () => {
    const { started, load } = fetches();
    const terminal = lazyBody("Terminal", load);
    const page = await show(terminal.Body);
    expect(page.textContent).toBe("Opening Terminal…");
    expect(started).toHaveLength(1);
    await settle(() => started[0]?.resolve(Shown));
    expect(page.textContent).toBe("Terminal of fix-retry");
  });

  it("draws a body already fetched at once, never through the loading line", async () => {
    const { started, load } = fetches();
    const terminal = lazyBody("Terminal", load);
    await show(terminal.Body);
    await settle(() => started[0]?.resolve(Shown));
    act(() => root?.unmount());
    root = null;
    // The first commit of a new mount already holds the body.
    expect((await show(terminal.Body)).textContent).toBe("Terminal of fix-retry");
    expect(started).toHaveLength(1);
  });

  it("fetches once when a tab is hovered, so showing it after needs no wait", async () => {
    const { started, load } = fetches();
    const terminal = lazyBody("Terminal", load);
    terminal.preload();
    terminal.preload();
    expect(started).toHaveLength(1);
    await settle(() => started[0]?.resolve(Shown));
    expect((await show(terminal.Body)).textContent).toBe("Terminal of fix-retry");
  });

  it("says why when its code didn't arrive, and Try again fetches it again", async () => {
    const { started, load } = fetches();
    const terminal = lazyBody("Terminal", load);
    const page = await show(terminal.Body);
    await settle(() =>
      started[0]?.reject(new TypeError("Failed to fetch dynamically imported module")),
    );
    expect(page.querySelector("[role=alert]")?.textContent).toBe(
      new ViewLoadError("Terminal", null, () => undefined).message,
    );
    expect(page.textContent).toContain("reload the page");
    await act(async () => boundary?.retry());
    expect(started).toHaveLength(2);
    expect(page.textContent).toBe("Opening Terminal…");
    await settle(() => started[1]?.resolve(Shown));
    expect(page.textContent).toBe("Terminal of fix-retry");
  });

  it("starts again after a preload that failed", async () => {
    const { started, load } = fetches();
    const terminal = lazyBody("Terminal", load);
    terminal.preload();
    await settle(() => started[0]?.reject(new TypeError("offline")));
    const page = await show(terminal.Body);
    expect(started).toHaveLength(2);
    await settle(() => started[1]?.resolve(Shown));
    expect(page.textContent).toBe("Terminal of fix-retry");
  });
});
