import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { fingerprint } from "./handoff-test-fixtures.ts";
import { handoffCommand, type HandoffDeps } from "./handoff.ts";
import {
  FILE_BYTES,
  mainHandoffFixtures,
  newsroom,
  OLD_SERVER,
  ORIGIN,
  project,
  received,
} from "./main-handoff-test-fixtures.ts";

const { handoffServer, json, run, spawning, world } = mainHandoffFixtures();

const capture = () => {
  const out: Array<string> = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  return out;
};

describe("mend handoff", spawning, () => {
  it("refuses what the checkout or the server would refuse before it offers to adopt", async () => {
    const w = world();
    const unborn = path.join(w.root, "unborn");
    w.git(w.root, ["init", "-q", "-b", "main", unborn]);
    w.git(unborn, ["remote", "add", "origin", ORIGIN]);

    const conflicted = newsroom(w, "conflicted");
    w.git(conflicted, ["stash", "-q", "-u"]);
    w.git(conflicted, ["switch", "-q", "-c", "theirs", "origin/main"]);
    w.write(path.join(conflicted, "a.txt"), "theirs\n");
    w.git(conflicted, ["commit", "-q", "-am", "theirs"]);
    expect(() => w.git(conflicted, ["merge", "-q", "fix/login"])).toThrow();

    const nothingFetched = newsroom(w, "nothing-fetched");
    w.git(nothingFetched, ["update-ref", "-d", "refs/remotes/origin/main"]);

    const otherDefault = newsroom(w, "other-default");
    w.git(otherDefault, ["update-ref", "refs/remotes/origin/trunk", "refs/remotes/origin/main"]);
    w.git(otherDefault, ["update-ref", "-d", "refs/remotes/origin/main"]);
    w.git(otherDefault, ["remote", "set-head", "origin", "-d"]);

    const cases: ReadonlyArray<readonly [string, string, "bind" | "sources"]> = [
      [
        unborn,
        "this branch has no commit yet · commit once, then hand off · nothing was created",
        "sources",
      ],
      [
        conflicted,
        "1 unmerged path · finish or abort the merge, then hand off · nothing was created",
        "sources",
      ],
      [
        nothingFetched,
        "this checkout has fetched no branch from origin · run git fetch origin, then hand off again · nothing was created",
        "sources",
      ],
      [
        otherDefault,
        "this checkout does not know origin's default branch · run git fetch origin && git remote set-head origin -a, then hand off again · nothing was created",
        "sources",
      ],
      [
        newsroom(w, "co-located"),
        "this server keeps worktrees in the co-located store, which takes no handoffs · the operator can unset MEND_SESSION_STORE to run the capture store · nothing was created",
        "bind",
      ],
    ];
    for (const [checkout, words, mountDelivery] of cases) {
      const before = fingerprint(checkout);
      const server = await handoffServer({ projects: [], mountDelivery });
      const result = await run(server, ["--yes"], checkout);
      expect(result.stderr).toBe(`mend: ${words}\n`);
      expect(result.code).toBe(1);
      expect(server.adoptions).toEqual([]);
      expect(server.routes.filter((route) => route.startsWith("POST"))).toEqual([]);
      expect(fingerprint(checkout)).toEqual(before);
    }
  }, 60_000);

  it("reads origin's default branch from its branches when origin/HEAD dangles or was never set", async () => {
    const w = world();
    w.git(w.origin, ["branch", "-m", "main", "master"]);
    w.git(w.origin, ["symbolic-ref", "HEAD", "refs/heads/master"]);
    const renamed = newsroom(w, "renamed");
    w.git(w.origin, ["branch", "-m", "master", "main"]);
    w.git(w.origin, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    w.git(renamed, ["remote", "set-url", "origin", w.origin]);
    w.git(renamed, ["fetch", "-q", "--prune", "origin"]);
    w.git(renamed, ["remote", "set-url", "origin", ORIGIN]);
    expect(w.git(renamed, ["symbolic-ref", "refs/remotes/origin/HEAD"])).toBe(
      "refs/remotes/origin/master",
    );
    expect(w.git(renamed, ["for-each-ref", "refs/remotes/origin/master"])).toBe("");

    const unset = newsroom(w, "unset");
    w.git(unset, ["remote", "set-head", "origin", "-d"]);

    for (const checkout of [renamed, unset]) {
      const before = fingerprint(checkout);
      const server = await handoffServer({ projects: [] });
      const result = await run(server, ["--yes"], checkout);
      expect(result.code, result.stderr).toBe(0);
      expect(server.adoptions).toHaveLength(1);
      expect(result.stdout).toContain(
        `  base main ${w.git(checkout, ["merge-base", "HEAD", "origin/main"]).slice(0, 7)}`,
      );
      expect(fingerprint(checkout)).toEqual(before);
    }
  }, 30_000);

  it("leaves an unadopted sparse-index checkout byte-identical through the checks before adoption", async () => {
    const w = world();
    const dana = w.clone("sparse-api");
    w.git(dana, ["remote", "set-url", "origin", ORIGIN]);
    w.git(dana, ["sparse-checkout", "set", "--cone", "docs"]);
    w.git(dana, ["config", "index.sparse", "true"]);
    w.git(dana, ["sparse-checkout", "reapply"]);
    w.write(path.join(dana, "docs/guide.md"), "guide, edited\n");
    const before = fingerprint(dana);
    const refusing = await handoffServer({ projects: [] });
    const refused = await run(refusing, [], dana);
    expect(refused.stderr).toBe(
      "mend: non-interactive · pass --yes to adopt github.com/acme/newsroom-api and hand off · nothing was created\n",
    );
    expect(fingerprint(dana)).toEqual(before);
    const adopting = await handoffServer({ projects: [] });
    const adopted = await run(adopting, ["--yes"], dana);
    expect(adopted.code, adopted.stderr).toBe(0);
    expect(adopting.adoptions).toHaveLength(1);
    expect(fingerprint(dana)).toEqual(before);
  }, 30_000);

  it("says what it adopted when a refusal comes after the adoption", async () => {
    const w = world();
    const dana = newsroom(w);
    const server = await handoffServer({
      projects: [],
      terms: (response) => json(response, { bundleBytes: 100, fileBytes: FILE_BYTES }),
    });
    const result = await run(server, ["--yes"], dana);
    expect(result.code).toBe(1);
    expect(server.adoptions).toHaveLength(1);
    expect(result.stderr).toMatch(
      /^mend: handoff not sent · the bundle is .+ · nothing was handed off · newsroom-api stays adopted\n$/u,
    );
  }, 30_000);

  it("offers to adopt the origin; without a terminal it needs --yes", async () => {
    const w = world();
    const dana = newsroom(w);
    const refused = await handoffServer({ projects: [] });
    const result = await run(refused, [], dana);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(
      "mend: non-interactive · pass --yes to adopt github.com/acme/newsroom-api and hand off · nothing was created\n",
    );
    expect(refused.routes.filter((route) => route.startsWith("POST"))).toEqual([]);

    const adopting = await handoffServer({ projects: [] });
    const adopted = await run(adopting, ["--yes"], dana);
    expect(adopted.code, adopted.stderr).toBe(0);
    expect(adopting.adoptions).toEqual([{ name: "newsroom-api", source: ORIGIN }]);
    expect(adopted.stdout).toContain("✓ adopted · newsroom-api");
    expect(adopted.stdout).toContain("✓ handed off as fix-login");

    const old = await handoffServer({
      projects: [],
      terms: (response) => response.writeHead(404).end(),
    });
    const before = await run(old, ["--yes"], dana);
    expect(before.stderr).toBe(OLD_SERVER);
    expect(old.routes.filter((route) => route.startsWith("POST"))).toEqual([]);
  }, 30_000);
});

const inProcess = (projects: ReadonlyArray<unknown>) => {
  const calls: Array<string> = [];
  const deps: HandoffDeps = {
    api: async (method, route) => {
      calls.push(`${method} ${route}`);
      const answer: unknown = route === "/projects" && method === "GET" ? projects : project;
      return JSON.parse(JSON.stringify(answer));
    },
    download: async (route) => {
      calls.push(`GET ${route}`);
      const known = route === `/projects/${project.id}/handoffs`;
      const body = known
        ? { bundleBytes: 64 * 1024 * 1024, fileBytes: FILE_BYTES }
        : { _tag: "NotFound", id: "handoff-probe" };
      return {
        status: known ? 200 : 404,
        header: () => null,
        bytes: new TextEncoder().encode(JSON.stringify(body)),
      };
    },
    upload: async (route) => {
      calls.push(`POST ${route}`);
      return {
        _tag: "answered",
        status: 200,
        header: () => null,
        bytes: new TextEncoder().encode(JSON.stringify(received())),
      };
    },
    serverVersion: async () => "0.36.0",
    launch: async () => ({ _tag: "running" }),
    spin: (_label, work) => work,
    serverUrl: "http://localhost:3105",
  };
  return { calls, deps };
};

describe("mend handoff's adoption offer at a terminal", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("gives Ctrl-C back when its scratch directory cannot be made", async () => {
    const w = world();
    const dana = newsroom(w);
    capture();
    const signals = ["SIGHUP", "SIGINT", "SIGTERM"] as const;
    const before = signals.map((signal) => process.listenerCount(signal));
    vi.stubEnv("TMPDIR", path.join(w.root, "no-such-dir"));
    try {
      await expect(
        handoffCommand(inProcess([project]).deps, [], dana, {
          interactive: false,
          ask: async () => false,
        }),
      ).rejects.toThrow(/ENOENT/u);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(signals.map((signal) => process.listenerCount(signal))).toEqual(before);
  });

  it("paints its marks with escape sequences at a terminal", async () => {
    const w = world();
    const dana = newsroom(w);
    const out = capture();
    const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    try {
      await handoffCommand(inProcess([project]).deps, [], dana, {
        interactive: true,
        ask: async () => true,
      });
    } finally {
      if (tty === undefined) Reflect.deleteProperty(process.stdout, "isTTY");
      else Object.defineProperty(process.stdout, "isTTY", tty);
    }
    const text = out.join("");
    expect(text).toContain("\u001b[32m✓\u001b[0m handed off as fix-login");
    expect(text).toContain("\u001b[2m  attach\u001b[0m · mend attach 3f2a1c0d");
    expect(text.replaceAll("\u001b[", "")).not.toMatch(/\[\d+m/u);
  });

  for (const answer of [true, false]) {
    it(`adopts and hands off only on yes (answer: ${String(answer)})`, async () => {
      const w = world();
      const dana = newsroom(w);
      const out = capture();
      const { calls, deps } = inProcess([]);
      const asked: Array<string> = [];
      await handoffCommand(deps, [], dana, {
        interactive: true,
        ask: async (question) => {
          asked.push(question);
          return answer;
        },
      });
      expect(asked).toEqual(["adopt github.com/acme/newsroom-api as newsroom-api and hand off?"]);
      const posts = calls.filter((call) => call.startsWith("POST"));
      if (answer) {
        expect(posts).toEqual([
          "POST /projects",
          `POST /projects/${project.id}/handoffs?harness=claude&hold=true`,
        ]);
        expect(out.join("")).toContain("✓ handed off as fix-login");
      } else {
        expect(posts).toEqual([]);
        expect(out.join("")).toBe("nothing was adopted or handed off\n");
      }
    });
  }
});
