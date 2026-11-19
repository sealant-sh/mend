import { describe, expect, it } from "vitest";

import {
  harnessLabel,
  managedLine,
  SLACK_SWITCHES,
  slackAppLine,
  slackUploadNotice,
  versionOf,
} from "./integrations.ts";

describe("Integrations", () => {
  it("says who connected Slack and how many people linked their account", () => {
    const app = { teamName: "Northwind", installedByName: "Grace Hopper" };
    expect(slackAppLine(app, 6)).toBe(
      "Connected to Northwind by Grace Hopper. 6 people have linked their account.",
    );
    expect(slackAppLine(app, 1)).toMatch(/1 person has linked/);
    expect(slackAppLine(app, 0)).toMatch(/Nobody has linked their account yet\.$/);
    expect(slackAppLine({ teamName: "Northwind", installedByName: null }, null)).toBe(
      "Connected to Northwind.",
    );
  });

  it("offers every thread switch, with what each side means", () => {
    expect(SLACK_SWITCHES.map((setting) => setting.key)).toEqual([
      "showAgentMessages",
      "showDiffs",
      "externalChannels",
      "landAutomatically",
    ]);
    for (const setting of SLACK_SWITCHES) expect(setting.on).not.toBe(setting.off);
  });

  it("asks an owner to update the app only when Slack reported files:write missing", () => {
    expect(slackUploadNotice(null)).toBeNull();
    expect(slackUploadNotice(["chat:write", "files:write"])).toBeNull();
    expect(slackUploadNotice(["chat:write"])).toMatch(/can't upload files/);
  });

  it("names a harness as people call it", () => {
    expect(harnessLabel("claude")).toBe("Claude Code");
    expect(harnessLabel("codex")).toBe("Codex");
    expect(harnessLabel("something-new")).toBe("something-new");
  });

  it("says the Executor Mend runs by its state and version", () => {
    expect(versionOf("ghcr.io/rhyssullivan/executor:v1.4.2")).toBe("v1.4.2");
    expect(versionOf("ghcr.io/rhyssullivan/executor:v1.5.0@sha256:abc")).toBe("v1.5.0");
    expect(versionOf("ghcr.io/rhyssullivan/executor@sha256:abc")).toBeNull();
    expect(managedLine({ state: "running", image: "x/executor:v1.4.2" })).toBe("Running · v1.4.2");
    expect(managedLine({ state: "not-started", image: null })).toBe("Not started");
  });
});
