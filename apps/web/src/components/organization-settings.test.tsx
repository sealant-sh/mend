import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { REMOVAL_FACTS, RemovalConfirmation } from "./organization-settings.tsx";

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
