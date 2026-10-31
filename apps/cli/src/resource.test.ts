import { resourceAdditionOf as additionOf, ResourcesPage } from "@mend/domain/workbench";
import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApiCall } from "./pair.ts";
import { removalTarget, renderResources, resourceCommand, tableAddition } from "./resource.ts";

const shop = { id: "p_shop", name: "shop" };
const digest = "a".repeat(64);
const pin = `sha256:${"c".repeat(64)}`;

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

const db = {
  id: "rdef_1",
  digest,
  spec: spec("db", "postgres:17"),
  image: `postgres:17@${pin}`,
  addedBy: "maria",
  choice: null,
  canRemove: true,
  canChoose: false,
  canLoadOwn: false,
  instance: "not-started",
  statusLine: "@db · postgres 17 · project · added by Maria · not started",
};

const page = pageOf({
  settings: [db],
  file: {
    kind: "read",
    worktreeId: "wt_1",
    observed: "observed at capture 12 · seq 4180",
    tables: [
      {
        digest: "b".repeat(64),
        spec: spec("queue", "rabbitmq:4-management"),
        add: { kind: "ready" },
        statusLine: "@queue · rabbitmq 4 · project · in mend.toml · not in settings",
      },
      {
        digest: "d".repeat(64),
        spec: spec("db", "postgres:18"),
        add: {
          kind: "denied",
          message:
            "replacing a definition someone else added is theirs or a manager's: the project's creator or an organization owner",
        },
        statusLine: "@db · postgres 18 · project · in mend.toml · differs from settings",
      },
      {
        digest: "e".repeat(64),
        spec: spec("cache", "redis:7"),
        add: {
          kind: "rejected",
          refusals: [
            { key: "exports.URL", message: "sets MEND_RESOURCE_CACHE_URL, as db does too" },
          ],
        },
        statusLine: "@cache · redis 7 · project · in mend.toml · not in settings",
      },
      {
        digest,
        spec: spec("mail", "axllent/mailpit:v1.21"),
        add: { kind: "added" },
        statusLine: "@mail · mailpit · project · in mend.toml · same as settings",
      },
    ],
    refused: [{ key: "resource.cache.ports.redis", message: "must be a port in 1..65535" }],
    ignored: [{ key: "resource.queue.device" }],
  },
});

