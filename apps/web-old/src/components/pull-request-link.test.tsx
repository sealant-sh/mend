import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PullRequestLink } from "./pull-request-link.tsx";

const pullRequest = {
  number: 412,
  url: "https://github.com/acme/api/pull/412",
  state: "open" as const,
  title: "Fix the login flake",
  observedAt: new Date("2026-10-03T09:00:00Z"),
  adopted: true,
};

describe("PullRequestLink", () => {
  it("leaves for GitHub in a new tab with the number, the state and the title", () => {
    const markup = renderToStaticMarkup(<PullRequestLink pullRequest={pullRequest} />);
    expect(markup).toContain('href="https://github.com/acme/api/pull/412"');
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noreferrer"');
    expect(markup).toContain("#412 · open");
    expect(markup).toContain("Fix the login flake");
    expect(markup).toContain("opened outside Mend");
  });

  it("says only the number and state when Mend never kept the title", () => {
    const markup = renderToStaticMarkup(
      <PullRequestLink
        pullRequest={{ ...pullRequest, title: null, state: "merged", adopted: false }}
      />,
    );
    expect(markup).toContain("merged");
    expect(markup).not.toContain("Fix the login flake");
    expect(markup).not.toContain("opened outside Mend");
  });
});
