import { ResourceDefinitionId, ResourceProposalId, WorktreeId } from "@mend/domain";
import {
  presetDefinition,
  PresetVersion,
  type ResourceApprovalRequest,
  ResourceName,
  ResourceSpecDigest,
} from "@mend/domain/workbench";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  EMPTY_DRAFT,
  type ResourceProposalView,
  type ResourceSettingView,
  type ResourcesPageView,
} from "#/lib/resources";

import {
  ProposalForm,
  ReadState,
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
const nothing = () => undefined;
const handlers: ResourceHandlers = {
  withdraw: nothing,
  remove: nothing,
  confirm: nothing,
  approve: nothing,
  choose: nothing,
  reload: nothing,
};
const none = { project: null, worktree: null };
const forProject: ResourceApprovalRequest = {
  source: { kind: "settings", id: ResourceDefinitionId.make("rdef_db"), digest },
  worktreeId: null,
};

const setting = (overrides: Partial<ResourceSettingView> = {}): ResourceSettingView => ({
  id: ResourceDefinitionId.make("rdef_db"),
  digest,
  spec: db,
  approvals: { project: { by: "alice" }, worktree: null },
  approve: none,
  choice: "shared",
  canRemove: false,
  canChoose: false,
  statusLine: "@db · postgres 17 · project · approved by Alice · shared database · not started",
  ...overrides,
});

const proposal = (overrides: Partial<ResourceProposalView> = {}): ResourceProposalView => ({
  id: ResourceProposalId.make("rprop_1"),
  digest,
  spec: db,
  proposedBy: "carol",
  mine: true,
  canRemove: true,
  approvals: none,
  approve: none,
  statusLine: "@db · postgres 17 · project · proposed by Carol · waiting for approval",
  ...overrides,
});

const render = (page: Partial<ResourcesPageView>, overrides: Partial<ResourcesViewProps> = {}) =>
  renderToStaticMarkup(
    <ResourcesView
      page={{
        settings: [],
        proposals: [],
        file: { kind: "not-selected" },
        canPropose: true,
        ...page,
      }}
      worktreeId={worktree}
      worktreeName="checkout"
      busy={new Map()}
      notes={new Map()}
      confirming={null}
      handlers={handlers}
      {...overrides}
    />,
  );

const buttons = (markup: string) =>
  [...markup.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((match) => match[1]);

describe("the resources card", () => {
  it("says so when there are none", () => {
    expect(render({})).toContain("No resources yet.");
  });

  it("shows each line as the server sent it, and only the acts the page offers", () => {
    const markup = render({ settings: [setting()], proposals: [proposal()] });
    expect(markup).toContain(
      "@db · postgres 17 · project · approved by Alice · shared database · not started",
    );
    expect(markup).toContain(">proposals<");
    expect(markup).not.toContain("not approved");
    expect(buttons(markup)).toEqual(["withdraw"]);
  });

  it("says withdraw for the reader's own proposal and remove for a manager removing another's", () => {
    expect(buttons(render({ proposals: [proposal({ mine: false })] }))).toEqual(["remove"]);
  });

  it("offers one approval per target the server built a request for", () => {
    const markup = render({
      settings: [
        setting({
          approvals: none,
          approve: { project: forProject, worktree: { ...forProject, worktreeId: worktree } },
        }),
      ],
    });
    expect(buttons(markup)).toEqual(["approve for the project…", "approve for worktree checkout…"]);
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

  it("reviews every field apart and the definition digest, for the read it was opened on", () => {
    const entry = setting({ approvals: none, approve: { project: forProject, worktree: null } });
    const confirming = {
      key: "s:rdef_db",
      spec: db,
      digest,
      request: forProject,
      target: "for the project",
      worktreeId: null,
    };
    const markup = render({ settings: [entry] }, { worktreeId: null, confirming });
    expect(markup).toContain(`sha256:${digest}`);
    expect(markup).toContain(">definition digest<");
    expect(markup).toContain("[&quot;-c&quot;,&quot;fsync=on&quot;");
    expect(markup).toContain("Approve exactly this definition for the project.");
    // Read for another worktree, the same item shows no review it was not opened on.
    expect(render({ settings: [entry] }, { worktreeId: worktree, confirming })).not.toContain(
      "Approve exactly",
    );
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

const emptyPage: ResourcesPageView = {
  settings: [],
  proposals: [],
  file: { kind: "not-selected" },
  canPropose: true,
};

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

describe("the proposal form", () => {
  it("shows each refusal under the field it names, in the server's words", () => {
    const markup = renderToStaticMarkup(
      <ProposalForm
        draft={{ ...EMPTY_DRAFT, kind: "image", name: "mail" }}
        refusals={[
          { key: "ports", message: "names no port, and a resource is reached on one" },
          { key: "exports.URL", message: "names {x}" },
        ]}
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
      <ProposalForm
        draft={{
          ...EMPTY_DRAFT,
          kind: "image",
          env: [{ key: "MP_UI_AUTH", from: "secret", value: "MAILPIT_AUTH" }],
        }}
        refusals={[]}
        busy={false}
        onChange={nothing}
        onCancel={nothing}
        onSubmit={nothing}
      />,
    );
    expect(markup).toContain('aria-label="Remove env MP_UI_AUTH"');
  });
});