describe("mend resource list", () => {
  it("prints settings with their pinned images and ids, then the worktree's file and how to add a table", () => {
    expect(renderResources(shop, page, "checkout")).toEqual([
      "settings",
      `  @db · postgres 17 · project · added by Maria · not started  postgres:17@${pin}  rdef_1`,
      "mend.toml in checkout · observed at capture 12 · seq 4180",
      "  @queue · rabbitmq 4 · project · in mend.toml · not in settings  rabbitmq:4-management",
      "    mend resource add queue --from-file --worktree checkout",
      "  @db · postgres 18 · project · in mend.toml · differs from settings  postgres:18",
      "  @cache · redis 7 · project · in mend.toml · not in settings  redis:7",
      "  @mail · mailpit · project · in mend.toml · same as settings  axllent/mailpit:v1.21",
      "  resource.cache.ports.redis · must be a port in 1..65535",
      "  resource.queue.device · is ignored: this Mend does not read it",
    ]);
  });

  it("says when there is nothing, and when the file could not be read", () => {
    const empty = { settings: [], file: { kind: "not-selected" } };
    expect(renderResources(shop, pageOf(empty), null)).toEqual([
      "no resources in shop · mend resource add adds one",
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
  it("adds a preset at a version", () => {
    expect(additionOf(["db", "--preset", "postgres", "--version", "17"])).toEqual({
      ok: true,
      body: { kind: "preset", name: "db", preset: "postgres", version: "17", scope: "project" },
    });
  });

  it("adds an image with its named ports", () => {
    const addition = additionOf([
      "dns",
      "--image",
      "coredns/coredns:1.12",
      "--port",
      "dns=53/udp",
      "--scope",
      "worktree",
    ]);
    expect(addition).toMatchObject({
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
    expect(additionOf(["db", "--preset", "postgres"])).toEqual({
      ok: false,
      message: "--version names the postgres version to run, such as 17",
    });
    expect(additionOf(["mail", "--image", "axllent/mailpit:v1.21", "--port", "1025"])).toEqual({
      ok: false,
      message: "--port 1025 is not <name>=<port>, such as smtp=1025 or dns=53/udp",
    });
  });

  it("adds a mend.toml table as the page offers it, or says why not", () => {
    expect(tableAddition(page, "queue", "checkout")).toEqual({
      kind: "ready",
      body: {
        kind: "definition",
        spec: page.file.kind === "read" ? page.file.tables[0]?.spec : null,
      },
      line: "@queue · rabbitmq 4 · project · in mend.toml · not in settings  rabbitmq:4-management",
    });
    expect(tableAddition(page, "db", "checkout")).toEqual({
      kind: "refused",
      message:
        "replacing a definition someone else added is theirs or a manager's: the project's creator or an organization owner · nothing was added",
    });
    expect(tableAddition(page, "cache", "checkout")).toEqual({
      kind: "refused",
      message:
        "@cache · exports.URL sets MEND_RESOURCE_CACHE_URL, as db does too\nnothing was added",
    });
    expect(tableAddition(page, "mail", "checkout")).toEqual({
      kind: "added",
      message: "@mail is in settings already, as mend.toml in checkout has it",
    });
    expect(tableAddition(page, "dns", "checkout")).toEqual({
      kind: "refused",
      message: "no [resource.dns] in mend.toml in checkout",
    });
    const absent = pageOf({
      settings: [],
      file: { kind: "absent", worktreeId: "wt_1", observed: "observed on the worktree" },
    });
    expect(tableAddition(absent, "queue", "checkout")).toEqual({
      kind: "refused",
      message: "mend.toml in checkout · absent",
    });
  });
});

describe("mend resource remove", () => {
  it("removes the definition as it was read, and shows its line", () => {
    expect(removalTarget(shop, page, "db", null)).toEqual({
      kind: "definition",
      route: "/projects/p_shop/resources/rdef_1",
      body: { expectedDigest: digest },
      line: `@db · postgres 17 · project · added by Maria · not started  postgres:17@${pin}  rdef_1`,
    });
    expect(removalTarget(shop, page, null, "rdef_1")).toMatchObject({ kind: "definition" });
  });

  it("refuses an id that is not of the name given, or not on the page", () => {
    expect(removalTarget(shop, page, "mail", "rdef_1")).toEqual({
      kind: "none",
      message: "rdef_1 is @db, not @mail · nothing was removed",
    });
    expect(removalTarget(shop, page, null, "rdef_9")).toEqual({
      kind: "none",
      message: "no definition rdef_9 in shop",
    });
    expect(removalTarget(shop, page, "cache", null)).toEqual({
      kind: "none",
      message: "no @cache in shop",
    });
  });

  it("puts an id into the route as one path segment", () => {
    const odd = pageOf({ ...page, settings: [{ ...db, id: "rdef_../x?y" }] });
    expect(removalTarget(shop, odd, null, "rdef_../x?y")).toMatchObject({
      route: "/projects/p_shop/resources/rdef_..%2Fx%3Fy",
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

const added = {
  definition: { ...db, statusLine: "@db · postgres 17 · project · added by Tom · not started" },
  resolvedBy: "docker-mirror:5000",
};

describe("the command against a server", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("adds a preset and prints its line and the image pinned", async () => {
    const out = stdout();
    const mend = server({ "POST /projects/p_shop/resources": added });
    await resourceCommand(mend.api, async () => shop, [
      "add",
      "db",
      "--preset",
      "postgres",
      "--version",
      "17",
    ]);
    expect(out.join("")).toBe(
      "@db · postgres 17 · project · added by Tom · not started\n" +
        `image postgres:17@${pin} · digest from docker-mirror:5000\n`,
    );
    expect(mend.calls).toEqual([
      'POST /projects/p_shop/resources?timeZone=… {"kind":"preset","name":"db","preset":"postgres","version":"17","scope":"project"}',
    ]);
  });

  it("adds a worktree's mend.toml table as it reads, and posts nothing the page withholds", async () => {
    const out = stdout();
    const mend = server({
      "GET /projects/p_shop/worktrees": { worktrees: [{ id: "wt_1", name: "checkout" }] },
      "GET /projects/p_shop/resources": page,
      "POST /projects/p_shop/resources": added,
    });
    await resourceCommand(mend.api, async () => shop, [
      "add",
      "queue",
      "--from-file",
      "--worktree",
      "checkout",
    ]);
    expect(mend.calls.slice(1)).toEqual([
      "GET /projects/p_shop/resources?timeZone=…&worktreeId=wt_1",
      `POST /projects/p_shop/resources?timeZone=…&worktreeId=wt_1 ${JSON.stringify({
        kind: "definition",
        spec: page.file.kind === "read" ? page.file.tables[0]?.spec : null,
      })}`,
    ]);
    expect(out[0]).toBe(
      "adding @queue · rabbitmq 4 · project · in mend.toml · not in settings  rabbitmq:4-management\n",
    );

    exits();
    const err = stderr();
    await expect(
      resourceCommand(mend.api, async () => shop, [
        "add",
        "db",
        "--from-file",
        "--worktree",
        "checkout",
      ]),
    ).rejects.toThrow("exit 1");
    expect(err.join("")).toContain("nothing was added");
    expect(mend.calls.filter((call) => call.startsWith("POST"))).toHaveLength(1);
  });

  it("says a table settings hold already and exits 0, posting nothing", async () => {
    const out = stdout();
    const mend = server({
      "GET /projects/p_shop/worktrees": { worktrees: [{ id: "wt_1", name: "checkout" }] },
      "GET /projects/p_shop/resources": page,
    });
    await resourceCommand(mend.api, async () => shop, [
      "add",
      "mail",
      "--from-file",
      "--worktree",
      "checkout",
    ]);
    expect(out.join("")).toBe("@mail is in settings already, as mend.toml in checkout has it\n");
    expect(mend.calls.filter((call) => call.startsWith("POST"))).toEqual([]);
  });

  it("removes a definition with the digest it read, and prints its line, then the server's", async () => {
    const out = stdout();
    const mend = server({
      "GET /projects/p_shop/resources": page,
      "DELETE /projects/p_shop/resources/rdef_1": { statusLine: "@db · definition removed" },
    });
    await resourceCommand(mend.api, async () => shop, ["remove", "db"]);
    expect(out.join("")).toBe(
      `removing @db · postgres 17 · project · added by Maria · not started  postgres:17@${pin}  rdef_1\n` +
        "@db · definition removed\n",
    );
    expect(mend.calls.at(-1)).toBe(
      `DELETE /projects/p_shop/resources/rdef_1 {"expectedDigest":"${digest}"}`,
    );
  });

  it("stores a worktree's choice and prints the line written", async () => {
    const out = stdout();
    const mend = server({
      "GET /projects/p_shop/worktrees": { worktrees: [{ id: "wt_1", name: "checkout" }] },
      "GET /projects/p_shop/resources": page,
      "PUT /projects/p_shop/worktrees/wt_1/resources/rdef_1/selection": {
        statusLine: "@db · not started · own database · not made yet · observed 3 s ago",
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
      "@db · not started · own database · not made yet · observed 3 s ago\n",
    );
  });

  it("starts and stops a resource, in the worktree named for a worktree resource", async () => {
    const out = stdout();
    const mend = server({
      "GET /projects/p_shop/worktrees": { worktrees: [{ id: "wt_1", name: "checkout" }] },
      "POST /projects/p_shop/resources/db/stop": {
        instance: "stopped",
        statusLine:
          "@db · postgres 17 · project · added by Maria · stopped by Tom · observed 0 s ago",
      },
      "POST /projects/p_shop/resources/mail/start": {
        instance: "running",
        statusLine: "@mail · running · its own instance · observed 0 s ago",
      },
    });
    await resourceCommand(mend.api, async () => shop, ["stop", "db"]);
    await resourceCommand(mend.api, async () => shop, ["start", "mail", "--worktree", "checkout"]);
    expect(mend.calls).toEqual([
      "POST /projects/p_shop/resources/db/stop?timeZone=…",
      "GET /projects/p_shop/worktrees",
      "POST /projects/p_shop/resources/mail/start?timeZone=…&worktreeId=wt_1",
    ]);
    expect(out.join("")).toBe(
      "@db · postgres 17 · project · added by Maria · stopped by Tom · observed 0 s ago\n" +
        "@mail · running · its own instance · observed 0 s ago\n",
    );
  });

  it("resets a worktree's database and prints the line naming the dump it saved", async () => {
    const out = stdout();
    const mend = server({
      "GET /projects/p_shop/worktrees": { worktrees: [{ id: "wt_1", name: "checkout" }] },
      "POST /projects/p_shop/worktrees/wt_1/resources/db/reset": {
        statusLine: "@db · shared database reset · empty · previous data saved as a dump 14:02",
      },
    });
    await resourceCommand(mend.api, async () => shop, [
      "reset",
      "db",
      "--worktree",
      "checkout",
      "--target",
      "shared",
    ]);
    expect(mend.calls.at(-1)).toBe(
      "POST /projects/p_shop/worktrees/wt_1/resources/db/reset?timeZone=…&target=shared",
    );
    expect(out.join("")).toBe(
      "@db · shared database reset · empty · previous data saved as a dump 14:02\n",
    );
  });

  it("prints a worktree's exports as a shell reads them, and what the project sets as comments", async () => {
    const out = stdout();
    const mend = server({
      "GET /projects/p_shop/worktrees": { worktrees: [{ id: "wt_1", name: "checkout" }] },
      "GET /projects/p_shop/worktrees/wt_1/resources/env": {
        env: { PGHOST: "db" },
        exports: ["export DATABASE_URL='postgres://postgres@db:5432/own_0123456789ab'"],
        statusLines: ["@db · PGHOST left as the project sets it"],
      },
    });
    await resourceCommand(mend.api, async () => shop, ["env", "--worktree", "checkout"]);
    expect(out.join("")).toBe(
      "export DATABASE_URL='postgres://postgres@db:5432/own_0123456789ab'\n" +
        "# @db · PGHOST left as the project sets it\n",
    );
  });

  it("names the verbs it speaks", async () => {
    exits();
    const err = stderr();
    await expect(
      resourceCommand(server({}).api, async () => shop, ["approve", "db"]),
    ).rejects.toThrow("exit 1");
    expect(err.join("")).toBe(
      'mend: unknown resource command "approve" · try: add, list, remove, use, start, stop, reset, load, env\n',
    );
  });
});

describe("what the terminal receives", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const hostile = pageOf({
    settings: [
      {
        ...db,
        id: "rdef_\u001b]0;owned\u0007",
        statusLine: "@db · postgres 17 · project · added by \u001b[2J\u001b[HTom · not started",
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
      "settings\n" +
        `  @db · postgres 17 · project · added by \\x1b[2J\\x1b[HTom · not started  postgres:17@${pin}  rdef_\\x1b]0;owned\\x07\n`,
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
    expect(out.join("")).toContain("\u001b[2mrdef_\\x1b]0;owned\\x07\u001b[0m");
  });

  it("prints --json as JSON, whatever URLs a spec holds", async () => {
    const out = stdout();
    const withUrl = pageOf({
      ...page,
      settings: [{ ...db, spec: { ...db.spec, env: { ORIGIN: "https://example.com" } } }],
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
