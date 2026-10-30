import { ResourcesPage } from "@mend/domain/workbench";
import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApiCall } from "./pair.ts";
import {
  approvalTarget,
  proposalOf,
  removalTarget,
  renderResources,
  resourceCommand,
  reviewLines,
} from "./resource.ts";

const shop = { id: "p_shop", name: "shop" };
const digest = "a".repeat(64);

const spec = (name: string, image: string) => ({
  name,
  scope: "project",
  preset: null,
  image,
  command: null,
  ports: [{ name: "smtp", port: 1025, protocol: "tcp" }],
  env: {},
  volumes: [],
  limits: { cpu: 1, memoryMiB: 1024, diskGiB: 10 },
  ready: { kind: "tcp" },
  exports: {},
});

const pageOf = Schema.decodeUnknownSync(ResourcesPage);
/** The page's offers to a reader who manages nothing: none of them is a request. */
const NOT_A_MANAGER = {
  project: {
    kind: "denied",
    message:
      "approving a resource for the project is a manager's: the project's creator or an organization owner",
  },
  worktree: null,
};

const page = pageOf({
  settings: [
    {
      id: "rdef_1",
      digest,
      spec: spec("db", "postgres:17"),
      approvals: { project: { by: "maria" }, worktree: null },
      approve: { project: { kind: "approved" }, worktree: null },
      choice: null,
      canRemove: true,
      canChoose: false,
      statusLine: "@db · postgres 17 · project · approved by Maria · not started",
    },
  ],
  proposals: [
    {
      id: "rprop_1",
      digest,
      spec: spec("mail", "axllent/mailpit:v1.21"),
      proposedBy: "tom",
      canRemove: true,
      mine: true,
      approvals: { project: null, worktree: null },
      approve: NOT_A_MANAGER,
      statusLine: "@mail · mailpit · project · proposed by Tom · waiting for approval",
    },
    {
      id: "rprop_2",
      digest,
      spec: spec("mail", "axllent/mailpit:v1.22"),
      proposedBy: "ana",
      canRemove: false,
      mine: false,
      approvals: { project: null, worktree: null },
      approve: NOT_A_MANAGER,
      statusLine: "@mail · mailpit · project · proposed by Ana · waiting for approval",
    },
  ],
  file: {
    kind: "read",
    worktreeId: "wt_1",
    observed: "observed at capture 12 · seq 4180",
    proposals: [
      {
        digest,
        spec: spec("queue", "rabbitmq:4-management"),
        approvals: { project: null, worktree: null },
        approve: NOT_A_MANAGER,
        statusLine: "@queue · rabbitmq 4 · project · proposed in mend.toml · waiting for approval",
      },
    ],
    refused: [{ key: "resource.cache.ports.redis", message: "must be a port in 1..65535" }],
    ignored: [{ key: "resource.queue.device" }],
  },
  canPropose: true,
});

describe("mend resource list", () => {
  it("prints settings, proposals with their ids, and the worktree's file", () => {
    expect(renderResources(shop, page, "checkout")).toEqual([
      "settings",
      "  @db · postgres 17 · project · approved by Maria · not started  postgres:17  rdef_1",
      "proposals",
      "  @mail · mailpit · project · proposed by Tom · waiting for approval  axllent/mailpit:v1.21  rprop_1",
      "  @mail · mailpit · project · proposed by Ana · waiting for approval  axllent/mailpit:v1.22  rprop_2",
      "mend.toml in checkout · observed at capture 12 · seq 4180",
      "  @queue · rabbitmq 4 · project · proposed in mend.toml · waiting for approval  rabbitmq:4-management",
      "  resource.cache.ports.redis · must be a port in 1..65535",
      "  resource.queue.device · is ignored: this Mend does not read it",
    ]);
  });

  it("says when there is nothing, and when the file could not be read", () => {
    const empty = { settings: [], proposals: [], file: { kind: "not-selected" }, canPropose: true };
    expect(renderResources(shop, pageOf(empty), null)).toEqual([
      "no resources in shop · mend resource add proposes one",
    ]);
    const unread = {
      ...empty,
      file: {
        kind: "unavailable",
        worktreeId: "wt_1",
        message: "mend.toml could not be read",
      },
    };
    expect(renderResources(shop, pageOf(unread), "checkout")).toEqual([
      "mend.toml in checkout · mend.toml could not be read",
    ]);
  });

  it("keeps where a file that did not parse was read, beside why", () => {
    const unparsed = {
      settings: [],
      proposals: [],
      canPropose: true,
      file: {
        kind: "unparsed",
        worktreeId: "wt_1",
        observed: "observed at capture 12 · seq 4180",
        message: "mend.toml is not text · not read",
      },
    };
    expect(renderResources(shop, pageOf(unparsed), "checkout")).toEqual([
      "mend.toml in checkout · observed at capture 12 · seq 4180 · mend.toml is not text · not read",
    ]);
  });
});

