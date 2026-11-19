/**
 * Settings → the organization → Audit log (route PR 51, Doop "Settings · Northwind · Audit log"):
 * each recorded action as one sentence, the project it happened in when the page can name it, and
 * when it happened. Pure, so every sentence is tested without a server.
 *
 * The server answers a page of events at a time, newest first (`organization.audit`, `before` the
 * previous page's last id). It names the actor and, for a member event, the member; everything
 * else the sentence names (a person given shared control, a project) the page looks up in what it
 * already read, and says by id only when it can't.
 */

/** One event as the page reads it (the API's `AuditEntry`). */
export interface AuditEntryView {
  readonly event: {
    readonly id: string;
    readonly actorUserId: string;
    readonly action: string;
    readonly subjectType: string;
    readonly subjectId: string;
    readonly data: Readonly<Record<string, string | number | boolean | null>>;
    readonly createdAt: Date;
    readonly accessKey: { readonly id: string; readonly name: string } | null;
  };
  readonly actorName: string;
  readonly subjectName: string | null;
}

/** What a sentence can name besides what the server sent. */
export interface AuditNames {
  readonly organization: string;
  /** People by account id: the roster. */
  readonly people: ReadonlyMap<string, string>;
  /** Projects by id: the projects this owner can see. */
  readonly projects: ReadonlyMap<string, string>;
}

/** The server's page size: a shorter page is the last one. */
export const AUDIT_PAGE_SIZE = 50;

/** The id the next page starts before, or undefined after the last page. */
export const nextAuditPage = (page: ReadonlyArray<AuditEntryView>): string | undefined =>
  page.length < AUDIT_PAGE_SIZE ? undefined : page.at(-1)?.event.id;

const TIME = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });
const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });
const DAY_IN_YEAR = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

/** "Today, 10:58", "Yesterday, 18:04", "12 Nov, 17:30", "24 Dec 2025, 09:00". */
export const whenLine = (at: Date, now: Date = new Date()): string => {
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const time = TIME.format(at);
  if (at.toDateString() === now.toDateString()) return `Today, ${time}`;
  if (at.toDateString() === yesterday.toDateString()) return `Yesterday, ${time}`;
  return `${(at.getFullYear() === now.getFullYear() ? DAY : DAY_IN_YEAR).format(at)}, ${time}`;
};

const text = (value: string | number | boolean | null | undefined): string | null =>
  typeof value === "string" && value !== "" ? value : null;

/** A session by the start of its id, as the session's page address shows it. */
const sessionWords = (id: string): string => `session ${id.slice(0, 8)}`;

const roleWords = (role: string | null): string => (role === "owner" ? "an owner" : "a member");

/** The organization's defaults by the words the old Settings used for them. */
const SETTING_WORDS: Readonly<Record<string, string>> = {
  workspaceImage: "the workspace image",
  autoTour: "description and tour",
  autoSuggest: "fix suggestions",
  autoName: "session naming",
  autoLand: "landing when a turn completes",
  backgroundSessions: "background sessions",
  sessionRuntime: "where new sessions run",
};

const RUNTIME_WORDS: Readonly<Record<string, string>> = {
  docker: "this server's Docker",
  boat: "Boat",
};

const settingFact = (key: string, value: string | number | boolean | null): string => {
  if (key === "sessionRuntime")
    return value === null
      ? "the server's default"
      : (RUNTIME_WORDS[String(value)] ?? String(value));
  if (value === null) return "the server's value";
  if (typeof value === "boolean") return value ? "on" : "off";
  return String(value);
};

const SLACK_SETTING_WORDS: Readonly<Record<string, string>> = {
  defaultHarness: "Default agent",
  showAgentMessages: "Agent messages",
  showDiffs: "Diffs",
  externalChannels: "External channels",
  landAutomatically: "Land automatically",
};

const slackSetting = (key: string, value: string | number | boolean | null): string => {
  const words = SLACK_SETTING_WORDS[key] ?? key;
  if (typeof value === "boolean") return `Turned ${value ? "on" : "off"} ${words}`;
  return `Set ${words} to ${String(value)}`;
};

const SLACK_PROJECT_SOURCE_WORDS: Readonly<Record<string, string>> = {
  message: "named in the request",
  "thread-session": "the thread's session",
  "thread-link": "from a link in the thread",
  "thread-inference": "from the thread",
  "channel-default": "the channel's default",
  "personal-default": "their default",
  picked: "picked",
};

/** The project an event happened in, by name, when the page can tell. */
export const projectOf = (entry: AuditEntryView, names: AuditNames): string | null => {
  const { event } = entry;
  const named = text(event.data["projectName"]);
  if (named !== null) return named;
  const id =
    event.subjectType === "project" ? event.subjectId : (text(event.data["projectId"]) ?? null);
  if (id === null) return null;
  return (
    names.projects.get(id) ?? (event.subjectType === "project" ? text(event.data["name"]) : null)
  );
};

/** "Grace Hopper" for an account id the roster knows; "someone no longer here" otherwise. */
const personOf = (id: string | null, names: AuditNames): string =>
  id === null ? "someone" : (names.people.get(id) ?? "someone no longer here");

