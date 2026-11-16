import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  type ConversationArchiveHeader,
  decodeConversationArchive,
  isImportedConversationPath,
} from "@mend/domain/workbench";
import { fingerprint, handoffWorlds } from "@mend/local-git/testing";
import { Result } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProjectDto } from "./handoff.ts";
import { importT3Command, type ImportT3Deps } from "./import-t3.ts";
import type { Downloaded } from "./landing.ts";
import { MendRequestError } from "./server-request.ts";
import { claudeId, codexId, t3Machine, write } from "./test/t3-machine.ts";

const gitWorld = handoffWorlds();

const MiB = 1024 * 1024;

const sessionId = (n: number) => `${String(n).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;

interface Imported {
  readonly projectId: string;
  readonly query: string;
  readonly header: ConversationArchiveHeader;
  readonly files: Readonly<Record<string, string>>;
  readonly sessionId: string;
}

interface FakeOptions {
  readonly conversationBytes?: number | null;
  readonly projects?: ReadonlyArray<ProjectDto>;
  /** A thread's conversation the server refuses, by native id, with these words. */
  readonly refuse?: Readonly<Record<string, string>>;
  /** Handoffs into a project the server refuses, by project id, with these words. */
  readonly refuseHandoff?: Readonly<Record<string, string>>;
  readonly branches?: ReadonlyArray<string>;
  /** Conversations an earlier run imported: `<projectId>:<harness>:<nativeId>` to its session. */
  readonly imported?: Readonly<Record<string, string>>;
}

const answer = (status: number, body: unknown): Downloaded => ({
  status,
  header: () => null,
  bytes: new TextEncoder().encode(JSON.stringify(body)),
});

const text = (value: unknown, key: string): string => {
  const field = typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
  return typeof field === "string" ? field : "";
};

/**
 * Mend's server as the import reaches it, in memory and faithful to the routes' contract: an
 * archive is decoded, each file's digest and path checked, a repeat of the same native
 * conversation answered with its first session, and a session that holds one refused another.
 */
const fakeMend = (options: FakeOptions = {}) => {
  const projects: Array<ProjectDto> = [...(options.projects ?? [])];
  const routes: Array<string> = [];
  const handoffs: Array<{ readonly projectId: string; readonly query: string }> = [];
  const imports: Array<Imported> = [];
  const created: Array<{ readonly projectId: string; readonly body: unknown }> = [];
  const worktreeOf = new Map<string, string>();
  const harnessOf = new Map<string, string>();
  const holding = new Set<string>();
  const byNative = new Map<string, string>(Object.entries(options.imported ?? {}));
  let sessions = 0;
  let worktrees = 0;
  // Once set, a handoff answers with its project's first worktree, as an unchanged checkout does.
  const behaviour = { replayHandoffs: false };
  const newSession = (worktreeId: string, harness: string): string => {
    sessions += 1;
    const id = sessionId(sessions);
    worktreeOf.set(id, worktreeId);
    harnessOf.set(id, harness);
    return id;
  };
  const refused = (reason: string, message: string) =>
    answer(422, { _tag: "ConversationImportRefused", reason, message });

  const receiveConversation = (route: string, body: Uint8Array): Downloaded => {
    const [, projectId, query] = /^\/projects\/([^/]+)\/conversations\?(.*)$/u.exec(route) ?? [];
    if (projectId === undefined || query === undefined) return answer(404, {});
    const decoded = decodeConversationArchive(body);
    if (Result.isFailure(decoded)) return refused("damaged", decoded.failure);
    const { header, entries } = decoded.success;
    for (const [index, entry] of entries.entries()) {
      const digest = createHash("sha256").update(entry.bytes).digest("hex");
      if (digest !== header.files[index]?.sha256) return refused("damaged", "a digest differs");
      if (!isImportedConversationPath(header.harness, entry.relativePath))
        return refused("path-not-allowed", `${entry.relativePath} is not a conversation file`);
    }
    const refusal = options.refuse?.[header.nativeId];
    if (refusal !== undefined) return refused("transcript-invalid", refusal);
    const key = `${projectId}:${header.harness}:${header.nativeId}`;
    const earlier = byNative.get(key);
    if (earlier !== undefined)
      return answer(200, { session: { id: earlier }, replayed: true, turns: 1 });
    const params = new URLSearchParams(query);
    const target = params.get("session");
    let id: string;
    if (target !== null) {
      if (holding.has(target))
        return refused("session-holds-another", `session ${target} already holds another`);
      if (harnessOf.get(target) !== header.harness)
        return refused("harness-mismatch", `session ${target} runs ${harnessOf.get(target)}`);
      id = target;
    } else id = newSession(params.get("worktree") ?? "", header.harness);
    holding.add(id);
    byNative.set(key, id);
    imports.push({
      projectId,
      query,
      header,
      files: Object.fromEntries(
        entries.map((entry) => [entry.relativePath, new TextDecoder().decode(entry.bytes)]),
      ),
      sessionId: id,
    });
    const transcript = entries[0] === undefined ? "" : new TextDecoder().decode(entries[0].bytes);
    return answer(200, {
      session: { id, worktreeId: worktreeOf.get(id) },
      replayed: false,
      turns: transcript.split("\n").filter((line) => line !== "").length,
    });
  };

  const receiveHandoff = (route: string): Downloaded => {
    const [, projectId, query] = /^\/projects\/([^/]+)\/handoffs\?(.*)$/u.exec(route) ?? [];
    if (projectId === undefined || query === undefined) return answer(404, {});
    const refusal = options.refuseHandoff?.[projectId];
    if (refusal !== undefined) return answer(422, { _tag: "HandoffRefused", message: refusal });
    handoffs.push({ projectId, query });
    const harness = new URLSearchParams(query).get("harness") ?? "claude";
    if (behaviour.replayHandoffs) {
      const worktreeId = `worktree-${projectId}-1`;
      const own = [...worktreeOf.entries()].filter(([, w]) => w === worktreeId).at(-1)?.[0];
      return answer(200, {
        session: { id: own ?? newSession(worktreeId, harness), status: "starting", summary: null },
        worktree: { id: worktreeId, name: "fix-login" },
        replayed: true,
        previous: null,
      });
    }
    worktrees += 1;
    const worktreeId = `worktree-${projectId}-${worktrees}`;
    return answer(200, {
      session: { id: newSession(worktreeId, harness), status: "starting", summary: null },
      worktree: { id: worktreeId, name: `fix-login-${worktrees}` },
      replayed: false,
      previous: null,
    });
  };

  const terms = {
    bundleBytes: 64 * MiB,
    fileBytes: 8 * MiB,
    ...(options.conversationBytes === null
      ? {}
      : { conversationBytes: options.conversationBytes ?? 64 * MiB }),
  };

  const deps: ImportT3Deps = {
    api: async <T>(method: string, route: string, body?: unknown): Promise<T> => {
      routes.push(`${method} ${route}`);
      const reply = ((): unknown => {
        if (method === "GET" && route === "/projects") return projects;
        if (method === "GET" && route === "/organization") return { mountDelivery: "sources" };
        if (method === "POST" && route === "/projects") {
          const name = text(body, "name");
          const source = text(body, "source");
          const project: ProjectDto = {
            id: `project-${name}`,
            name,
            originUrl: source,
            storePath: `/srv/mend/${name}/repo.git`,
            defaultBranch: "main",
            gitAuthMode: "mend-key",
          };
          projects.push(project);
          return project;
        }
        const lookup = /^\/projects\/([^/]+)\/conversations\?harness=(\w+)&nativeId=(.+)$/u.exec(
          route,
        );
        if (method === "GET" && lookup !== null) {
          const id = byNative.get(
            `${lookup[1]}:${lookup[2]}:${decodeURIComponent(lookup[3] ?? "")}`,
          );
          return { session: id === undefined ? null : { id } };
        }
        if (method === "POST" && /^\/projects\/[^/]+\/refresh$/u.test(route))
          return (options.branches ?? ["main"]).map((name) => ({ name }));
        const start = /^\/projects\/([^/]+)\/sessions$/u.exec(route);
        if (method === "POST" && start !== null) {
          created.push({ projectId: start[1] ?? "", body });
          worktrees += 1;
          const worktreeId = `worktree-new-${worktrees}`;
          const harness = text(body, "harness");
          return { id: newSession(worktreeId, harness), worktreeId, worktree: `w-${worktrees}` };
        }
        throw new MendRequestError("http", `no route ${method} ${route}`, 404, {
          call: `${method} ${route}`,
          tag: null,
        });
      })();
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the fake answers the shape each route's caller names
      return reply as T;
    },
    download: async (route) => {
      routes.push(`GET ${route}`);
      if (route === "/handoffs" || /^\/projects\/project-[^/]+\/handoffs$/u.test(route))
        return answer(200, terms);
      if (route === "/projects/handoff-probe/handoffs")
        return answer(404, { _tag: "NotFound", id: "handoff-probe" });
      return answer(404, {});
    },
    upload: async (route, _contentType, body) => {
      routes.push(`POST ${route}`);
      const reply = route.includes("/conversations?")
        ? receiveConversation(route, body)
        : receiveHandoff(route);
      return { _tag: "answered", ...reply };
    },
    serverVersion: async () => "0.36.0",
    spin: (_label, work) => work,
    serverUrl: "https://mend.example",
    accountGitAuthMode: async () => "mend-key",
    shareAgent: () => null,
  };
  return { deps, routes, handoffs, imports, created, projects, behaviour };
};

let stdout: Array<string> = [];
let stderr: Array<string> = [];
beforeEach(() => {
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

const out = () => stdout.join("").split("\n");

const ORIGIN = "https://github.com/ana/app.git";

/**
 * A person's machine: T3 Code's state, and checkouts of one origin cloned from a local bare
 * repository so a handoff can cut a real bundle.
 */
const person = () => {
  const t3 = t3Machine();
  const git = gitWorld();
  const checkout = (name: string, origin = ORIGIN): string => {
    const dir = git.clone(name);
    git.git(dir, ["remote", "set-url", "origin", origin]);
    git.git(dir, ["switch", "-q", "-c", `work/${name}`]);
    git.write(path.join(dir, "note.txt"), `${name}\n`);
    return fs.realpathSync(dir);
  };
  const claudeHome = path.join(t3.home, ".claude");
  const codexHome = path.join(t3.home, ".codex");
  /** A Claude conversation of `lines` turns that ran in `cwd`, with extra files. */
  const claude = (
    n: number,
    cwd: string,
    options: { readonly home?: string; readonly lines?: number; readonly text?: string } = {},
  ): string => {
    const id = claudeId(n);
    const home = options.home ?? claudeHome;
    const key = cwd.replace(/[^a-zA-Z0-9]/g, "-");
    const line = JSON.stringify({ type: "user", sessionId: id, cwd, text: options.text ?? "hi" });
    write(
      path.join(home, "projects", key, `${id}.jsonl`),
      `${Array.from({ length: options.lines ?? 2 }, () => line).join("\n")}\n`,
    );
    write(path.join(home, "projects", key, id, "tool-results", "t1.txt"), "out");
    write(path.join(home, "tasks", id, "1.json"), "{}");
    write(path.join(home, "tasks", id, ".lock"), "");
    return id;
  };
  const codex = (n: number): string => {
    const id = codexId(n);
    write(
      path.join(
        codexHome,
        "sessions",
        "2026",
        "11",
        "01",
        `rollout-2026-11-01T10-00-00-${id}.jsonl`,
      ),
      `${JSON.stringify({ type: "session_meta", payload: { id } })}\n{"type":"event_msg"}\n`,
    );
    return id;
  };
  const scan = { t3Home: t3.t3Home, homeDirectory: t3.home, environment: {} };
  const run = (
    fake: ReturnType<typeof fakeMend>,
    args: ReadonlyArray<string>,
    interactive = false,
  ) => importT3Command(fake.deps, args, scan, { interactive, ask: async () => true });
  return { t3, git, checkout, claude, codex, claudeHome, codexHome, run };
};

const claudeThread = (id: string, project: string, nativeId: string, extra = {}) => ({
  id,
  project,
  title: id,
  providers: [{ id: `pt-${id}`, driver: "claudeAgent", nativeId }],
  ...extra,
});

const codexThread = (id: string, project: string, nativeId: string, extra = {}) => ({
  id,
  project,
  title: id,
  providers: [{ id: `pt-${id}`, driver: "codex", nativeId }],
  ...extra,
});

describe("mend import t3 --dry-run", () => {
  it("prints the plan per project and sends nothing", async () => {
    const me = person();
    const app = me.checkout("app");
    const tree = me.checkout("app-tree");
    const plain = me.t3.repo("notes", null);
    me.t3.project("p-app", "app", app);
    me.t3.project("p-notes", "notes", plain);
    const known: ProjectDto = {
      id: "project-app",
      name: "app",
      originUrl: ORIGIN,
      storePath: "/srv/mend/app/repo.git",
      defaultBranch: "main",
      gitAuthMode: "mend-key",
    };
    const first = me.claude(1, app);
    const fake = fakeMend({
      projects: [known],
      conversationBytes: 1024,
      imported: { [`project-app:claude:${first}`]: sessionId(7) },
    });
    me.t3.thread(claudeThread("Fix the build", "p-app", first));
    me.t3.thread(codexThread("Add a check", "p-app", me.codex(2)));
    me.t3.thread(claudeThread("Huge", "p-app", me.claude(3, app, { text: "x".repeat(2048) })));
    me.t3.thread(
      claudeThread("In a worktree", "p-app", me.claude(4, tree), { worktreePath: tree }),
    );
    me.t3.thread(claudeThread("Notes", "p-notes", me.claude(5, plain)));

    expect(await me.run(fake, ["--dry-run"])).toBe(0);

    expect(out()).toEqual([
      "5 threads in T3 Code · conversations up to 1 KiB on this server",
      "",
      "app",
      `  ${app} · handed off once, your checkout unchanged · into project app`,
      expect.stringMatching(
        /^ {4}· Fix the build · claude · \d+ bytes · 1 file Mend does not take left behind · already imported as session 00000007$/u,
      ),
      expect.stringMatching(/^ {4}✓ Add a check · codex · \d+ bytes$/u),
      expect.stringMatching(
        /^ {4}! Huge · claude · \d\.\d KiB · 1 file Mend does not take left behind · over the server's 1 KiB limit, so it stays here; the server's operator can raise it with MEND_BUDGET_CONVERSATION_BYTES$/u,
      ),
      `  ${tree} · handed off once, your checkout unchanged · into project app`,
      expect.stringMatching(
        /^ {4}✓ In a worktree · claude · \d+ bytes · 1 file Mend does not take left behind$/u,
      ),
      "",
      "notes",
      "  stays in T3 Code",
      `    · Notes · ${plain} has no origin, so Mend cannot adopt it`,
      "",
      "dry run · 2 threads to import · 2 checkouts to hand off · 0 projects to adopt · nothing was sent",
      "",
    ]);
    expect(fake.routes.filter((route) => route.startsWith("POST"))).toEqual([]);
  });

  it("names the project it would adopt when none matches the checkout's origin", async () => {
    const me = person();
    const app = me.checkout("app");
    me.t3.project("p-app", "app", app);
    me.t3.thread(claudeThread("Fix", "p-app", me.claude(1, app)));
    const fake = fakeMend();

    expect(await me.run(fake, ["--dry-run"])).toBe(0);

    expect(out()).toContain(
      `  ${app} · handed off once, your checkout unchanged · adopts github.com/ana/app as app`,
    );
    expect(out()).toContain(
      "dry run · 1 thread to import · 1 checkout to hand off · 1 project to adopt · nothing was sent",
    );
    expect(fake.routes.filter((route) => route.startsWith("POST"))).toEqual([]);
  });
});

const query = (imported: Imported) => imported.query.replace(/=.*$/u, "");

describe("mend import t3", () => {
  it("hands a shared checkout off once and lands its threads in one worktree, whatever their harness", async () => {
    const me = person();
    const app = me.checkout("app");
    me.t3.project("p-app", "app", app);
    const codex = me.codex(1);
    write(path.join(me.claudeHome, "plans", "fix-the-build.md"), "# plan\n");
    write(path.join(me.claudeHome, "plans", "other-plan.md"), "# other\n");
    write(path.join(me.claudeHome, "plans", "not-named.md"), "# no\n");
    const claude = me.claude(2, app, {
      text: `wrote ~/.claude/plans/fix-the-build.md and ${me.claudeHome}/plans/other-plan.md, not ~/.claude/plans/gone-plan.md`,
    });
    me.t3.thread(codexThread("Codex first", "p-app", codex));
    me.t3.thread(
      claudeThread("Claude second", "p-app", claude, { runtimeMode: "approval-required" }),
    );
    const before = fingerprint(app);
    const fake = fakeMend();

    expect(await me.run(fake, ["--yes"])).toBe(0);

    expect(fingerprint(app)).toEqual(before);
    expect(fake.handoffs).toEqual([
      { projectId: "project-app", query: "harness=codex&hold=false" },
    ]);
    const [first, second] = fake.imports;
    if (first === undefined || second === undefined) throw new Error("two imports expected");
    expect(first.query).toBe(`session=${sessionId(1)}`);
    expect(second.query).toBe("worktree=worktree-project-app-1");
    expect(first.header).toMatchObject({
      harness: "codex",
      nativeId: codex,
      source: { checkout: app, home: me.t3.home },
      title: "Codex first",
      permissionMode: "bypass",
    });
    expect(Object.keys(first.files)).toEqual([
      `.codex/sessions/2026/11/01/rollout-2026-11-01T10-00-00-${codex}.jsonl`,
    ]);
    const key = app.replace(/[^a-zA-Z0-9]/g, "-");
    expect(second.header).toMatchObject({
      harness: "claude",
      source: { checkout: app, home: me.t3.home },
      permissionMode: "ask",
    });
    expect(Object.keys(second.files).toSorted()).toEqual([
      `.claude/plans/fix-the-build.md`,
      `.claude/plans/other-plan.md`,
      `.claude/projects/${key}/${claude}.jsonl`,
      `.claude/projects/${key}/${claude}/tool-results/t1.txt`,
      `.claude/tasks/${claude}/1.json`,
    ]);
    expect(out()).toContain(
      `  mend message ${sessionId(2).slice(0, 8)} --resume "…"  # Claude second · claude`,
    );
  });

  it("imports only what is new on a second run, and hands off only checkouts with new threads", async () => {
    const me = person();
    const app = me.checkout("app");
    const tree = me.checkout("app-tree");
    me.t3.project("p-app", "app", app);
    me.t3.thread(claudeThread("First", "p-app", me.claude(1, app)));
    me.t3.thread(claudeThread("Tree", "p-app", me.claude(2, tree), { worktreePath: tree }));
    const fake = fakeMend();
    expect(await me.run(fake, ["--yes"])).toBe(0);
    expect(fake.handoffs).toHaveLength(2);

    me.t3.thread(claudeThread("Later", "p-app", me.claude(3, app)));
    // app's checkout did not change: the server answers with the first run's worktree and the
    // session that already holds "First".
    fake.behaviour.replayHandoffs = true;
    expect(await me.run(fake, ["--yes"])).toBe(0);

    expect(fake.handoffs).toHaveLength(3);
    expect(fake.handoffs.at(-1)?.projectId).toBe("project-app");
    expect(fake.imports.map((each) => [each.header.title, query(each)])).toEqual([
      ["First", "session"],
      ["Tree", "session"],
      ["Later", "worktree"],
    ]);
    expect(fake.imports.at(-1)?.query).toBe("worktree=worktree-project-app-1");
  });

  it("records each failure against its thread or checkout and goes on", async () => {
    const me = person();
    const app = me.checkout("app");
    const web = me.checkout("web", "https://github.com/ana/web.git");
    me.t3.project("p-app", "app", app);
    me.t3.project("p-web", "web", web);
    const refusedId = me.claude(1, app);
    me.t3.thread(claudeThread("Refused", "p-app", refusedId));
    me.t3.thread(claudeThread("Too big", "p-app", me.claude(2, app, { text: "x".repeat(4096) })));
    me.t3.thread(claudeThread("Fine", "p-app", me.claude(3, app)));
    me.t3.thread(claudeThread("On web", "p-web", me.claude(4, web)));
    const fake = fakeMend({
      conversationBytes: 2048,
      refuse: { [refusedId]: "the transcript names another conversation · nothing was imported" },
      refuseHandoff: {
        "project-web": "this server refuses handoffs into web · nothing was created",
      },
    });

    expect(await me.run(fake, ["--yes"])).toBe(1);

    expect(fake.imports.map((each) => each.header.title)).toEqual(["Fine"]);
    const lines = out();
    const summary = lines.slice(lines.indexOf("1 thread imported · 4 not imported"));
    expect(summary.slice(0, 5)).toEqual([
      "1 thread imported · 4 not imported",
      expect.stringMatching(
        /^ {2}! Too big · its conversation is \d\.\d KiB, over the server's 2 KiB limit; the server's operator can raise it with MEND_BUDGET_CONVERSATION_BYTES$/u,
      ),
      "  ! Refused · the transcript names another conversation · nothing was imported",
      `  ! the handoff of ${web} · this server refuses handoffs into web · nothing was handed off · web stays adopted`,
      "  ! On web · its checkout's handoff failed",
    ]);
  });

  it("imports nothing from a server whose terms carry no conversation limit", async () => {
    const me = person();
    const app = me.checkout("app");
    me.t3.project("p-app", "app", app);
    me.t3.thread(claudeThread("Fix", "p-app", me.claude(1, app)));
    const fake = fakeMend({ conversationBytes: null });

    expect(await me.run(fake, ["--yes"])).toBe(1);

    expect(stderr.join("")).toBe(
      "mend: this Mend server (0.36.0) takes no imported conversations · upgrade it, then import again · nothing was imported\n",
    );
    expect(fake.routes.filter((route) => route.startsWith("POST"))).toEqual([]);
  });

  it("refuses without a terminal unless --yes, and sends nothing when the question is declined", async () => {
    const me = person();
    const app = me.checkout("app");
    me.t3.project("p-app", "app", app);
    me.t3.thread(claudeThread("Fix", "p-app", me.claude(1, app)));
    const fake = fakeMend();

    expect(await me.run(fake, [])).toBe(1);
    expect(stderr.join("")).toBe(
      "mend: non-interactive · pass --yes to import 1 thread · nothing was imported\n",
    );
    const declined = await importT3Command(
      fake.deps,
      [],
      { t3Home: me.t3.t3Home, homeDirectory: me.t3.home, environment: {} },
      { interactive: true, ask: async () => false },
    );
    expect(declined).toBe(0);
    expect(fake.routes.filter((route) => route.startsWith("POST"))).toEqual([]);
  });

  it("takes the projects and threads named, and archived threads only when asked", async () => {
    const me = person();
    const app = me.checkout("app");
    const web = me.checkout("web", "https://github.com/ana/web.git");
    me.t3.project("p-app", "app", app);
    me.t3.project("p-web", "web", web);
    me.t3.thread(claudeThread("a1", "p-app", me.claude(1, app)));
    me.t3.thread(claudeThread("a2", "p-app", me.claude(2, app), { archived: true }));
    me.t3.thread(claudeThread("w1", "p-web", me.claude(3, web)));
    me.t3.thread(claudeThread("w2", "p-web", me.claude(4, web), { archived: true }));
    const listed = async (args: ReadonlyArray<string>) => {
      stdout = [];
      expect(await me.run(fakeMend(), ["--dry-run", ...args])).toBe(0);
      return out()
        .filter((line) => line.startsWith("    ✓ "))
        .map((line) => line.slice(6).split(" · ")[0]);
    };

    expect(await listed([])).toEqual(["a1", "w1"]);
    expect(out()).toContain("2 archived threads are left out · --archived brings them");
    expect(await listed(["--archived"])).toEqual(["a1", "a2", "w1", "w2"]);
    expect(await listed(["--project", "web"])).toEqual(["w1"]);
    expect(await listed(["--project", "web", "--project", app])).toEqual(["a1", "w1"]);
    expect(await listed(["--thread", "w2"])).toEqual(["w2"]);
  });

  it("maps a harness home named .claude by its parent, and leaves one named otherwise behind", async () => {
    const me = person();
    const app = me.checkout("app");
    me.t3.project("p-app", "app", app);
    const alt = path.join(me.t3.home, "work", ".claude");
    const odd = path.join(me.t3.home, ".config", "claude-work");
    write(
      path.join(me.t3.t3Home, "userdata", "settings.json"),
      JSON.stringify({
        providerInstances: {
          alt: { driver: "claudeAgent", config: { homePath: alt } },
          odd: { driver: "claudeAgent", config: { homePath: odd } },
        },
      }),
    );
    const altId = me.claude(1, app, { home: alt });
    me.t3.thread({
      id: "alt",
      project: "p-app",
      title: "alt",
      providers: [{ id: "pt-alt", driver: "claudeAgent", nativeId: altId, instance: "alt" }],
    });
    me.t3.thread({
      id: "odd",
      project: "p-app",
      title: "odd",
      providers: [
        {
          id: "pt-odd",
          driver: "claudeAgent",
          nativeId: me.claude(2, app, { home: odd }),
          instance: "odd",
        },
      ],
    });
    const fake = fakeMend();

    expect(await me.run(fake, ["--yes"])).toBe(0);

    expect(fake.imports.map((each) => [each.header.title, each.header.source.home])).toEqual([
      ["alt", path.join(me.t3.home, "work")],
    ]);
    const key = app.replace(/[^a-zA-Z0-9]/g, "-");
    expect(Object.keys(fake.imports[0]?.files ?? {})).toContain(
      `.claude/projects/${key}/${altId}.jsonl`,
    );
    expect(out()).toContain(
      `    · odd · its conversation is in ${odd}, a claude home not named .claude, whose paths Mend cannot rewrite`,
    );
  });

  it("puts threads whose checkout is gone in a new worktree from origin, on their branch when origin has it", async () => {
    const me = person();
    const app = me.checkout("app");
    me.t3.project("p-app", "app", app);
    const gone = path.join(me.t3.t3Home, "worktrees", "app", "t3code-1a2b");
    const other = path.join(me.t3.t3Home, "worktrees", "app", "t3code-9f9f");
    me.t3.thread(
      claudeThread("Gone one", "p-app", me.claude(1, gone), {
        worktreePath: gone,
        branch: "t3code/1a2b",
      }),
    );
    me.t3.thread(
      codexThread("Gone two", "p-app", me.codex(2), { worktreePath: gone, branch: "t3code/1a2b" }),
    );
    me.t3.thread(
      claudeThread("Unpushed", "p-app", me.claude(3, other), {
        worktreePath: other,
        branch: "t3code/9f9f",
      }),
    );
    const fake = fakeMend({ branches: ["main", "t3code/1a2b"] });

    expect(await me.run(fake, ["--yes"])).toBe(0);

    expect(fake.handoffs).toEqual([]);
    expect(fake.created.map((each) => each.body)).toEqual([
      { harness: "claude", label: null, name: null, base: "t3code/1a2b" },
      { harness: "claude", label: null, name: null, base: null },
    ]);
    expect(
      fake.imports.map((each) => [each.header.title, query(each), each.header.source.checkout]),
    ).toEqual([
      ["Gone one", "session", gone],
      ["Gone two", "worktree", gone],
      ["Unpushed", "session", other],
    ]);
    expect(out()).toContain("✓ new worktree w-2 on main · origin has no t3code/9f9f");
  });
});