describe("mend resource add", () => {
  it("proposes a preset at a version", () => {
    expect(proposalOf(["db", "--preset", "postgres", "--version", "17"])).toEqual({
      ok: true,
      body: { kind: "preset", name: "db", preset: "postgres", version: "17", scope: "project" },
    });
  });

  it("proposes an image with its named ports", () => {
    const proposal = proposalOf([
      "dns",
      "--image",
      "coredns/coredns:1.12",
      "--port",
      "dns=53/udp",
      "--scope",
      "worktree",
    ]);
    expect(proposal).toMatchObject({
      ok: true,
      body: {
        kind: "definition",
        spec: {
          name: "dns",
          scope: "worktree",
          image: "coredns/coredns:1.12",
          ports: [{ name: "dns", port: 53, protocol: "udp" }],
          ready: { kind: "none" },
        },
      },
    });
  });

  it("says what is missing", () => {
    expect(proposalOf(["db", "--preset", "postgres"])).toEqual({
      ok: false,
      message: "--version names the postgres version to run, such as 17",
    });
    expect(proposalOf(["mail", "--image", "axllent/mailpit:v1.21", "--port", "1025"])).toEqual({
      ok: false,
      message: "--port 1025 is not <name>=<port>, such as smtp=1025 or dns=53/udp",
    });
  });
});

