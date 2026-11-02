// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { Button } from "./button";
import { Field, FieldPair, TextInput } from "./field";
import { FuzzyFinder } from "./finder";
import { InheritChoice, type InheritValue } from "./inherit-choice";
import { ModalDialog } from "./modal";
import { FoldSection } from "./section";
import { Segment } from "./segment";
import { DataTable, gridTemplate } from "./table";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let host: HTMLDivElement | null = null;
let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  host = null;
  root = null;
});

const render = (node: React.ReactNode) => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(node));
};

const byRole = (role: string, name: string | RegExp) => {
  const found = [...document.querySelectorAll<HTMLElement>(`[role="${role}"], ${role}`)].find(
    (element) => {
      const label = element.getAttribute("aria-label") ?? element.textContent ?? "";
      return typeof name === "string" ? label.trim() === name : name.test(label);
    },
  );
  if (found === undefined) throw new Error(`no ${role} named ${String(name)}`);
  return found;
};

const button = (name: string | RegExp) => {
  const found = [...document.querySelectorAll<HTMLElement>("button")].find((element) => {
    const label = element.getAttribute("aria-label") ?? element.textContent ?? "";
    return typeof name === "string" ? label.trim() === name : name.test(label);
  });
  if (found === undefined) throw new Error(`no button named ${String(name)}`);
  return found;
};

const press = (element: Element, key: string) =>
  act(() => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });

function Layout() {
  const [value, setValue] = useState<"unified" | "split">("unified");
  return (
    <Segment
      label="Diff layout"
      value={value}
      onChange={setValue}
      options={[
        { value: "unified", label: "Unified" },
        { value: "split", label: "Split" },
      ]}
    />
  );
}

function Setting() {
  const [value, setValue] = useState<InheritValue>("inherit");
  return (
    <InheritChoice
      label="Run sessions in the background"
      value={value}
      onChange={setValue}
      resolved="on"
      source={{ title: "From Mend's organization defaults", detail: "On for everyone." }}
    />
  );
}

function Opener() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>New worktree</Button>
      <ModalDialog
        open={open}
        onOpenChange={setOpen}
        title="New worktree"
        description="Branch off main."
      >
        <Button>Create</Button>
      </ModalDialog>
    </>
  );
}

function BranchPicker() {
  const [picked, setPicked] = useState("main");
  return (
    <>
      <p>picked {picked}</p>
      <FuzzyFinder
        label="Branch"
        items={["main", "t3/settings-tabs", "fix/tab-order"]}
        itemKey={(branch) => branch}
        itemText={(branch) => branch}
        onPick={setPicked}
        placeholder="Find a branch"
        trigger={<Button>{picked}</Button>}
      />
    </>
  );
}

describe("Segment", () => {
  it("is a named group of toggle buttons, one pressed", () => {
    render(<Layout />);
    expect(byRole("group", "Diff layout")).toBeTruthy();
    expect(button("Unified").getAttribute("aria-pressed")).toBe("true");
    expect(button("Split").getAttribute("aria-pressed")).toBe("false");
    act(() => button("Split").click());
    expect(button("Split").getAttribute("aria-pressed")).toBe("true");
    act(() => button("Split").click());
    expect(button("Split").getAttribute("aria-pressed")).toBe("true");
  });
});

describe("InheritChoice", () => {
  it("shows the value Inherit resolves to beside the explicit choices", () => {
    render(<Setting />);
    const inherit = button(/^Inherit/);
    expect(inherit.textContent).toBe("Inherit · on");
    expect(inherit.getAttribute("aria-pressed")).toBe("true");
    act(() => button("Off").click());
    expect(button("Off").getAttribute("aria-pressed")).toBe("true");
    expect(inherit.getAttribute("aria-pressed")).toBe("false");
  });
});

describe("DataTable", () => {
  it("shares one column template between the header and the rows, with table roles", () => {
    const columns = [
      { head: "Repository", width: "2.2fr" },
      { head: "Sessions", width: "120px" },
      { head: "", width: "auto" },
    ];
    expect(gridTemplate(columns)).toBe("minmax(0,2.2fr) 120px 112px");
    render(
      <DataTable
        label="Projects"
        columns={columns}
        rows={[{ key: "mend", cells: ["mend", "3 live", <Button key="open">Open</Button>] }]}
      />,
    );
    const table = byRole("table", "Projects");
    const rows = table.querySelectorAll<HTMLElement>('[role="row"]');
    expect(rows).toHaveLength(2);
    expect([...rows].map((row) => row.style.gridTemplateColumns)).toEqual([
      "minmax(0,2.2fr) 120px 112px",
      "minmax(0,2.2fr) 120px 112px",
    ]);
    expect(table.querySelectorAll('[role="columnheader"]')).toHaveLength(3);
    expect(table.querySelectorAll('[role="cell"]')).toHaveLength(3);
  });

  it("says what it holds when it has no rows", () => {
    render(
      <DataTable
        label="Devices"
        columns={[{ head: "Device", width: "1fr" }]}
        rows={[]}
        empty="No devices"
      />,
    );
    expect(byRole("cell", "No devices")).toBeTruthy();
  });
});

describe("FoldSection", () => {
  it("folds to its summary from a disclosure button", () => {
    render(
      <FoldSection
        title="Secrets"
        count="5 secrets"
        summary="STRIPE_KEY · and 4 more"
        defaultOpen={false}
      >
        <p>the table</p>
      </FoldSection>,
    );
    const toggle = button(/^Secrets/);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.body.textContent).toContain("STRIPE_KEY · and 4 more");
    act(() => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(document.body.textContent).toContain("the table");
    expect(document.body.textContent).not.toContain("STRIPE_KEY · and 4 more");
  });
});

describe("ModalDialog", () => {
  it("opens as a dialog named by its title and closes on Escape", async () => {
    render(<Opener />);
    act(() => button("New worktree").click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    const labelledBy = dialog?.getAttribute("aria-labelledby") ?? "";
    expect(document.getElementById(labelledBy)?.textContent).toBe("New worktree");
    press(dialog ?? document.body, "Escape");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});

describe("Field and FieldPair", () => {
  it("labels each control and lines the pair up on one grid", () => {
    render(
      <FieldPair columns="2fr 1fr">
        <Field label="Branch">{(id) => <TextInput id={id} defaultValue="main" />}</Field>
        <Field label="Subdirectory">{(id) => <TextInput id={id} />}</Field>
      </FieldPair>,
    );
    const branch = document.querySelector<HTMLInputElement>("input");
    const label = document.querySelector(`label[for="${branch?.id ?? ""}"]`);
    expect(label?.textContent).toBe("Branch");
    expect(branch?.closest<HTMLElement>(".grid.items-start")?.style.gridTemplateColumns).toBe(
      "2fr 1fr",
    );
  });
});

describe("FuzzyFinder", () => {
  it("narrows by typed characters, best match first, and picks from the keyboard", async () => {
    render(<BranchPicker />);
    act(() => button("Branch").click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const input = document.querySelector<HTMLInputElement>('input[placeholder="Find a branch"]');
    expect(input).not.toBeNull();
    if (input === null) return;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "tab");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const options = [...document.querySelectorAll('[role="option"]')].map(
      (option) => option.textContent,
    );
    expect(options).toEqual(["fix/tab-order", "t3/settings-tabs"]);
    press(input, "ArrowDown");
    press(input, "Enter");
    expect(document.body.textContent).toContain("picked fix/tab-order");
  });
});
