import { ResourceDefinitionId, WorktreeId } from "@mend/domain";
import {
  presetDefinition,
  PresetVersion,
  type ResourceAddOffer,
  ResourceName,
  ResourceSpecDigest,
} from "@mend/domain/workbench";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  EMPTY_DRAFT,
  type ResourceFileTableView,
  type ResourceSettingView,
  type ResourcesPageView,
} from "#/lib/resources";

import {
  ReadState,
  ResourceForm,
  type ResourceHandlers,
  ResourcesView,
  type ResourcesViewProps,
} from "./resources-section.tsx";

const digest = ResourceSpecDigest.make("c".repeat(64));
const worktree = WorktreeId.make("wt_1");
const db = presetDefinition({
  name: ResourceName.make("db"),
  preset: "postgres",
  version: PresetVersion.make("17"),
  scope: "project",
});
const mail = { ...db, name: ResourceName.make("mail"), scope: "worktree" as const };
const nothing = () => undefined;
const handlers: ResourceHandlers = {
  remove: nothing,
  add: nothing,
  choose: nothing,
  reload: nothing,
};

const setting = (overrides: Partial<ResourceSettingView> = {}): ResourceSettingView => ({
  id: ResourceDefinitionId.make("rdef_db"),
  digest,
  spec: db,
  image: `postgres:17@sha256:${"e".repeat(64)}`,
  addedBy: "alice",
  choice: "shared",
  canRemove: false,
  canChoose: false,
  statusLine: "@db · postgres 17 · project · added by Alice · shared database · not started",
  ...overrides,
});

const table = (add: ResourceAddOffer, name = "mail"): ResourceFileTableView => ({
  digest,
  spec: { ...mail, name: ResourceName.make(name) },
  add,
  statusLine: `@${name} · postgres 17 · worktree · in mend.toml · not in settings`,
});

const fileOf = (...tables: ReadonlyArray<ResourceFileTableView>): ResourcesPageView["file"] => ({
  kind: "read",
  worktreeId: worktree,
  observed: "observed at capture 3 · seq 40",
  tables,
  refused: [],
  ignored: [],
});

const render = (page: Partial<ResourcesPageView>, overrides: Partial<ResourcesViewProps> = {}) =>
  renderToStaticMarkup(
    <ResourcesView
      page={{ settings: [], file: { kind: "not-selected" }, ...page }}
      worktreeId={worktree}
      worktreeName="checkout"
      busy={new Map()}
      notes={new Map()}
      handlers={handlers}
      {...overrides}
    />,
  );