describe("mend resource remove", () => {
  const none = { proposal: null, definition: null };
  const managerPage = pageOf({
    ...page,
    proposals: [
      ...page.proposals,
      {
        id: "rprop_db",
        digest,
        spec: spec("db", "postgres:18"),
        proposedBy: "maria",
        canRemove: true,
        mine: true,
        approvals: { project: null, worktree: null },
        approve: NOT_A_MANAGER,
        statusLine: "@db · postgres 18 · project · proposed by Maria · waiting for approval",
      },
    ],
  });
  const memberPage = pageOf({
    ...page,
    settings: page.settings.map((entry) => ({ ...entry, canRemove: false })),
    proposals: managerPage.proposals,
  });

  it("removes the definition as it was read, and shows its line", () => {
    expect(removalTarget(shop, page, "db", none)).toEqual({
      kind: "definition",
      route: "/projects/p_shop/resources/rdef_1",
      body: { expectedDigest: digest },
      line: "@db · postgres 17 · project · approved by Maria · not started  postgres:17  rdef_1",
    });
  });

  it("refuses a name that is both a definition and a proposal the caller may remove, naming each", () => {
    expect(removalTarget(shop, managerPage, "db", none)).toEqual({
      kind: "none",
      message:
        "@db is a definition (rdef_1) and a proposal you can remove (rprop_db) · name one with --definition rdef_1 or --proposal rprop_db",
    });
    expect(removalTarget(shop, managerPage, "db", { ...none, proposal: "rprop_db" })).toMatchObject(
      { kind: "proposal", route: "/projects/p_shop/resource-proposals/rprop_db" },
    );
    expect(removalTarget(shop, managerPage, "db", { ...none, definition: "rdef_1" })).toMatchObject(
      { kind: "definition", route: "/projects/p_shop/resources/rdef_1" },
    );
  });

  it("picks a member's own proposal when the definition is not theirs to remove", () => {
    expect(removalTarget(shop, memberPage, "db", none)).toMatchObject({
      kind: "proposal",
      route: "/projects/p_shop/resource-proposals/rprop_db",
    });
    expect(removalTarget(shop, pageOf({ ...memberPage, proposals: [] }), "db", none)).toEqual({
      kind: "none",
      message: "no @db in shop that you can remove",
    });
  });

  it("refuses an id that is not of the name given, or not on the page", () => {
    expect(removalTarget(shop, page, "db", { ...none, proposal: "rprop_1" })).toEqual({
      kind: "none",
      message: "rprop_1 is @mail, not @db · nothing was removed",
    });
    expect(removalTarget(shop, page, null, { ...none, proposal: "rprop_9" })).toEqual({
      kind: "none",
      message: "no proposal rprop_9 in shop",
    });
  });

  it("removes the one proposal of that name the caller may remove", () => {
    expect(removalTarget(shop, page, "mail", none)).toMatchObject({
      kind: "proposal",
      route: "/projects/p_shop/resource-proposals/rprop_1",
    });
    expect(removalTarget(shop, page, "cache", none)).toEqual({
      kind: "none",
      message: "no @cache in shop that you can remove",
    });
  });

  it("puts an id into the route as one path segment", () => {
    const odd = pageOf({
      ...page,
      proposals: [{ ...page.proposals[0], id: "rprop_../x?y" }],
    });
    expect(removalTarget(shop, odd, null, { ...none, proposal: "rprop_../x?y" })).toMatchObject({
      route: "/projects/p_shop/resource-proposals/rprop_..%2Fx%3Fy",
    });
  });
});

const stdout = () => {
  const out: Array<string> = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  return out;
};

const exits = () =>
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`exit ${code}`);
  });

const stderr = () => {
  const err: Array<string> = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
  return err;
};

const server = (answers: Record<string, unknown>) => {
  const calls: Array<string> = [];
  const api: ApiCall = async (method, route, body) => {
    calls.push(
      `${method} ${route.replace(/timeZone=[^&]+/, "timeZone=…")}${body === undefined ? "" : ` ${JSON.stringify(body)}`}`,
    );
    const key = `${method} ${route.split("?")[0]}`;
    return JSON.parse(JSON.stringify(answers[key] ?? null));
  };
  return { calls, api };
};

const ready = (source: unknown, worktreeId: string | null = null) => ({
  kind: "ready",
  request: { source, worktreeId },
});

const posted = (calls: ReadonlyArray<string>) => calls.filter((call) => call.startsWith("POST"));

describe("the command against a server", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("adds a proposal and prints its line and id", async () => {
    const out = stdout();
    const mend = server({
      "POST /projects/p_shop/resource-proposals": {
        id: "rprop_9",
        statusLine: "@db · postgres 17 · project · proposed by Tom · waiting for approval",
      },
    });
    await resourceCommand(mend.api, async () => shop, [
      "add",
      "db",
      "--preset",
      "postgres",
      "--version",
      "17",
    ]);
    expect(out.join("")).toBe(
      "@db · postgres 17 · project · proposed by Tom · waiting for approval\n" +
        "proposal rprop_9 · a manager approves it in project settings\n",
    );
    expect(mend.calls).toEqual([
      'POST /projects/p_shop/resource-proposals?timeZone=… {"kind":"preset","name":"db","preset":"postgres","version":"17","scope":"project"}',
    ]);
  });

  it("removes a definition with the digest it read, and prints its line, then the server's", async () => {
    const out = stdout();
    const mend = server({
      "GET /projects/p_shop/resources": page,
      "DELETE /projects/p_shop/resources/rdef_1": { statusLine: "@db · definition removed" },
    });
    await resourceCommand(mend.api, async () => shop, ["remove", "db"]);
    expect(out.join("")).toBe(
      "removing @db · postgres 17 · project · approved by Maria · not started  postgres:17  rdef_1\n" +
        "@db · definition removed\n",
    );
    expect(mend.calls.at(-1)).toBe(
      `DELETE /projects/p_shop/resources/rdef_1 {"expectedDigest":"${digest}"}`,
    );
  });
});

