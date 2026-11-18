import { describe, expect, it } from "vitest";

import {
  alreadyAdded,
  cloneUrlOf,
  inferName,
  matchesFilter,
  matchesQuery,
  nameIssue,
  openSessionCounts,
  pushedAgo,
  repositoriesMatching,
  repositoryName,
  repositoryWords,
  searchesOnPage,
  shortOrigin,
  sourceIssue,
  visibleToWords,
} from "#/lib/projects";

const project = {
  name: "mend",
  originUrl: "git@github.com:sealant-sh/mend.git",
  storePath: "/var/lib/mend/store/9c1/repo.git",
};

describe("the Projects list", () => {
  it("counts each project's open sessions, and nothing before the sessions are read", () => {
    expect(openSessionCounts(undefined)).toBeUndefined();
    const counts = openSessionCounts([
      { projectId: "a", status: "running" },
      { projectId: "a", status: "waiting" },
      { projectId: "a", status: "idle" },
      { projectId: "a", status: "starting" },
      { projectId: "a", status: "completed" },
      { projectId: "a", status: "failed" },
      { projectId: "b", status: "stopped" },
    ]);
    expect(counts?.get("a")).toBe(4);
    expect(counts?.get("b")).toBeUndefined();
  });

  it.each(["mend", " MEND ", "SEALANT-SH", "store/9c1", ""])(
    "finds a project by its name, repository or store path: %j",
    (query) => expect(matchesQuery(project, query)).toBe(true),
  );

  it("finds nothing for a word none of them hold, and no repository in one made in Mend", () => {
    expect(matchesQuery(project, "checkout")).toBe(false);
    expect(matchesQuery({ ...project, originUrl: null }, "github")).toBe(false);
  });

  it("filters by who can see a project", () => {
    expect(matchesFilter({ visibility: "shared" }, "all")).toBe(true);
    expect(matchesFilter({ visibility: "shared" }, "private")).toBe(false);
    expect(matchesFilter({ visibility: "private" }, "private")).toBe(true);
    expect(visibleToWords("shared", "Northwind")).toBe("Everyone in Northwind");
    expect(visibleToWords("private", "Northwind")).toBe("Only you");
  });

  it.each([
    ["git@github.com:sealant-sh/mend.git", "github.com/sealant-sh/mend"],
    ["https://github.com/sealant-sh/mend.git/", "github.com/sealant-sh/mend"],
    ["ssh://git@git.example.com:2222/team/repo.git", "git.example.com:2222/team/repo"],
  ])("names the repository %s without its transport", (origin, short) => {
    expect(shortOrigin(origin)).toBe(short);
  });

  it("names a repository by owner and name in a sentence, and says when there is none", () => {
    expect(repositoryName("git@github.com:northwind/ledger.git")).toBe("northwind/ledger");
    expect(repositoryName("https://git.example.com/team/sub/repo")).toBe("team/sub/repo");
    expect(repositoryWords({ originUrl: null })).toBe("No repository");
  });
});

const repository = (visibility: string) => ({
  nameWithOwner: "northwind/ledger",
  visibility,
  pushedAt: null,
});

describe("adding a project", () => {
  it("clones a public repository over HTTPS and a private one over SSH, which a key can read", () => {
    expect(cloneUrlOf(repository("PUBLIC"))).toBe("https://github.com/northwind/ledger");
    expect(cloneUrlOf(repository("PRIVATE"))).toBe("git@github.com:northwind/ledger.git");
  });

  it("knows a repository that is already a project, whatever address it was added from", () => {
    const projects = [{ originUrl: "https://github.com/Northwind/Ledger.git" }];
    expect(alreadyAdded(repository("PRIVATE"), projects)).toBe(true);
    expect(
      alreadyAdded({ ...repository("PRIVATE"), nameWithOwner: "northwind/web" }, projects),
    ).toBe(false);
  });

  it("suggests a name a project may have, from any form of address", () => {
    expect(inferName("git@github.com:sealant-sh/mend.git")).toBe("mend");
    expect(inferName("https://github.com/northwind/Checkout_API/")).toBe("checkout_api");
    expect(inferName("https://example.com/team/My Repo")).toBe("my-repo");
    expect(inferName("")).toBe("");
  });

  it("says why a name won't do", () => {
    const projects = [{ name: "ledger" }];
    expect(nameIssue("billing", projects, "Northwind")).toBeNull();
    expect(nameIssue("", projects, "Northwind")).toBe("Give the project a name.");
    expect(nameIssue("Billing", projects, "Northwind")).toMatch(/^Use lowercase letters/);
    expect(nameIssue("ledger", projects, "Northwind")).toBe(
      "Northwind already has a project named ledger.",
    );
  });

  it("refuses an address Mend can't clone, with Mend's reason, and says nothing while it is empty", () => {
    expect(sourceIssue("")).toBeNull();
    expect(sourceIssue("https://github.com/northwind/ledger")).toBeNull();
    expect(sourceIssue("/tmp/not-a-url")).toMatch(/Local paths/);
  });
});

const onGithub = (nameWithOwner: string) => ({
  nameWithOwner,
  visibility: "private",
  pushedAt: null,
});

describe("picking a repository at setup", () => {
  const listed = [onGithub("northwind/checkout-api"), onGithub("northwind/web")];

  it("filters the listed repositories by owner and name, ignoring case and spaces", () => {
    expect(repositoriesMatching(listed, " Checkout ")).toEqual([listed[0]]);
    expect(repositoriesMatching(listed, "northwind/WEB")).toEqual([listed[1]]);
    expect(repositoriesMatching(listed, "")).toEqual(listed);
  });

  it("searches on the page only while the server's list is shorter than its limit", () => {
    expect(searchesOnPage(29)).toBe(true);
    expect(searchesOnPage(30)).toBe(false);
  });

  it("says when the repository was last pushed, as the frames do", () => {
    const now = new Date("2026-11-18T12:00:00Z");
    const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
    expect(pushedAgo(ago(0.5), now)).toBe("Pushed just now");
    expect(pushedAgo(ago(20), now)).toBe("Pushed 20m ago");
    expect(pushedAgo(ago(150), now)).toBe("Pushed 2h ago");
    expect(pushedAgo(ago(30 * 60), now)).toBe("Pushed yesterday");
    expect(pushedAgo(ago(3 * 24 * 60), now)).toBe("Pushed 3 days ago");
    expect(pushedAgo(ago(15 * 24 * 60), now)).toBe("Pushed 2 weeks ago");
    expect(pushedAgo(ago(90 * 24 * 60), now)).toBe("Pushed 3 months ago");
    expect(pushedAgo(ago(400 * 24 * 60), now)).toBe("Pushed 1 year ago");
    expect(pushedAgo(null, now)).toBe("");
  });
});
