import { ProjectId } from "@mend/domain";
import { describe, expect, it } from "vitest";

import {
  SLACK_DISPLAY_SETTINGS,
  SLACK_REMOVAL_FACTS,
  defaultProjectOptions,
  linkedLine,
  slackLinkLine,
  slackPersonLabel,
} from "./slack.ts";

const workspace = { teamId: "T1", teamName: "Acme HQ" };

describe("slackLinkLine", () => {
  it("says whether Slack is connected and whether the person is linked", () => {
    expect(slackLinkLine({ workspace: null, link: null, defaultProjectId: null })).toBe(
      "Slack is not connected to this organization.",
    );
    expect(slackLinkLine({ workspace, link: null, defaultProjectId: null })).toContain(
      "Not linked in Acme HQ",
    );
    expect(
      slackLinkLine({
        workspace,
        link: {
          teamId: "T1",
          slackUserId: "U1",
          userId: "carol",
          userName: "carol",
          createdAt: new Date(),
        },
        defaultProjectId: null,
      }),
    ).toBe("Linked as Slack user U1 in Acme HQ.");
  });
});

describe("defaultProjectOptions", () => {
  it("lists visible projects by name, and says a private one answers only in direct messages", () => {
    expect(
      defaultProjectOptions([
        { id: ProjectId.make("p2"), name: "web", visibility: "shared" },
        { id: ProjectId.make("p1"), name: "api", visibility: "private" },
      ]),
    ).toEqual([
      { id: "p1", label: "api · private, direct messages only" },
      { id: "p2", label: "web" },
    ]);
  });
});

describe("the link page", () => {
  it("names the Slack person by display name and real name, or by id when Slack did not say", () => {
    expect(
      slackPersonLabel({ slackUserId: "U1", slackUserName: "Carol", slackRealName: "Carol Chen" }),
    ).toBe("Carol (Carol Chen)");
    expect(
      slackPersonLabel({ slackUserId: "U1", slackUserName: "Carol", slackRealName: "Carol" }),
    ).toBe("Carol");
    expect(slackPersonLabel({ slackUserId: "U1", slackUserName: null, slackRealName: null })).toBe(
      "U1",
    );
  });

  it("says what happens to the waiting request", () => {
    expect(linkedLine("Acme HQ", true)).toContain("Mend runs your request");
    expect(linkedLine("Acme HQ", false)).toContain("mention @mend in the thread again");
  });
});

describe("Slack copy", () => {
  it("reports and never judges", () => {
    const copy = [
      ...SLACK_REMOVAL_FACTS,
      ...SLACK_DISPLAY_SETTINGS.flatMap((setting) => [setting.label, setting.off, setting.on]),
      linkedLine("Acme", true),
      linkedLine("Acme", false),
    ].join("\n");
    expect(copy).not.toMatch(/\b(done|looks good|safe|success(ful)?|great)\b/i);
  });
});