describe("what the terminal receives", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const hostile = pageOf({
    ...page,
    settings: [],
    proposals: [
      {
        ...page.proposals[0],
        id: "rprop_\u001b]0;owned\u0007",
        statusLine:
          "@mail · mailpit · project · proposed by \u001b[2J\u001b[HTom · waiting for approval",
      },
    ],
    file: { kind: "not-selected" },
  });

  it("writes another person's control characters as text, never as bytes the terminal acts on", async () => {
    const out = stdout();
    await resourceCommand(
      server({ "GET /projects/p_shop/resources": hostile }).api,
      async () => shop,
      ["list"],
    );
    const written = out.join("");
    // eslint-disable-next-line no-control-regex -- control characters are what must be absent
    expect(written).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
    expect(written).toBe(
      "proposals\n" +
        "  @mail · mailpit · project · proposed by \\x1b[2J\\x1b[HTom · waiting for approval  axllent/mailpit:v1.21  rprop_\\x1b]0;owned\\x07\n",
    );
  });

  it("styles its own words on a terminal with real escape sequences", async () => {
    const out = stdout();
    const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    try {
      await resourceCommand(
        server({ "GET /projects/p_shop/resources": hostile }).api,
        async () => shop,
        ["list"],
      );
    } finally {
      if (tty === undefined) Reflect.deleteProperty(process.stdout, "isTTY");
      else Object.defineProperty(process.stdout, "isTTY", tty);
    }
    expect(out.join("")).toContain("\u001b[2mrprop_\\x1b]0;owned\\x07\u001b[0m");
  });

  it("prints --json as JSON, whatever URLs a spec holds", async () => {
    const out = stdout();
    const withUrl = pageOf({
      ...page,
      proposals: [
        {
          ...page.proposals[0],
          spec: { ...page.proposals[0]?.spec, env: { ORIGIN: "https://example.com" } },
        },
        ...page.proposals.slice(1),
      ],
    });
    await resourceCommand(
      server({ "GET /projects/p_shop/resources": withUrl }).api,
      async () => shop,
      ["list", "--json"],
    );
    expect(JSON.parse(out.join(""))).toEqual(
      JSON.parse(JSON.stringify({ version: 1, ...withUrl })),
    );
  });
});

describe("mend resource approve", () => {
  const unnamed = { proposal: null, worktree: null, forProject: false };

  it("names a proposal when several share the name, and refuses an id of another name", () => {
    expect(approvalTarget(page, "mail", unnamed)).toEqual({
      kind: "refused",
      message: "2 proposals of @mail · name one with --proposal rprop_1 | rprop_2",
    });
    expect(approvalTarget(page, "db", { ...unnamed, proposal: "rprop_1" })).toEqual({
      kind: "refused",
      message: "no proposal rprop_1 of @db",
    });
  });

  it("says a target that approves the spec already, and approves nothing again", () => {
    expect(approvalTarget(page, "db", unnamed)).toMatchObject({
      kind: "approved",
      message: "@db is approved for the project already",
    });
  });

  it("prints every field that runs, the digest and whom it is for", () => {
    const [db] = page.settings;
    if (db === undefined) throw new Error("the page holds db");
    expect(reviewLines(db, null)).toEqual([
      "@db · postgres 17 · project · approved by Maria · not started",
      "  image postgres:17",
      "  scope project",
      "  port smtp 1025/tcp",
      "  limits 1 CPU · 1024 MiB memory · 10 GiB disk",
      "  ready tcp",
      `  definition digest sha256:${digest}`,
      "  for the project",
    ]);
  });
});

