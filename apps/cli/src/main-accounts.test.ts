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

/** A Mend that lists `accounts` and records every account `DELETE` it receives. */
const startAccountsFake = (accounts: ReadonlyArray<Account>) => {
  const deleted: Array<string> = [];
  const fake = startFakeMend((request, response) => {
    if (request.url === "/api/me/sealant" && request.method === "GET") {
      json(response, { sealantUserId: "su-me", accounts });
      return;
    }
    const removed = /^\/api\/me\/sealant\/accounts\/(.+)$/.exec(request.url ?? "");
    if (removed?.[1] !== undefined && request.method === "DELETE") {
      deleted.push(removed[1]);
      json(
        response,
        accounts.find((row) => row.id === removed[1]),
      );
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  return { fake, deleted };
};

const run = async (accounts: ReadonlyArray<Account>, args: ReadonlyArray<string>) => {
  const { fake: started, deleted } = startAccountsFake(accounts);
  const fake = await started;
  try {
    const cli = startCli(fake.url, args);
    const exit = await cli.exited;
    return { code: exit.code, stdout: cli.stdout(), stderr: cli.stderr(), deleted };
  } finally {
    await fake.close();
  }
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
    expect(result.stdout).toContain("  codex    No Codex login chosen · 2 connected\n");
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
        "mend: codex: No Codex login chosen, so which one to remove is not known · nothing removed",
        "  work · connected · work@example.com · since 2026-09-18",
        "  home · connected · home@example.com · since 2026-09-18",
        "",
      ].join("\n"),
    );
  });

  it("refuses when nothing is connected", async () => {
    const result = await run([], ["connect", "claude", "--remove"]);
    expect(result.code).toBe(1);
    expect(result.deleted).toEqual([]);
    expect(result.stderr).toBe("mend: claude: nothing connected\n");
  });
});
