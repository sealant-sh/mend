/**
 * The Slack app manifest an organization owner pastes into Slack to create their Mend app
 * (docs/adr/0006-slack.md, "One Slack app per organization, made from Mend's manifest"). The app
 * connects over Socket Mode, so the manifest names no request URL, redirect URL or event URL:
 * Slack never connects to Mend.
 */

/**
 * The bot scopes, exactly as the ADR lists them: Cursor's, less what Mend does not use.
 */
export const SLACK_BOT_SCOPES = [
  // Sees mentions.
  "app_mentions:read",
  // Reads the thread a mention sits in.
  "channels:history",
  "groups:history",
  "im:history",
  "mpim:history",
  // Posts status and replies, and opens a direct message.
  "chat:write",
  "im:write",
  // Marks the request with ⏳, ✅ or ❌.
  "reactions:write",
  // Reads screenshots in the thread.
  "files:read",
  // Shows who wrote each message.
  "users:read",
] as const;

/**
 * The events Mend subscribes to: a mention in a channel, and a direct message to the app, which
 * Slack does not send as `app_mention`. A reply in a channel without a mention never reaches Mend.
 */
export const SLACK_BOT_EVENTS = ["app_mention", "message.im"] as const;

/**
 * The scope of the app-level token (`xapp-…`) that opens the socket. A manifest cannot ask for
 * it: the owner generates the token under Basic Information → App-Level Tokens.
 */
export const SLACK_APP_TOKEN_SCOPE = "connections:write";

export interface SlackManifestOptions {
  /** The app's name in Slack; at most 35 characters. */
  readonly name?: string;
  /** The bot's display name, the `@mend` people type; `a-z`, `0-9`, `-`, `_` and `.` only. */
  readonly botName?: string;
}

export interface SlackManifest {
  readonly _metadata: { readonly major_version: 1; readonly minor_version: 1 };
  readonly display_information: { readonly name: string; readonly description: string };
  readonly features: {
    readonly app_home: {
      readonly home_tab_enabled: false;
      readonly messages_tab_enabled: true;
      readonly messages_tab_read_only_enabled: false;
    };
    readonly bot_user: { readonly display_name: string; readonly always_online: true };
  };
  readonly oauth_config: { readonly scopes: { readonly bot: ReadonlyArray<string> } };
  readonly settings: {
    readonly event_subscriptions: { readonly bot_events: ReadonlyArray<string> };
    readonly interactivity: { readonly is_enabled: true };
    readonly org_deploy_enabled: false;
    readonly socket_mode_enabled: true;
    readonly token_rotation_enabled: false;
  };
}

const botDisplayName = (name: string): string => {
  const cleaned = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
  return cleaned === "" ? "mend" : cleaned.slice(0, 80);
};

/** The manifest, as an object; Slack takes it as JSON. */
export const slackManifest = (options: SlackManifestOptions = {}): SlackManifest => {
  const name = (options.name ?? "Mend").trim().slice(0, 35) || "Mend";
  return {
    _metadata: { major_version: 1, minor_version: 1 },
    display_information: {
      name,
      description: "Start a Mend session by mentioning Mend in a thread.",
    },
    features: {
      app_home: {
        home_tab_enabled: false,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      bot_user: { display_name: botDisplayName(options.botName ?? name), always_online: true },
    },
    oauth_config: { scopes: { bot: [...SLACK_BOT_SCOPES] } },
    settings: {
      event_subscriptions: { bot_events: [...SLACK_BOT_EVENTS] },
      interactivity: { is_enabled: true },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  };
};

/** The manifest as the JSON an owner pastes into "Create an app → From a manifest". */
export const slackManifestJson = (options: SlackManifestOptions = {}): string =>
  JSON.stringify(slackManifest(options), null, 2);

/**
 * What the owner does with the manifest, in order, for Settings → Slack to show beside it. The
 * app-level token step is here because the manifest cannot carry it.
 */
export const SLACK_SETUP_STEPS: ReadonlyArray<string> = [
  "Create an app in Slack from this manifest (api.slack.com/apps → Create New App → From a manifest).",
  `Under Basic Information → App-Level Tokens, generate a token with the ${SLACK_APP_TOKEN_SCOPE} scope. It starts with xapp-.`,
  "Install the app to your workspace, then copy the Bot User OAuth Token from OAuth & Permissions. It starts with xoxb-.",
  "Paste both tokens here. Before it saves them, Mend checks the bot token with auth.test and the app-level token with apps.connections.open, and that both belong to the same app.",
];