describe("approving, choosing and starting against a server", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const held = { id: "rdef_9", digest: "e".repeat(64) };
  const fileDigest = "b".repeat(64);
  const ofScope = (name: string, image: string, scope: "project" | "worktree") => ({
    ...spec(name, image),
    scope,
  });
  /** A page whose every offer is the server's own: each ready request names what settings held. */
  const offering = pageOf({
    canPropose: true,
    settings: [
      {
        ...page.settings[0],
        approvals: { project: null, worktree: null },
        approve: {
          project: ready({ kind: "settings", id: "rdef_1", digest }),
          worktree: null,
        },
        statusLine: "@db · postgres 17 · project · waiting for approval",
      },
      {
        ...page.settings[0],
        id: "rdef_2",
        spec: spec("cache", "redis:7"),
        approvals: { project: null, worktree: null },
        approve: {
          project: {
            kind: "rejected",
            refusals: [
              { key: "exports.URL", message: "sets MEND_RESOURCE_CACHE_URL, as db does too" },
            ],
          },
          worktree: null,
        },
        statusLine: "@cache · redis 7 · project · waiting for approval",
      },
    ],
    proposals: [
      ...page.proposals.map((entry) =>
        entry.id === "rprop_2"
          ? {
              ...entry,
              approve: {
                project: ready({ kind: "proposal", id: "rprop_2", digest, settings: held }),
                worktree: null,
              },
            }
          : entry,
      ),
      {
        ...page.proposals[0],
        id: "rprop_9",
        spec: ofScope("box", "axllent/mailpit:v1.21", "worktree"),
        approve: {
          project: ready({ kind: "proposal", id: "rprop_9", digest, settings: held }),
          worktree: ready({ kind: "proposal", id: "rprop_9", digest, settings: held }, "wt_1"),
        },
      },
    ],
    file: {
      ...page.file,
      proposals: [
        {
          digest: fileDigest,
          spec: ofScope("queue", "rabbitmq:4-management", "worktree"),
          approvals: { project: null, worktree: null },
          approve: {
            project: ready({
              kind: "file",
              worktreeId: "wt_1",
              name: "queue",
              digest: fileDigest,
              settings: held,
            }),
            worktree: ready(
              {
                kind: "file",
                worktreeId: "wt_1",
                name: "queue",
                digest: fileDigest,
                settings: held,
              },
              "wt_1",
            ),
          },
          statusLine: "@queue · rabbitmq 4 · worktree · proposed in mend.toml · waiting",
        },
        {
          digest: fileDigest,
          spec: ofScope("mail", "axllent/mailpit:v1.21", "worktree"),
          approvals: { project: null, worktree: null },
          approve: {
            project: NOT_A_MANAGER.project,
            worktree: {
              kind: "rejected",
              refusals: [
                {
                  key: "image",
                  message:
                    "is not one a manager approved for this project · a manager approves @mail for the project first",
                },
              ],
            },
          },
          statusLine: "@mail · mailpit · worktree · proposed in mend.toml · waiting",
        },
      ],
    },
  });
  const answers = {
    "GET /projects/p_shop/worktrees": { worktrees: [{ id: "wt_1", name: "checkout" }] },
    "GET /projects/p_shop/resources": offering,
    "POST /projects/p_shop/resources/approvals": {
      definition: { statusLine: "@db · postgres 17 · project · approved by Maria · not started" },
      image: `postgres:17@sha256:${"c".repeat(64)}`,
      resolvedBy: "docker-mirror:5000",
    },
  };

  it("posts the request the page offers for the item and the target each flag names", async () => {
    const offers = (name: string) =>
      [
        ...offering.settings,
        ...offering.proposals,
        ...(offering.file.kind === "read" ? offering.file.proposals : []),
      ].filter((entry) => entry.spec.name === name);
    const requestOf = (name: string, target: "project" | "worktree", id: string | null = null) => {
      const offer = offers(name).find((each) => id === null || ("id" in each && each.id === id))
        ?.approve[target];
      if (offer?.kind !== "ready") throw new Error(`the page offers ${name} for ${target}`);
      return offer.request;
    };
    const cases = [
      { args: ["db"], request: requestOf("db", "project") },
      {
        args: ["mail", "--proposal", "rprop_2"],
        request: requestOf("mail", "project", "rprop_2"),
      },
      { args: ["box"], request: requestOf("box", "project") },
      { args: ["box", "--worktree", "checkout"], request: requestOf("box", "worktree") },
      {
        args: ["box", "--worktree", "checkout", "--for-project"],
        request: requestOf("box", "project"),
      },
      { args: ["queue", "--worktree", "checkout"], request: requestOf("queue", "worktree") },
      {
        args: ["queue", "--worktree", "checkout", "--for-project"],
        request: requestOf("queue", "project"),
      },
    ];
    for (const { args, request } of cases) {
      stdout();
      const mend = server(answers);
      await resourceCommand(mend.api, async () => shop, [
        "approve",
        ...args,
        "--digest",
        `sha256:${request.source.digest}`,
      ]);
      expect(posted(mend.calls), args.join(" ")).toEqual([
        `POST /projects/p_shop/resources/approvals?timeZone=… ${JSON.stringify(request)}`,
      ]);
      vi.restoreAllMocks();
    }
  });

  it("prints why the page offers no request, in the route's words, and posts nothing", async () => {
    const cases = [
      {
        args: ["cache"],
        words:
          "@cache · exports.URL sets MEND_RESOURCE_CACHE_URL, as db does too\nnothing was approved",
      },
      {
        args: ["mail", "--worktree", "checkout"],
        words:
          "@mail · image is not one a manager approved for this project · a manager approves @mail for the project first\nnothing was approved",
      },
      {
        args: ["mail", "--proposal", "rprop_1"],
        words: `${NOT_A_MANAGER.project.message} · nothing was approved`,
      },
    ];
    for (const { args, words } of cases) {
      const out = stdout();
      const err = stderr();
      exits();
      const mend = server(answers);
      await expect(
        resourceCommand(mend.api, async () => shop, [
          "approve",
          ...args,
          "--digest",
          `sha256:${digest}`,
        ]),
      ).rejects.toThrow("exit 1");
      expect(err.join(""), args.join(" ")).toBe(`mend: ${words}\n`);
      expect(out, args.join(" ")).toEqual([]);
      expect(posted(mend.calls), args.join(" ")).toEqual([]);
      vi.restoreAllMocks();
    }
  });

  it("says an approval already made and exits 0, posting nothing", async () => {
    const out = stdout();
    const err = stderr();
    exits();
    const mend = server({ ...answers, "GET /projects/p_shop/resources": page });
    await resourceCommand(mend.api, async () => shop, ["approve", "db"]);
    expect(out).toEqual(["@db is approved for the project already\n"]);
    expect(err).toEqual([]);
    expect(posted(mend.calls)).toEqual([]);
  });

  it("reads the page for the worktree --worktree names, and never widens its resource to the project", async () => {
    const box = offering.proposals.find((entry) => entry.spec.name === "box");
    if (box === undefined) throw new Error("the page proposes box");
    expect(box.spec.scope).toBe("worktree");
    const unread = {
      ...offering,
      proposals: offering.proposals.map((entry) =>
        entry === box ? { ...entry, approve: { ...entry.approve, worktree: null } } : entry,
      ),
    };
    stdout();
    const err = stderr();
    exits();
    const mend = server({ ...answers, "GET /projects/p_shop/resources": unread });
    await expect(
      resourceCommand(mend.api, async () => shop, [
        "approve",
        "box",
        "--worktree",
        "checkout",
        "--digest",
        `sha256:${box.digest}`,
      ]),
    ).rejects.toThrow("exit 1");
    expect(mend.calls.filter((call) => call.startsWith("GET /projects/p_shop/resources"))).toEqual([
      expect.stringMatching(/[?&]worktreeId=wt_1(&|$)/),
    ]);
    expect(err.join("")).toBe(
      "mend: @box · the page offers no approval for worktree checkout · nothing was approved\n",
    );
    expect(posted(mend.calls)).toEqual([]);
  });

  it("answers an approval already made only for the definition the approver read", async () => {
    const [db] = page.settings;
    if (db === undefined) throw new Error("the page holds db");
    const run = async (passed: string) => {
      const out = stdout();
      const err = stderr();
      exits();
      const mend = server({ ...answers, "GET /projects/p_shop/resources": page });
      const done = await resourceCommand(mend.api, async () => shop, [
        "approve",
        "db",
        "--digest",
        passed,
      ]).then(
        () => "exit 0",
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      vi.restoreAllMocks();
      return { done, out: out.join(""), err: err.join(""), posted: posted(mend.calls) };
    };
    expect(await run(`sha256:${db.digest}`)).toEqual({
      done: "exit 0",
      out: "@db is approved for the project already\n",
      err: "",
      posted: [],
    });
    expect(await run(`sha256:${"e".repeat(64)}`)).toEqual({
      done: "exit 1",
      out: "",
      err: "mend: @db · changed since you read it · mend resource list shows what settings hold · nothing was approved\n",
      posted: [],
    });
    expect(await run("not-a-digest")).toEqual({
      done: "exit 1",
      out: "",
      err: "mend: --digest is sha256: and 64 lower-case hex digits, as printed above\n",
      posted: [],
    });
  });

  it("approves the digest passed, and prints the line and the image pinned", async () => {
    const out = stdout();
    const mend = server(answers);
    await resourceCommand(mend.api, async () => shop, [
      "approve",
      "db",
      "--digest",
      `sha256:${"d".repeat(64)}`,
    ]);
    expect(mend.calls.at(-1)).toBe(
      `POST /projects/p_shop/resources/approvals?timeZone=… {"source":{"kind":"settings","id":"rdef_1","digest":"${"d".repeat(64)}"},"worktreeId":null}`,
    );
    expect(out.join("").split("\n").slice(-3)).toEqual([
      "@db · postgres 17 · project · approved by Maria · not started",
      `image postgres:17@sha256:${"c".repeat(64)} · digest from docker-mirror:5000`,
      "",
    ]);
  });

  it("approves nothing without a terminal or a digest", async () => {
    stdout();
    const err = stderr();
    exits();
    const mend = server(answers);
    await expect(resourceCommand(mend.api, async () => shop, ["approve", "db"])).rejects.toThrow(
      "exit 1",
    );
    expect(err.join("")).toBe(
      "mend: approving without a terminal takes --digest sha256:… of the definition you read, as printed above · nothing was approved\n",
    );
    expect(posted(mend.calls)).toEqual([]);
  });

  it("stores a worktree's choice and prints the line written", async () => {
    const out = stdout();
    const mend = server({
      "GET /projects/p_shop/worktrees": { worktrees: [{ id: "wt_1", name: "checkout" }] },
      "GET /projects/p_shop/resources": page,
      "PUT /projects/p_shop/worktrees/wt_1/resources/rdef_1/selection": {
        statusLine:
          "@db · postgres 17 · project · approved by Maria · its own database · not started",
        revision: 2,
      },
    });
    await resourceCommand(mend.api, async () => shop, [
      "use",
      "db",
      "own",
      "--worktree",
      "checkout",
    ]);
    expect(mend.calls.at(-1)).toBe(
      'PUT /projects/p_shop/worktrees/wt_1/resources/rdef_1/selection?timeZone=… {"mode":"own"}',
    );
    expect(out.join("")).toBe(
      "@db · postgres 17 · project · approved by Maria · its own database · not started\n" +
        "checkout · revision 2\n",
    );
  });

  it("asks the server to start, which refuses every start", async () => {
    const mend = server({});
    await resourceCommand(mend.api, async () => shop, ["start", "db"]);
    expect(mend.calls).toEqual(["POST /projects/p_shop/resources/db/start"]);
  });
});
