import { ResourceDefinitionId, ResourceProposalId, WorktreeId } from "@mend/domain";
import {
  presetDefinition,
  PresetVersion,
  ResourceName,
  ResourceSpecDigest,
} from "@mend/domain/workbench";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { EMPTY_DRAFT, type ResourceSettingView, type ResourcesPageView } from "#/lib/resources";

import {
  ProposalForm,
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

const setting = (overrides: Partial<ResourceSettingView> = {}): ResourceSettingView => ({
  id: ResourceDefinitionId.make("rdef_db"),
  digest,
  spec: db,
  approval: { by: "alice", for: "project" },
  choice: "shared",
  canRemove: false,
  canApprove: false,
  canChoose: false,
  statusLine: "@db · postgres 17 · project · approved by Alice · shared database · not started",
  ...overrides,
});

const proposal = {
  id: ResourceProposalId.make("rprop_1"),
  digest,
  spec: db,
  proposedBy: "carol",
  canRemove: true,
  canApprove: false,
  statusLine: "@db · postgres 17 · project · proposed by Carol · same as settings",
};

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
      busy={null}
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

  it("shows each line as the server sent it, proposals apart, and only the acts the flags allow", () => {
    const markup = render({ settings: [setting()], proposals: [proposal] });
    expect(markup).toContain(
      "@db · postgres 17 · project · approved by Alice · shared database · not started",
    );
    expect(markup).toContain("proposals · not approved");
    expect(markup).toContain("proposed by Carol · same as settings");
    expect(buttons(markup)).toEqual(["withdraw"]);
  });

  it("offers no approval of a proposal settings already hold", () => {
    const markup = render(
      { settings: [setting()], proposals: [{ ...proposal, canApprove: true }] },
      { worktreeId: null },
    );
    expect(buttons(markup)).toEqual(["withdraw"]);
    const other = {
      ...proposal,
      digest: ResourceSpecDigest.make("d".repeat(64)),
      canApprove: true,
    };
    expect(
      buttons(render({ settings: [setting()], proposals: [other] }, { worktreeId: null })),
    ).toEqual(["approve for the project…", "withdraw"]);
  });

  it("names the mode in use to a reader who cannot change it, and offers no choice", () => {
    const markup = render({ settings: [setting()] });
    expect(markup).toContain("checkout uses shared.");
    expect(markup).toContain("Any worktree on shared can change or drop its tables.");
    expect(markup).not.toContain("aria-pressed");
  });

  it("marks the mode in use among the change owner's choices", () => {
    const markup = render({ settings: [setting({ canChoose: true })] });
    expect(
      [...markup.matchAll(/aria-pressed="true"[^>]*>([^<]*)</g)].map((match) => match[1]),
    ).toEqual(["shared"]);
    expect(buttons(markup)).toEqual(["shared", "own", "off"]);
  });

  it("says nothing was chosen yet, and the default at the first launch", () => {
    const markup = render({ settings: [setting({ choice: null, canChoose: true })] });
    expect(markup).toContain("checkout · nothing chosen yet · own at its first launch");
    expect(markup).not.toContain('aria-pressed="true"');
  });

  it("shows the runtime's refusal for an approved definition, and never a start button", () => {
    const markup = render({ settings: [setting()] });
    expect(markup).toContain(
      "@db · resources need a newer Sealant on this runtime · this session can run its own [service.db]",
    );
    expect(buttons(markup)).not.toContain("start");
  });

  it("reviews the exact definition and its digest before an approval is sent", () => {
    const entry = setting({ approval: null, canApprove: true, choice: null });
    const markup = render(
      { settings: [entry] },
      {
        worktreeId: null,
        confirming: {
          key: "s:rdef_db",
          spec: db,
          digest,
          request: { source: { kind: "settings", id: entry.id, digest }, worktreeId: null },
        },
      },
    );
    expect(markup).toContain(`sha256:${digest}`);
    expect(markup).toContain("postgres:17");
    expect(markup).toContain("Approve exactly this definition for the project.");
  });

  it("offers a reload beside a write that changed since it was read", () => {
    const markup = render(
      { settings: [setting({ canRemove: true })] },
      {
        notes: new Map([
          [
            "s:rdef_db",
            {
              refused: true,
              lines: ["the definition changed since you read it · nothing was removed"],
              reload: true,
            },
          ],
        ]),
      },
    );
    expect(markup).toContain("the definition changed since you read it · nothing was removed");
    expect(buttons(markup)).toContain("reload");
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
});
