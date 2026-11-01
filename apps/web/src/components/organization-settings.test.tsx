import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  REMOVAL_FACTS,
  RemovalConfirmation,
  ResourceArchivesList,
} from "./organization-settings.tsx";

const render = (self: boolean) =>
  renderToStaticMarkup(
    <RemovalConfirmation
      member={{ userId: "carol", name: "Carol" }}
      organizationName="Acme"
      self={self}
      pending={false}
      onConfirm={() => undefined}
      onCancel={() => undefined}
    />,
  );

describe("removing a member", () => {
  it("states what removal does before it happens, in a labelled group", () => {
    const markup = render(false);
    expect(markup).toContain('role="group"');
    expect(markup).toContain('aria-labelledby="remove-carol"');
    expect(markup).toContain("Remove Carol?");
    for (const fact of REMOVAL_FACTS) expect(markup).toContain(fact.replaceAll("'", "&#x27;"));
  });

  it("asks to leave when the member is you", () => {
    const markup = render(true);
    expect(markup).toContain("Leave Acme?");
    expect(markup).toContain("Leave Acme</button>");
  });
});

describe("archived resources", () => {
  it("names the kept volume, its resource, measured size and archive date", () => {
    const markup = renderToStaticMarkup(
      <ResourceArchivesList
        archives={[
          {
            projectId: "p-old",
            projectName: "api",
            createdByUserId: "alice",
            archivedAt: "2026-10-31T14:02:00Z",
            volumes: [
              {
                instanceKey: "db",
                resourceName: "db",
                name: "data",
                dockerName: "kept-db-data",
                bytes: 4096,
              },
              {
                instanceKey: "mail",
                resourceName: "mail",
                name: "mail",
                dockerName: "kept-mail",
                bytes: null,
              },
            ],
          },
        ]}
      />,
    );
    for (const text of [
      "api",
      "@db",
      "kept-db-data",
      "4.0 KiB",
      "2026-10-31 14:02 UTC",
      "size not observed",
    ])
      expect(markup).toContain(text);
    expect(markup).not.toContain("<button");
  });
  it("says when no archive exists", () => {
    expect(renderToStaticMarkup(<ResourceArchivesList archives={[]} />)).toContain(
      "No archived resources.",
    );
  });
});
