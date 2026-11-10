// @vitest-environment jsdom
import { QueryClient } from "@tanstack/react-query";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { McpServersSettings } from "./mcp-servers.tsx";
import {
  byText,
  cachedText,
  click,
  renderWithTrpc,
  settle,
  type Answer,
} from "./sessions-test-trpc.tsx";

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  document.body.replaceChildren();
  window.location.hash = "";
});

const TOKEN = "ghp_secret_value_never_shown_1234567890";
const AT = new Date("2026-11-09T10:00:00Z");

const github = {
  id: "s1",
  scope: "person",
  name: "github",
  transport: {
    _tag: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
  },
  secretNames: ["GITHUB_TOKEN"],
  enabled: true,
  createdAt: AT,
  updatedAt: AT,
};
const figma = {
  id: "s2",
  scope: "person",
  name: "figma",
  transport: { _tag: "http", url: "https://mcp.figma.com/mcp" },
  secretNames: [],
  enabled: false,
  createdAt: AT,
  updatedAt: AT,
};
const tavily = {
  ...figma,
  id: "s3",
  name: "tavily",
  transport: { _tag: "http", url: "https://mcp.tavily.com/mcp/?tavilyApiKey=…" },
  enabled: true,
};
const LIMITS = {
  servers: 16,
  secretsPerServer: 16,
  secretValueBytes: 8192,
  args: 32,
  argBytes: 1024,
};

const organizationView = (role: "owner" | "member") => ({
  organization: {
    id: "org-acme",
    name: "Acme",
    createdByUserId: null,
    createdAt: AT,
    updatedAt: AT,
  },
  userId: "carol",
  role,
  memberCount: 2,
  operator: false,
  tenancy: "single",
  mountDelivery: "bind",
});

interface Calls {
  readonly paths: Array<string>;
  readonly inputs: Array<unknown>;
}

const serverWith =
  (
    calls: Calls,
    organization: "owner" | "member" | null = null,
    servers: ReadonlyArray<typeof github | typeof figma> = [github, figma],
  ) =>
  (path: string, input: unknown): Answer => {
    calls.paths.push(path);
    calls.inputs.push(input);
    switch (path) {
      case "mcpServers.list":
        return { data: { servers, limits: LIMITS } };
      case "mcpServers.save":
      case "mcpServers.remove":
        return { data: github };
      case "organization.current":
        return organization === null
          ? { refuse: "You belong to no organization." }
          : { data: organizationView(organization) };
      case "executor.configuration":
        return {
          data: {
            mode: "mend-run",
            url: null,
            mendRunAvailable: true,
            member: { state: "active", observedAt: AT },
            managed: {
              available: true,
              reason: null,
              state: "running",
              observedAt: AT,
              image: "executor:1",
              releaseImage: "executor:1",
              memoryBytes: 1,
              backupAt: null,
              retained: true,
            },
          },
        };
      case "executor.personal":
        return { data: { configured: true, url: null, link: { state: "active", observedAt: AT } } };
      case "executor.directory":
        return { data: { services: [], observedAt: AT } };
      default:
        return { refuse: `unexpected ${path}` };
    }
  };

const enter = async (input: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const prototype =
    input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
};

// A dialog mounts through a portal after the click's own render: wait for it, as account-keys does.
const opened = async (button: string) => {
  await click(byText("button", button));
  for (
    let tick = 0;
    tick < 100 && document.querySelector('[role="dialog"] button') === null;
    tick += 1
  )
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
};

const dialogInput = (label: string): HTMLInputElement => {
  const dialog = document.querySelector('[role="dialog"]');
  const byAria = dialog?.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (byAria !== null && byAria !== undefined) return byAria;
  const labelled = [...(dialog?.querySelectorAll("label") ?? [])].find(
    (element) => element.textContent === label,
  );
  const input = labelled === undefined ? null : document.getElementById(labelled.htmlFor);
  if (!(input instanceof HTMLInputElement)) throw new Error(`no input ${label} in the dialog`);
  return input;
};

