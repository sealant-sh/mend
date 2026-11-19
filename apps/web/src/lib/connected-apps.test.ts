import { describe, expect, it } from "vitest";

import { disconnectDopplerWords, dopplerLine, executorLine, slackLine } from "./connected-apps.ts";

const NOV_4 = new Date(2026, 10, 4, 12);

describe("Connected apps", () => {
  it("says where Slack stands: not connected, not linked, linked", () => {
    expect(slackLine({ workspace: null, link: null }, "Northwind")).toBe(
      "Northwind hasn't connected Slack. An owner connects it in Integrations.",
    );
    expect(slackLine({ workspace: { teamName: "Northwind" }, link: null }, "Northwind")).toMatch(
      /^Not linked\. Mention @mend in Northwind's Slack/,
    );
    expect(
      slackLine(
        {
          workspace: { teamName: "Northwind" },
          link: { slackUserId: "U04R2K7N1", createdAt: NOV_4 },
        },
        "Northwind",
      ),
    ).toMatch(/^Linked as Slack user U04R2K7N1 in Northwind on /);
  });

  it("names the organization's shared Executor account until the person links their own", () => {
    expect(executorLine("unlinked", "Northwind")).toBe(
      "Not linked. Until you link, your sessions use Northwind's shared Executor account.",
    );
    expect(executorLine("refused", "Northwind")).toMatch(/^Executor refused your link\./);
    expect(executorLine("active", "Northwind")).toMatch(/^Linked\./);
  });

  it("says whether a config is picked anywhere, and never anything about the token", () => {
    expect(dopplerLine({ connected: false, updatedAt: null, mappings: [] })).toBe(
      "Not connected. Connect it to use your Doppler secrets in sessions.",
    );
    expect(dopplerLine({ connected: true, updatedAt: null, mappings: [] })).toBe(
      "Connected. You haven't picked a config in any project yet.",
    );
    expect(dopplerLine({ connected: true, updatedAt: NOV_4, mappings: [{}] })).toMatch(
      /^Connected on .+\. Your sessions can run doppler run in the projects where you've picked a config\.$/,
    );
  });

  it("counts the configs a disconnect deletes from what the server returned", () => {
    expect(disconnectDopplerWords(3)).toBe(
      "Mend deletes your token and the config you picked in 3 projects. Sessions that are already running keep working until they stop.",
    );
    expect(disconnectDopplerWords(1)).toMatch(/in 1 project\./);
    expect(disconnectDopplerWords(0)).toBe(
      "Mend deletes your token. You haven't picked a config in any project. Sessions that are already running keep working until they stop.",
    );
  });
});
