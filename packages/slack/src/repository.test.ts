import { describe, expect, it } from "vitest";

import {
  parseRepositoryOption,
  parseRepositoryUrl,
  projectsForRepository,
  projectsLinkedIn,
  projectsNamedBy,
  repositoryReferences,
} from "./repository.ts";

const acmeApi = { host: "github.com", path: "acme/api" };

describe("reading a repository from a URL", () => {
  it("reads GitHub web URLs of a repository and of anything in it", () => {
    for (const url of [
      "https://github.com/acme/api",
      "https://github.com/Acme/API/",
      "https://www.github.com/acme/api/pull/12",
      "https://github.com/acme/api/pull/12/files#diff-1",
      "https://github.com/acme/api/issues/7",
      "https://github.com/acme/api/commit/0a1b2c3",
      "https://github.com/acme/api/blob/main/src/index.ts#L10-L20",
      "https://github.com/acme/api/tree/release/2.3/docs",
      "http://github.com/acme/api?tab=readme",
    ]) {
      expect(parseRepositoryUrl(url), url).toEqual(acmeApi);
    }
  });

  it("reads clone URLs, over ssh or https, with or without .git", () => {
    for (const url of [
      "git@github.com:acme/api.git",
      "git@github.com:Acme/Api",
      "ssh://git@github.com/acme/api.git",
      "ssh://git@github.com:22/acme/api.git",
      "https://github.com/acme/api.git",
      "https://x-access-token:secret@github.com/acme/api.git",
      "git://github.com/acme/api",
    ]) {
      expect(parseRepositoryUrl(url), url).toEqual(acmeApi);
    }
  });

  it("reads GitLab's nested groups and stops at its own pages", () => {
    const platform = { host: "gitlab.com", path: "acme/platform/billing" };
    for (const url of [
      "https://gitlab.com/acme/platform/billing",
      "https://gitlab.com/acme/platform/billing/-/merge_requests/4",
      "https://gitlab.com/acme/platform/billing/-/blob/main/README.md",
      "https://gitlab.com/acme/platform/billing/merge_requests/4",
      "git@gitlab.com:acme/platform/billing.git",
    ]) {
      expect(parseRepositoryUrl(url), url).toEqual(platform);
    }
  });

  it("reads a self-hosted host by the same rules", () => {
    expect(parseRepositoryUrl("https://git.acme.dev:8443/team/api/-/issues/3")).toEqual({
      host: "git.acme.dev",
      path: "team/api",
    });
    expect(parseRepositoryUrl("https://github.acme.dev/team/api/pull/9")).toEqual({
      host: "github.acme.dev",
      path: "team/api",
    });
  });

  it("names nothing for GitHub's own pages, local paths and non-URLs", () => {
    for (const url of [
      "https://github.com/orgs/acme/projects",
      "https://github.com/settings/tokens",
      "https://github.com/acme",
      "/srv/repos/api.git",
      "file:///srv/repos/api.git",
      "acme/api",
      "https://localhost/acme/api",
    ]) {
      expect(parseRepositoryUrl(url), url).toBeNull();
    }
  });

  it("reads a bare owner/name only as an option value", () => {
    expect(parseRepositoryOption("Acme/API")).toEqual({ host: null, path: "acme/api" });
    expect(parseRepositoryOption("acme/platform/billing.git")).toEqual({
      host: null,
      path: "acme/platform/billing",
    });
    expect(parseRepositoryOption("billing-api")).toBeNull();
    expect(parseRepositoryOption("../api")).toBeNull();
    expect(repositoryReferences("see acme/api for details")).toEqual([]);
  });
});

describe("finding repositories in a thread", () => {
  it("finds GitHub and GitLab links in prose, in order, without repeats", () => {
    const text = [
      "The login test flakes: https://github.com/acme/api/pull/12.",
      "Same thing in (https://gitlab.com/acme/platform/billing/-/issues/3)",
      "and github.com/acme/api/issues/9, clone git@github.com:acme/web.git",
      "not https://example.com/acme/api or https://docs.github.com/en/actions",
    ].join("\n");
    expect(repositoryReferences(text)).toEqual([
      acmeApi,
      { host: "gitlab.com", path: "acme/platform/billing" },
      { host: "github.com", path: "acme/web" },
    ]);
  });

  it("reads a self-hosted host only when the caller names it", () => {
    const text = "https://git.acme.dev/team/api/-/merge_requests/1";
    expect(repositoryReferences(text)).toEqual([]);
    expect(repositoryReferences(text, ["git.acme.dev"])).toEqual([
      { host: "git.acme.dev", path: "team/api" },
    ]);
  });
});

describe("matching a repository to a project's origin", () => {
  const projects = [
    { id: "p1", name: "billing-api", originUrl: "git@github.com:Acme/Billing-API.git" },
    { id: "p2", name: "web", originUrl: "https://github.com/acme/web" },
    { id: "p3", name: "internal", originUrl: "ssh://git@git.acme.dev:2222/team/internal.git" },
    { id: "p4", name: "scratch", originUrl: null },
    { id: "p5", name: "Billing API Docs", originUrl: "https://gitlab.com/acme/docs" },
  ];

  it("matches over ssh or https, with or without .git, ignoring case", () => {
    expect(
      projectsForRepository({ host: "github.com", path: "acme/billing-api" }, projects).map(
        (project) => project.id,
      ),
    ).toEqual(["p1"]);
    expect(
      projectsForRepository({ host: "gitlab.com", path: "acme/billing-api" }, projects),
    ).toEqual([]);
    expect(
      projectsForRepository({ host: null, path: "team/internal" }, projects).map(
        (project) => project.id,
      ),
    ).toEqual(["p3"]);
  });

  it("finds the projects a thread links to, including self-hosted ones", () => {
    const text =
      "Broken since https://github.com/acme/billing-api/commit/abc and https://git.acme.dev/team/internal/-/issues/2, see https://github.com/acme/billing-api/pull/3";
    expect(projectsLinkedIn(text, projects).map((project) => project.id)).toEqual(["p1", "p3"]);
  });

  it("names a project by name, loosely by name, then by repository", () => {
    const ids = (value: string) => projectsNamedBy(value, projects).map((project) => project.id);
    expect(ids("billing-api")).toEqual(["p1"]);
    expect(ids("WEB")).toEqual(["p2"]);
    expect(ids("billing api docs")).toEqual(["p5"]);
    expect(ids("billing_api")).toEqual(["p1"]);
    expect(ids("acme/web")).toEqual(["p2"]);
    expect(ids("https://github.com/acme/billing-api/pull/3")).toEqual(["p1"]);
    expect(ids("nothing")).toEqual([]);
    expect(ids(" ")).toEqual([]);
  });
});
