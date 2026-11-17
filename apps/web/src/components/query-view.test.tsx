// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { QueryView } from "./query-view.tsx";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

/** A query of project names, answered by `read`, rendered through QueryView. */
function Projects({
  read,
  empty,
}: {
  readonly read: () => Promise<ReadonlyArray<string>>;
  readonly empty?: ReactNode;
}) {
  const query = useQuery({ queryKey: ["projects"], queryFn: read, retry: false });
  return (
    <QueryView query={query} empty={empty}>
      {(names) => (
        <ul>
          {names.map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
      )}
    </QueryView>
  );
}

const render = async (node: ReactNode) => {
  const client = new QueryClient();
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
  });
  return container;
};

const settle = () => act(async () => new Promise((done) => setTimeout(done, 0)));

describe("QueryView", () => {
  it("says the read is under way while it runs", async () => {
    const page = await render(<Projects read={() => new Promise(() => undefined)} />);
    expect(page.querySelector('[role="status"]')?.textContent).toBe("Loading…");
    expect(page.querySelector("ul")).toBeNull();
  });

  it("shows a failure with its words, and Try again reads it again", async () => {
    let reads = 0;
    const page = await render(
      <Projects
        read={async () => {
          reads += 1;
          if (reads === 1) throw new Error("The Mend server is not answering.");
          return ["checkout-api"];
        }}
      />,
    );
    await settle();
    expect(page.querySelector('[role="alert"]')?.textContent).toContain(
      "The Mend server is not answering.",
    );
    const again = [...page.querySelectorAll("button")].find((b) => b.textContent === "Try again");
    await act(async () => again?.click());
    await settle();
    expect(reads).toBe(2);
    expect(page.querySelector("li")?.textContent).toBe("checkout-api");
  });

  it("shows the caller's empty state when the read loaded nothing", async () => {
    const page = await render(<Projects read={async () => []} empty={<p>No projects yet</p>} />);
    await settle();
    expect(page.textContent).toBe("No projects yet");
  });

  it("hands the loaded data to its child", async () => {
    const page = await render(<Projects read={async () => ["checkout-api", "billing"]} />);
    await settle();
    expect([...page.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
      "checkout-api",
      "billing",
    ]);
  });
});

/** Typechecked, never run: a loaded child written for `undefined` data does not compile. */
export function OptionalChildRefused({ read }: { readonly read: () => Promise<string> }) {
  const query = useQuery({ queryKey: ["name"], queryFn: read });
  return (
    // @ts-expect-error The loaded child takes data that is always there, never `undefined`.
    <QueryView query={query}>{(name: string | undefined) => <p>{name ?? "nobody"}</p>}</QueryView>
  );
}
