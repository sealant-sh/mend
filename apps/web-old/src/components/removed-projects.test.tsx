import { OrganizationId, ProjectId } from "@mend/domain";
import { RemovedProject } from "@mend/domain/workbench";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RemovedProjectRow } from "./removed-projects.tsx";

const project = new RemovedProject({
  id: ProjectId.make("p1"),
  name: "api",
  organizationId: OrganizationId.make("org"),
  visibility: "shared",
  createdByUserId: "alice",
  removedAt: new Date("2026-10-30T00:00:00Z"),
  removedByUserId: "alice",
  state: "removed",
  rights: { restore: true, purge: true },
});
const action = async () => {};
describe("Removed projects", () => {
  it("offers Restore and a separate purge, and tells people their history is kept", () => {
    const html = renderToStaticMarkup(
      <RemovedProjectRow project={project} restore={action} purge={action} />,
    );
    expect(html).toContain("Restore");
    expect(html).toContain("Purge");
    expect(html).toContain("Files and history are kept");
  });
  it("shows a shared member the removed project without restore or purge controls", () => {
    const html = renderToStaticMarkup(
      <RemovedProjectRow
        project={new RemovedProject({ ...project, rights: { restore: false, purge: false } })}
        restore={action}
        purge={action}
      />,
    );
    expect(html).toContain("An organization owner can restore");
    expect(html).not.toContain("<button");
  });
});