/**
 * One event as the sentence the log shows, without who or when (the row shows those). Member
 * events name the account the server resolved, removed members included.
 */
export const describeAudit = (entry: AuditEntryView, names: AuditNames): string => {
  const { event } = entry;
  const subject = entry.subjectName ?? personOf(event.subjectId, names);
  const name = text(event.data["name"]);
  const project = projectOf(entry, names) ?? name ?? "a project";
  const organization = names.organization;
  switch (event.action) {
    case "invitation.created":
      return `Created an invitation link to join as ${roleWords(text(event.data["role"]))}${event.data["emailBound"] === true ? ", for one email address" : ""}`;
    case "invitation.revoked":
      return "Revoked an invitation link";
    case "invitation.accepted":
      return `Joined ${organization} as ${roleWords(text(event.data["role"]))}`;
    case "member.role_changed":
      return `Made ${subject} ${roleWords(text(event.data["role"]))}`;
    case "member.added":
      return `Added ${subject} as ${roleWords(text(event.data["role"]))}`;
    case "member.removed":
      return `Removed ${subject} from ${organization}`;
    case "member.left":
      return `Left ${organization}`;
    case "member.password_reset_issued":
      return `Created a password reset link for ${subject}`;
    case "project.renamed":
      return `Renamed ${text(event.data["previousName"]) ?? "a project"} to ${name ?? project}`;
    case "project.visibility_changed":
      return text(event.data["visibility"]) === "shared"
        ? `Shared ${project} with everyone in ${organization}`
        : `Made ${project} private`;
    case "project.removed":
      return `Removed ${project}`;
    case "project.restored":
      return `Restored ${project}`;
    case "project.purge_started":
      return `Started deleting ${project} for good`;
    case "project.purged":
      return `Deleted ${project} for good`;
    case "project.taken_over":
      return `Took over ${project}`;
    case "project.environment_moved":
      return `Moved ${project} from the image ${text(event.data["from"]) ?? "?"} to ${text(event.data["to"]) ?? "?"}, which ${text(event.data["runtime"]) ?? "its new runtime"} runs`;
    case "folder.created":
      return `Created the folder ${name ?? event.subjectId}`;
    case "folder.renamed":
      return `Renamed the folder ${text(event.data["from"]) ?? "?"} to ${name ?? event.subjectId}`;
    case "folder.removed":
      return `Removed the folder ${name ?? event.subjectId}`;
    case "reference.added":
      return `Added the reference ${name ?? event.subjectId}`;
    case "reference.removed":
      return `Removed the reference ${name ?? event.subjectId}`;
    case "session.shared_control_on":
      return `Shared control of ${sessionWords(event.subjectId)} with everyone who can see it`;
    case "session.shared_control_off":
      return `Turned off shared control of ${sessionWords(event.subjectId)}`;
    case "session.shared_control_granted":
      return `Shared control of ${sessionWords(event.subjectId)} with ${personOf(text(event.data["userId"]), names)}`;
    case "session.shared_control_taken_back":
      return `Took back shared control of ${sessionWords(event.subjectId)} from ${personOf(text(event.data["userId"]), names)}`;
    case "session.unsaved_discarded": {
      const words = text(event.data["words"]);
      return `Stopped ${sessionWords(event.subjectId)} and discarded what it hadn't saved${words === null ? "" : ` · ${words}`}`;
    }
    case "session.stopped_no_access": {
      const words = text(event.data["words"]);
      return `Mend stopped their ${sessionWords(event.subjectId)}${words === null ? "" : ` · ${words}`}`;
    }
    case "session.conversation_imported":
      return `Imported a ${text(event.data["harness"]) === "codex" ? "Codex" : "Claude"} conversation into ${sessionWords(event.subjectId)}`;
    case "worktree.handed_off": {
      const session = text(event.data["sessionId"]);
      return `Handed off a checkout into a new session${session === null ? "" : `, ${sessionWords(session)}`}`;
    }
    case "organization.created":
      return `Created ${name ?? organization}`;
    case "organization.renamed":
      return `Renamed the organization to ${name ?? organization}`;
    case "organization.settings_changed": {
      const changed = Object.entries(event.data).map(
        ([key, value]) => `${SETTING_WORDS[key] ?? key} to ${settingFact(key, value)}`,
      );
      return changed.length === 0
        ? `Changed ${organization}'s settings`
        : `Set ${changed.join(", ")}`;
    }
    case "organization.environment_moved":
      return `Moved ${organization}'s starting image from ${text(event.data["from"]) ?? "?"} to ${text(event.data["to"]) ?? "?"}, which ${text(event.data["runtime"]) ?? "its new runtime"} runs`;
    case "recovery.owner_granted":
      return `Made ${subject} an owner, as this server's operator`;
    case "recovery.password_reset_issued":
      return `Created a password reset link for ${subject}, as this server's operator`;
    case "slack.installed":
      return `Connected the Slack workspace ${text(event.data["teamName"]) ?? event.subjectId}`;
    case "slack.replaced":
      return event.data["linksKept"] === false
        ? `Connected the Slack workspace ${text(event.data["teamName"]) ?? event.subjectId} in place of the previous one, dropping its links`
        : "Replaced the Slack app's tokens";
    case "slack.removed":
      return `Removed the Slack app from ${text(event.data["teamName"]) ?? event.subjectId}`;
    case "slack.settings_changed": {
      const changed = Object.entries(event.data).map(([key, value]) => slackSetting(key, value));
      return changed.length === 0
        ? "Changed the Slack app's settings"
        : `${changed.join(", ")} for the Slack app`;
    }
    case "slack.link_created":
      return `Linked ${subject}'s Slack account`;
    case "slack.link_removed":
      return event.data["memberRemoved"] === true
        ? `Removed ${subject}'s Slack link with their membership`
        : `Removed ${subject}'s Slack link`;
    case "slack.session_started": {
      const source = text(event.data["projectSource"]);
      const why =
        source === null ? "" : ` (project ${SLACK_PROJECT_SOURCE_WORDS[source] ?? source})`;
      return `Started ${sessionWords(event.subjectId)} from Slack${why}`;
    }
    case "slack.channel_default_set":
      return `Made ${project} the default project of a Slack channel`;
    case "slack.channel_default_cleared":
      return `Cleared ${project} as the default project of a Slack channel`;
    case "change.landed": {
      const branch = text(event.data["remoteBranch"]) ?? "?";
      const pushed = text(event.data["pushedSha"]);
      switch (text(event.data["outcome"])) {
        case "pull-request":
          return `Opened pull request #${String(event.data["pullRequest"])} from ${branch}`;
        case "pushed":
          return `Pushed to ${branch}${pushed === null ? "" : ` at ${pushed.slice(0, 7)}`}`;
        case "refused":
          return `Tried to push to ${branch}; the remote refused it`;
        default:
          return `Tried to land a change on ${branch}; it failed`;
      }
    }
    case "change.pull_request_refreshed":
      return `Read pull request #${String(event.data["pullRequest"])} again: ${text(event.data["state"]) ?? "?"}`;
    case "change.bundle_downloaded":
      return `Downloaded a change as a bundle from ${text(event.data["branch"]) ?? "?"}`;
    case "change.pull_request_adopted":
      return `Recorded pull request #${String(event.data["pullRequest"])}, opened outside Mend: ${text(event.data["state"]) ?? "?"}`;
    case "ssh_key.added":
    case "ssh_key.removed": {
      const key = `the workspace SSH key ${text(event.data["fingerprint"]) ?? "?"}${name === null ? "" : ` (${name})`}`;
      if (event.data["memberRemoved"] === true)
        return `Removed ${key} of ${subject} with their membership`;
      const verb = event.action === "ssh_key.added" ? "Added" : "Removed";
      return event.actorUserId === event.subjectId
        ? `${verb} ${key}`
        : `${verb} ${key} of ${subject}`;
    }
    case "ssh_key.revocation_pending": {
      const outstanding = event.data["outstanding"];
      return typeof outstanding === "number"
        ? `Removed ${subject}; Mend is still removing ${outstanding} of their workspace SSH keys`
        : `Removed ${subject}; Mend is still removing their workspace SSH keys`;
    }
    case "access_key.created":
      return `Created the access key ${name ?? event.subjectId}`;
    case "access_key.revoked":
      return `Revoked the access key ${name ?? event.subjectId}`;
    case "access_key.used":
      return `Used the access key ${name ?? event.subjectId}`;
    case "boat_key.connected":
      return event.data["key"] === "own"
        ? "Connected their own Boat key"
        : `Connected ${organization}'s Boat key`;
    case "boat_key.replaced":
      return event.data["key"] === "own"
        ? "Replaced their own Boat key"
        : `Replaced ${organization}'s Boat key`;
    case "boat_key.removed":
      return event.data["key"] === "own"
        ? "Removed their own Boat key"
        : `Removed ${organization}'s Boat key`;
    case "boat_key.wallet_changed": {
      const walletName = text(event.data["walletName"]);
      const wallet =
        event.data["wallet"] === "personal"
          ? "the key's own Boat account"
          : `the Boat organization ${walletName ?? String(event.data["wallet"])}`;
      return `Pointed ${event.data["key"] === "own" ? "their own" : `${organization}'s`} Boat key at ${wallet}`;
    }
    default:
      // An action this page doesn't know yet (a newer server): say what the server called it.
      return `${event.action.replaceAll(/[._]/g, " ")} (${event.subjectType} ${event.subjectId})`;
  }
};

/**
 * The access key an action was taken with (docs/adr/0023-access-keys.md, "Audit"), beside the
 * sentence; null when the person acted without one, or when the event is about that key.
 */
export const accessKeyNote = (event: AuditEntryView["event"]): string | null =>
  event.accessKey === null ||
  (event.subjectType === "access_key" && event.subjectId === event.accessKey.id)
    ? null
    : `with the access key ${event.accessKey.name}`;
