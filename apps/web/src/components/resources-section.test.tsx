import { ResourceDefinitionId, WorktreeId } from "@mend/domain";
import {
  presetDefinition,
  PresetVersion,
  ResourceName,
  ResourceSpecDigest,
} from "@mend/domain/workbench";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ResourcesPageView, ResourceSettingView } from "#/lib/resources";

import { ResourcesView, ReadState, type ResourceHandlers } from "./resources-section.tsx";
const spec = presetDefinition({
  name: ResourceName.make("db"),
  preset: "postgres",
  version: PresetVersion.make("17"),
});
const entry: ResourceSettingView = {
  id: ResourceDefinitionId.make("db"),
  digest: ResourceSpecDigest.make("a".repeat(64)),
  spec,
  image: spec.image,
  addedBy: "alice",
  level: "project",
  worktreeId: null,
  choice: "project",
  canRemove: true,
  canChoose: true,
  canLoadOwn: false,
  instance: "running",
  statusLine: "@db · running · project · shared database · observed 3 s ago",
};
const handlers: ResourceHandlers = {
  control: () => {},
  choose: () => {},
  remove: () => {},
  reload: () => {},
};
const render = (page: ResourcesPageView, notes = new Map()) =>
  renderToStaticMarkup(
    <ResourcesView
      page={page}
      worktreeId={WorktreeId.make("wt")}
      worktreeName="checkout"
      busy={new Map()}
      notes={notes}
      handlers={handlers}
    />,
  );
const show = (read: Parameters<typeof ReadState>[0]["read"]) =>
  renderToStaticMarkup(
    <ReadState read={read} worktreeName={null} onRetry={() => {}}>
      {() => "loaded"}
    </ReadState>,
  );
describe("resource levels on the page", () => {
  it("shows status verbatim with explicit level starts, choices and instance removal", () => {
    const html = render({ settings: [entry], file: { kind: "not-selected" } });
    expect(html).toContain(entry.statusLine);
    expect(html).toContain("start project");
    expect(html).toContain("start worktree");
    expect(html).toContain("shared database");
    expect(html).toContain("own database");
    expect(html).toContain("remove project");
    expect(html).not.toContain("add a resource");
  });
  it("offers file definitions as explicit starts", () => {
    const html = render({
      settings: [],
      file: {
        kind: "read",
        worktreeId: WorktreeId.make("wt"),
        observed: "worktree",
        tables: [
          {
            spec,
            digest: entry.digest,
            statusLine: "@db · postgres:17 · in .mend/mend.toml · not started",
          },
        ],
        refused: [],
        ignored: [],
      },
    });
    expect(html).toContain("start project");
    expect(html).toContain("start worktree");
    expect(html).not.toContain("add to settings");
  });
  it("shows restart outcome and an explicit restart action", () => {
    const html = render(
      { settings: [entry], file: { kind: "not-selected" } },
      new Map([
        [
          "s:db:project",
          {
            refused: true,
            lines: ["definition differs from this worktree"],
            reload: false,
            restartLevel: "project",
          },
        ],
      ]),
    );
    expect(html).toContain("definition differs from this worktree");
    expect(html).toContain("restart with this definition");
  });
  it("distinguishes a pending read from a failed read with retry", () => {
    expect(show({ kind: "pending" })).toContain("reading");
    expect(show({ kind: "failed", message: "unavailable" })).toContain("unavailable");
  });
});
