import { describe, expect, it } from "vitest";

import { mainTestFixtures } from "./main-test-fixtures.ts";

const { json, spawning, startCli, startFakeMend } = mainTestFixtures();

const account = (
  provider: "claude" | "codex" | "github",
  name: string,
  isDefault: boolean,
  login: string,
) => ({
  id: `account-${provider}-${name}`,
  provider,
  name,
  isDefault,
  kind: "oauth-token",
  status: "active",
  metadata: { login },
  connectedAt: "2026-09-18T00:00:00.000Z",
  updatedAt: "2026-09-18T00:00:00.000Z",
  lastUsedAt: null,
});

type Account = ReturnType<typeof account>;

type Served = Omit<Account, "isDefault"> & { readonly isDefault: boolean | undefined };

const older = (row: Account): Served => ({ ...row, isDefault: undefined });

const startAccountsFake = (accounts: ReadonlyArray<object>) => {
  const deleted: Array<string> = [];
  const posted: Array<unknown> = [];
  const fake = startFakeMend((request, response) => {
    if (request.url === "/api/me/sealant" && request.method === "GET") {
      json(response, { sealantUserId: "su-me", accounts });
      return;
    }
    if (request.url === "/api/me/sealant/accounts" && request.method === "POST") {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      request.on("end", () => {
        posted.push(JSON.parse(body));
        json(response, KEY);
      });
      return;
    }
    const removed = /^\/api\/me\/sealant\/accounts\/(.+)$/.exec(request.url ?? "");
    if (removed?.[1] !== undefined && request.method === "DELETE") {
      deleted.push(removed[1]);
      json(
        response,
        accounts.find((row) => "id" in row && row.id === removed[1]),
      );
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  return { fake, deleted, posted };
};

const run = async (
  accounts: ReadonlyArray<object>,
  args: ReadonlyArray<string>,
  stdin?: string,
) => {
  const { fake: started, deleted, posted } = startAccountsFake(accounts);
  const fake = await started;
  try {
    const cli = startCli(fake.url, args, {}, undefined, stdin);
    const exit = await cli.exited;
    return { code: exit.code, stdout: cli.stdout(), stderr: cli.stderr(), deleted, posted };
  } finally {
    await fake.close();
  }
};

const FAKE_KEY = "sk-ant-api03-fake-0000-a1b2";

const KEY = {
  ...account("claude", "api-key", false, ""),
  kind: "api-key",
  metadata: {},
  login: { kind: "api-key", suffix: "a1b2" },
};

const SUBSCRIPTION = {
  ...account("claude", "default", true, "me@example.com"),
  login: { kind: "subscription" },
};

describe("mend accounts", spawning, () => {
  it("shows one account per provider as it always has", async () => {
    const result = await run(
      [
        account("claude", "default", true, "me@example.com"),
        account("github", "default", true, "me"),
      ],
      ["accounts"],
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe(
      [
        "platform user su-me",
        "  claude   connected · me@example.com · since 2026-09-18",
        "  codex    not connected",
        "  github   connected · me · since 2026-09-18",
        "",
      ].join("\n"),
    );
  });

  it("shows the chosen default whatever its name, and says when none is chosen", async () => {
    const result = await run(
      [
        account("claude", "default", false, "old@example.com"),
        account("claude", "work", true, "work@example.com"),
        account("codex", "work", false, "work@example.com"),
        account("codex", "home", false, "home@example.com"),
      ],
      ["accounts"],
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("  claude   connected · work@example.com · since 2026-09-18\n");
    expect(result.stdout).toContain(
      [
        "  codex    No Codex login chosen · 2 connected → mend connect codex --remove <name>",
        "    work · connected · work@example.com · since 2026-09-18",
        "    home · connected · home@example.com · since 2026-09-18",
        "",
      ].join("\n"),
    );
  });

  it("takes the account named default from a Mend server that sends no isDefault", async () => {
    const result = await run(
      [
        older(account("claude", "default", false, "me@example.com")),
        older(account("codex", "work", false, "work@example.com")),
      ],
      ["accounts"],
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("  claude   connected · me@example.com · since 2026-09-18\n");
    expect(result.stdout).toContain(
      "  codex    No Codex login chosen · 1 connected → mend connect codex\n",
    );
  });
});

describe("mend connect --remove", spawning, () => {
  it("disconnects the chosen default, not the first account listed", async () => {
    const result = await run(
      [
        account("claude", "default", false, "old@example.com"),
        account("claude", "work", true, "work@example.com"),
      ],
      ["connect", "claude", "--remove"],
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.deleted).toEqual(["account-claude-work"]);
    expect(result.stdout).toBe("claude: disconnected\n");
  });

  it("disconnects the only account a person holds", async () => {
    const result = await run(
      [account("github", "default", true, "me")],
      ["connect", "github", "--remove"],
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.deleted).toEqual(["account-github-default"]);
  });

  it("removes nothing and lists the accounts when several are held and none is chosen", async () => {
    const result = await run(
      [
        account("codex", "work", false, "work@example.com"),
        account("codex", "home", false, "home@example.com"),
      ],
      ["connect", "codex", "--remove"],
    );
    expect(result.code).toBe(1);
    expect(result.deleted).toEqual([]);
    expect(result.stderr).toBe(
      [
        "mend: codex: No Codex login chosen, so which one to remove is not known · nothing removed → mend connect codex --remove <name>",
        "  work · connected · work@example.com · since 2026-09-18",
        "  home · connected · home@example.com · since 2026-09-18",
        "",
      ].join("\n"),
    );
  });

  it("disconnects the account named, chosen or not", async () => {
    const result = await run(
      [
        account("codex", "work", false, "work@example.com"),
        account("codex", "home", false, "home@example.com"),
      ],
      ["connect", "codex", "--remove", "home"],
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.deleted).toEqual(["account-codex-home"]);
  });

  it("removes nothing when no account has the name given", async () => {
    const result = await run(
      [account("codex", "work", true, "work@example.com")],
      ["connect", "codex", "--remove", "home"],
    );
    expect(result.code).toBe(1);
    expect(result.deleted).toEqual([]);
    expect(result.stderr).toBe("mend: codex: no account named home · nothing removed\n");
  });

  it("refuses when nothing is connected", async () => {
    const result = await run([], ["connect", "claude", "--remove"]);
    expect(result.code).toBe(1);
    expect(result.deleted).toEqual([]);
    expect(result.stderr).toBe("mend: claude: nothing connected\n");
  });
});

describe("an API key", spawning, () => {
  it("is listed beside the subscription in the words of ADR 0018, the default marked", async () => {
    const result = await run([SUBSCRIPTION, KEY], ["accounts"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      [
        "  claude   connected · Claude · subscription · me@example.com · since 2026-09-18 · default",
        "           connected · Claude · API key ····a1b2 · billed per token · since 2026-09-18",
        "",
      ].join("\n"),
    );
  });

  it("is read from stdin, sent as a key, and never printed", async () => {
    const result = await run(
      [SUBSCRIPTION],
      ["connect", "claude", "--api-key", "--default"],
      FAKE_KEY,
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.posted).toEqual([
      { provider: "claude", secret: FAKE_KEY, login: "api-key", makeDefault: true },
    ]);
    expect(result.stdout).toContain("Claude · API key ····a1b2 · billed per token");
    expect(result.stdout).toContain(
      "Set a spend limit on the key's workspace in the Anthropic Console",
    );
    expect(result.stdout + result.stderr).not.toContain(FAKE_KEY);
  });

  it("answers --json with the login's class and last four characters only", async () => {
    const result = await run([], ["connect", "claude", "--api-key", "--json"], FAKE_KEY);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}")).toMatchObject({
      status: "done",
      data: { account: { login: { kind: "api-key", suffix: "a1b2" } } },
    });
    expect(result.posted).toEqual([{ provider: "claude", secret: FAKE_KEY, login: "api-key" }]);
    expect(result.stdout + result.stderr).not.toContain(FAKE_KEY);
  });

  it("is disconnected on its own, and Mend says it stays valid until revoked", async () => {
    const result = await run([SUBSCRIPTION, KEY], ["connect", "claude", "--api-key", "--remove"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.deleted).toEqual(["account-claude-api-key"]);
    expect(result.stdout).toBe(
      "claude: disconnected · The key stays valid at Anthropic until you revoke it in the Anthropic Console.\n",
    );
  });

  it("is refused for GitHub, and nothing is sent", async () => {
    const result = await run([], ["connect", "github", "--api-key"], FAKE_KEY);
    expect(result.code).toBe(1);
    expect(result.posted).toEqual([]);
  });
});