const buttons = (markup: string) =>
  [...markup.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((match) => match[1]);

/** Each reason under a table, in the route's words. */
const reasons = (markup: string) =>
  [
    ...markup
      .replaceAll("<!-- -->", "")
      .replaceAll("&#x27;", "'")
      .matchAll(/<span class="text-label">add ·<\/span> ([^<]*)<\/p>/g),
  ].map((match) => match[1]);

describe("the resources card", () => {
  it("says so when there are none", () => {
    expect(render({})).toContain("No resources yet.");
  });

  it("shows each line as the server sent it, with the image it runs, and only the acts the page offers", () => {
    const markup = render({ settings: [setting()] });
    expect(markup).toContain(
      "@db · postgres 17 · project · added by Alice · shared database · not started",
    );
    expect(markup).toContain(`postgres:17@sha256:${"e".repeat(64)} · rdef_db`);
    expect(markup).not.toContain("approv");
    expect(buttons(markup)).toEqual([]);
    expect(buttons(render({ settings: [setting({ canRemove: true })] }))).toEqual(["remove"]);
  });

  describe("a worktree's mend.toml tables", () => {
    const collision = {
      key: "exports.URL",
      message: "sets MEND_RESOURCE_DB_MAIN_URL, as mail does too",
    };
    const denied =
      "replacing a definition someone else added is theirs or a manager's: the project's creator or an organization owner";

    it("offers to add a table the page says is ready, and nothing for one settings hold", () => {
      const markup = render({
        file: fileOf(table({ kind: "ready" }), table({ kind: "added" }, "box")),
      });
      expect(buttons(markup)).toEqual(["add to settings"]);
      expect(reasons(markup)).toEqual([]);
    });

    it("says why a table has no add, each refusal by its key, and a denial in its words", () => {
      const markup = render({
        file: fileOf(
          table({ kind: "rejected", refusals: [collision] }),
          table({ kind: "denied", message: denied }, "db"),
        ),
      });
      expect(buttons(markup)).toEqual([]);
      expect(reasons(markup)).toEqual([
        "exports.URL sets MEND_RESOURCE_DB_MAIN_URL, as mail does too",
        denied,
      ]);
    });

    it("says adding only on the table being added", () => {
      const markup = render(
        { file: fileOf(table({ kind: "ready" }), table({ kind: "ready" }, "box")) },
        { busy: new Map([["f:mail", "add"]]) },
      );
      expect(buttons(markup)).toEqual(["adding…", "add to settings"]);
    });
  });

  it("names the mode in use to a reader who cannot change it, and offers no choice", () => {
    const markup = render({ settings: [setting()] });
    expect(markup).toContain("checkout uses shared.");
    expect(markup).not.toContain("aria-pressed");
  });

  it("marks the mode in use among the change owner's choices", () => {
    const markup = render({ settings: [setting({ canChoose: true })] });
    expect(
      [...markup.matchAll(/aria-pressed="true"[^>]*>([^<]*)</g)].map((match) => match[1]),
    ).toEqual(["shared"]);
  });

  it("says a session, not this one, can run its own while starting is refused", () => {
    const markup = render({ settings: [setting()] });
    expect(markup).toContain(
      "@db · resources need a newer Sealant on this runtime · a session can run its own [service.db]",
    );
    expect(markup).not.toContain("this session");
    expect(buttons(markup)).not.toContain("start");
  });

  it("writes each refusal on its own line, with a reload beside a stale read", () => {
    const markup = render(
      { settings: [setting({ canRemove: true })] },
      {
        notes: new Map([
          [
            "s:rdef_db",
            {
              refused: true,
              lines: ["@db · worktree is one worktree", "@db · image is sha256:1"],
              reload: true,
            },
          ],
        ]),
      },
    );
    expect(markup).toContain(">@db · worktree is one worktree</p>");
    expect(markup).toContain(">@db · image is sha256:1</p>");
    expect(buttons(markup)).toContain("reload");
  });

  it("says busy only on the action running, and holds the item's other actions", () => {
    const markup = render(
      { settings: [setting({ canRemove: true, canChoose: true })] },
      { busy: new Map([["s:rdef_db", "choose"]]) },
    );
    expect(buttons(markup)).toContain("remove");
    expect(markup).not.toContain("removing…");
    expect(markup).toMatch(/<button type="button" disabled=""[^>]*>remove<\/button>/);
  });
});

const emptyPage: ResourcesPageView = { settings: [], file: { kind: "not-selected" } };

describe("reading the card", () => {
  const show = (read: Parameters<typeof ReadState>[0]["read"]) =>
    renderToStaticMarkup(
      <ReadState read={read} worktreeName="checkout" onRetry={nothing}>
        {() => <p>loaded</p>}
      </ReadState>,
    );

  it("tells a read in flight from a failed one, which offers a retry", () => {
    expect(show({ kind: "pending" })).toContain("reading resources for checkout…");
    const failed = show({ kind: "failed", message: "Not found. It may have been removed." });
    expect(failed).toContain("resources for checkout not read · Not found.");
    expect(buttons(failed)).toEqual(["retry"]);
    expect(show({ kind: "loaded", page: emptyPage, worktreeId: worktree })).toContain("loaded");
  });
});

describe("the add form", () => {
  it("shows each refusal under the field it names, in the server's words", () => {
    const markup = renderToStaticMarkup(
      <ResourceForm
        draft={{ ...EMPTY_DRAFT, kind: "image", name: "mail" }}
        refusals={[
          { key: "ports", message: "names no port, and a resource is reached on one" },
          { key: "exports.URL", message: "names {x}" },
        ]}
        note={undefined}
        busy={false}
        onChange={nothing}
        onCancel={nothing}
        onSubmit={nothing}
      />,
    );
    const ports = markup.indexOf('aria-label="Ports"');
    const refusal = markup.indexOf("ports names no port");
    expect(ports).toBeGreaterThan(-1);
    expect(refusal).toBeGreaterThan(ports);
    expect(refusal).toBeLessThan(markup.indexOf('aria-label="Volumes"'));
    expect(markup.indexOf("exports.URL names {x}")).toBeGreaterThan(markup.indexOf("+ env"));
  });

  it("lets each env row be removed", () => {
    const markup = renderToStaticMarkup(
      <ResourceForm
        draft={{
          ...EMPTY_DRAFT,
          kind: "image",
          env: [{ key: "MP_UI_AUTH", from: "secret", value: "MAILPIT_AUTH" }],
        }}
        refusals={[]}
        note={undefined}
        busy={false}
        onChange={nothing}
        onCancel={nothing}
        onSubmit={nothing}
      />,
    );
    expect(markup).toContain('aria-label="Remove env MP_UI_AUTH"');
  });
});