const switchFor = (name: string): HTMLElement => {
  const found = [...document.querySelectorAll<HTMLElement>('[role="switch"]')].find((element) =>
    document
      .getElementById(element.getAttribute("aria-labelledby") ?? "")
      ?.textContent?.startsWith(`${name} `),
  );
  if (found === undefined) throw new Error(`no switch for ${name}`);
  return found;
};

const sent = (calls: Calls, path: string) => calls.inputs[calls.paths.lastIndexOf(path)];

describe("Settings · MCP servers", () => {
  it("lists each server by name, transport, target and the names of its saved values", async () => {
    root = await renderWithTrpc(<McpServersSettings />, serverWith({ paths: [], inputs: [] }));
    const text = document.body.textContent ?? "";
    expect(text).toContain("github");
    expect(text).toContain("stdio");
    expect(text).toContain("npx -y @modelcontextprotocol/server-github");
    expect(text).toContain("env GITHUB_TOKEN · saved");
    expect(text).toContain("HTTP");
    expect(text).toContain("mcp.figma.com");
    expect(text).not.toContain("https://mcp.figma.com/mcp");
    expect(switchFor("github").getAttribute("aria-checked")).toBe("true");
    expect(switchFor("figma").getAttribute("aria-checked")).toBe("false");
    expect(text).not.toContain("Executor");
  });

  it("turns a server on with its transport as saved and leaves its values alone", async () => {
    const calls: Calls = { paths: [], inputs: [] };
    root = await renderWithTrpc(<McpServersSettings />, serverWith(calls));
    await click(switchFor("figma"));
    expect(sent(calls, "mcpServers.save")).toEqual({
      name: "figma",
      server: { transport: { _tag: "http", url: "https://mcp.figma.com/mcp" }, enabled: true },
    });
  });

  it("adds an HTTP server with a header, and forgets the value once the dialog closes", async () => {
    const calls: Calls = { paths: [], inputs: [] };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = await renderWithTrpc(<McpServersSettings />, serverWith(calls), queryClient);
    await opened("Add an MCP server");
    expect(byText('[role="dialog"] button', "Add server").hasAttribute("disabled")).toBe(true);
    await enter(dialogInput("Name"), "linear");
    await enter(dialogInput("URL"), "https://mcp.linear.app/mcp");
    await click(byText('[role="dialog"] button', "Add a header"));
    await enter(dialogInput("New header name"), "Authorization");
    expect(dialogInput("Authorization value").type).toBe("password");
    await enter(dialogInput("Authorization value"), `Bearer ${TOKEN}`);
    await click(byText('[role="dialog"] button', "Add server"));
    expect(sent(calls, "mcpServers.save")).toEqual({
      name: "linear",
      server: {
        transport: { _tag: "http", url: "https://mcp.linear.app/mcp" },
        secrets: { Authorization: { _tag: "Set", value: `Bearer ${TOKEN}` } },
      },
    });
    await settle();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.innerHTML).not.toContain(TOKEN);
    expect(cachedText(queryClient)).not.toContain(TOKEN);
  });

  it("says what is wrong with a name or URL before anything is sent", async () => {
    const calls: Calls = { paths: [], inputs: [] };
    root = await renderWithTrpc(<McpServersSettings />, serverWith(calls));
    await opened("Add an MCP server");
    await enter(dialogInput("Name"), "mend-tools");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "names starting with mend- are Mend's own",
    );
    await enter(dialogInput("Name"), "figma");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "you already have figma: edit it instead",
    );
    await enter(dialogInput("Name"), "tools");
    await enter(dialogInput("URL"), "https://me:pw@mcp.example.com/");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "a server URL carries no user name or password",
    );
    expect(byText('[role="dialog"] button', "Add server").hasAttribute("disabled")).toBe(true);
    expect(calls.paths).not.toContain("mcpServers.save");
  });

  it("edits a server by its saved names: never fills a value, keeps, replaces or removes each", async () => {
    const calls: Calls = { paths: [], inputs: [] };
    root = await renderWithTrpc(<McpServersSettings />, serverWith(calls));
    await opened("Edit github");
    expect(dialogInput("Name").readOnly).toBe(true);
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("GITHUB_TOKEN · saved");
    for (const input of dialog?.querySelectorAll("input") ?? []) {
      if (input.type === "password") expect(input.value).toBe("");
    }
    await click(byText('[role="dialog"] button', "Save server"));
    expect(sent(calls, "mcpServers.save")).toEqual({
      name: "github",
      server: {
        transport: {
          _tag: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
        },
        secrets: { GITHUB_TOKEN: { _tag: "Keep" } },
      },
    });

    await opened("Edit github");
    await click(byText('[role="dialog"] button', "Replace"));
    expect(byText('[role="dialog"] button', "Save server").hasAttribute("disabled")).toBe(true);
    await enter(dialogInput("GITHUB_TOKEN new value"), TOKEN);
    await click(byText('[role="dialog"] button', "Save server"));
    expect(sent(calls, "mcpServers.save")).toMatchObject({
      server: { secrets: { GITHUB_TOKEN: { _tag: "Set", value: TOKEN } } },
    });

    await opened("Edit github");
    await click(byText('[role="dialog"] button', "Remove"));
    await click(byText('[role="dialog"] button', "Save server"));
    expect(sent(calls, "mcpServers.save")).toMatchObject({ server: { secrets: {} } });
  });

  it("shows a URL with the parts that may hold a key as …, and saves it unchanged to keep it", async () => {
    const calls: Calls = { paths: [], inputs: [] };
    root = await renderWithTrpc(<McpServersSettings />, serverWith(calls, null, [tavily]));
    expect(document.body.textContent).toContain("mcp.tavily.com");
    await opened("Edit tavily");
    expect(dialogInput("URL").value).toBe("https://mcp.tavily.com/mcp/?tavilyApiKey=…");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "A part that may hold a key shows as … instead.",
    );
    await click(byText('[role="dialog"] button', "Save server"));
    expect(sent(calls, "mcpServers.save")).toEqual({
      name: "tavily",
      server: { transport: tavily.transport, secrets: {} },
    });
  });

  it("removes a server after saying its saved values go with it", async () => {
    const calls: Calls = { paths: [], inputs: [] };
    root = await renderWithTrpc(<McpServersSettings />, serverWith(calls));
    await opened("Remove github");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "deletes its saved values",
    );
    await click(byText('[role="dialog"] button', "Remove"));
    expect(sent(calls, "mcpServers.remove")).toEqual({ name: "github" });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("shows an owner the organization's Executor as a row that opens its link and settings", async () => {
    root = await renderWithTrpc(
      <McpServersSettings />,
      serverWith({ paths: [], inputs: [] }, "owner"),
    );
    const row = byText('[role="row"]', /^Executor/).textContent ?? "";
    expect(row).toContain("Mend-run");
    expect(row).toContain("running · observed");
    expect(row).toContain("linked as you");
    expect(document.getElementById("executor")).toBeNull();
    await click(byText("button", "Open"));
    const detail = document.getElementById("executor")?.textContent ?? "";
    expect(detail).toContain("Executor issued this link");
    expect(detail).toContain("For Acme");
    expect(detail).toContain("Mend's member");
    expect(detail).toContain("Mend runs Executor");
  });

  it("opens the Executor row when the link that led here names it", async () => {
    window.location.hash = "#executor";
    root = await renderWithTrpc(
      <McpServersSettings />,
      serverWith({ paths: [], inputs: [] }, "member"),
    );
    const detail = document.getElementById("executor");
    expect(detail?.textContent).toContain("Executor running");
    expect(
      [...(detail?.querySelectorAll("button") ?? [])].map((button) => button.textContent),
    ).not.toContain("Stop Executor");
  });
});
