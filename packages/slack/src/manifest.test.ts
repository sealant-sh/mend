import { describe, expect, it } from "vitest";

import {
  SLACK_APP_TOKEN_SCOPE,
  SLACK_SETUP_STEPS,
  slackManifest,
  slackManifestJson,
} from "./manifest.ts";

describe("the Slack app manifest", () => {
  it("asks for exactly the bot scopes the ADR lists", () => {
    expect(slackManifest().oauth_config.scopes.bot.toSorted()).toEqual(
      [
        "app_mentions:read",
        "channels:history",
        "chat:write",
        "files:read",
        "groups:history",
        "im:history",
        "im:write",
        "mpim:history",
        "reactions:write",
        "users:read",
      ].toSorted(),
    );
  });

  it("connects over Socket Mode, with interactivity and the app_mention event only", () => {
    const manifest = slackManifest();
    expect(manifest.settings).toEqual({
      event_subscriptions: { bot_events: ["app_mention"] },
      interactivity: { is_enabled: true },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    });
    // Slack never connects to Mend: no request, redirect or event URL anywhere.
    expect(slackManifestJson()).not.toMatch(/_url"/);
  });

  it("names the app and its bot", () => {
    expect(slackManifest().display_information.name).toBe("Mend");
    expect(slackManifest().features.bot_user.display_name).toBe("mend");
    const custom = slackManifest({ name: "Mend (Acme)", botName: "Mend Acme" });
    expect(custom.display_information.name).toBe("Mend (Acme)");
    expect(custom.features.bot_user.display_name).toBe("mend-acme");
    expect(slackManifest({ name: "x".repeat(50) }).display_information.name).toHaveLength(35);
  });

  it("is JSON Slack can take as pasted", () => {
    expect(JSON.parse(slackManifestJson())).toEqual(slackManifest());
  });

  it("tells the owner to make the app-level token the manifest cannot carry", () => {
    expect(SLACK_APP_TOKEN_SCOPE).toBe("connections:write");
    expect(SLACK_SETUP_STEPS.join("\n")).toContain("connections:write");
    expect(SLACK_SETUP_STEPS.join("\n")).toContain("xapp-");
    expect(SLACK_SETUP_STEPS.join("\n")).toContain("xoxb-");
  });
});
