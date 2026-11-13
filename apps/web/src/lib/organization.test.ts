import { AccountOrganization } from "@mend/api-contracts";
import { AuditEventId, OrganizationId } from "@mend/domain";
import { AuditEvent, Organization, type OrganizationRole } from "@mend/domain/workbench";
import { describe, expect, it } from "vitest";

import {
  accessDestination,
  auditAccessKeyNote,
  canLeaveOrganization,
  describeAudit,
  describeMemberRemoval,
  formatBytes,
  joinState,
  organizationMenu,
  planUpload,
  shownOrganizationMoved,
  stagedPath,
  toBase64,
} from "./organization.ts";

const JOINED = new Date("2026-11-01T09:00:00Z");
const membership = (id: string, name: string, role: OrganizationRole, active: boolean) =>
  new AccountOrganization({
    organization: new Organization({
      id: OrganizationId.make(id),
      name,
      createdByUserId: null,
      createdAt: JOINED,
      updatedAt: JOINED,
    }),
    role,
    joinedAt: JOINED,
    active,
  });

describe("organizationMenu", () => {
  const acme = membership("org-acme", "Acme", "owner", true);
  const beta = membership("org-beta", "Beta", "member", false);

  it("shows nothing in single tenancy, even when the list answered", () => {
    expect(organizationMenu("single", [acme])).toBeNull();
  });

  it("shows nothing before tenancy and the list both answered", () => {
    expect(organizationMenu(undefined, [acme, beta])).toBeNull();
    expect(organizationMenu("multi", undefined)).toBeNull();
  });

  it("names the one this sign-in acts in apart from the ones to switch to", () => {
    const menu = organizationMenu("multi", [acme, beta]);
    expect(menu?.current.organization.name).toBe("Acme");
    expect(menu?.others.map((other) => [other.organization.name, other.role])).toEqual([
      ["Beta", "member"],
    ]);
  });

  it("shows a lone organization with nothing to switch to", () => {
    expect(organizationMenu("multi", [acme])?.others).toEqual([]);
  });
});

describe("canLeaveOrganization", () => {
  it("is never offered for the account's only organization", () => {
    expect(canLeaveOrganization({ memberships: 1, role: "member", owners: 2 })).toBe(false);
  });

  it("is offered to a member with another organization", () => {
    expect(canLeaveOrganization({ memberships: 2, role: "member", owners: 1 })).toBe(true);
  });

  it("is never offered to the last owner, and is to one of several", () => {
    expect(canLeaveOrganization({ memberships: 3, role: "owner", owners: 1 })).toBe(false);
    expect(canLeaveOrganization({ memberships: 2, role: "owner", owners: 2 })).toBe(true);
  });
});

describe("after an access event", () => {
  it("goes to Now when the account still belongs to another organization", () => {
    expect(accessDestination({ organizationId: "org-acme" })).toBe("home");
  });

  it("goes to sign-in when it lost its last organization", () => {
    expect(accessDestination({})).toBe("sign-in");
  });
});

describe("after one of the account's sign-ins switched", () => {
  it("starts the tab over only when its own sign-in now acts elsewhere", () => {
    expect(shownOrganizationMoved("org-acme", "org-beta")).toBe(true);
    expect(shownOrganizationMoved("org-acme", "org-acme")).toBe(false);
  });

  it("leaves a tab alone that never read its organization, or whose read failed", () => {
    expect(shownOrganizationMoved(undefined, "org-beta")).toBe(false);
    expect(shownOrganizationMoved("org-acme", undefined)).toBe(false);
  });
});

const event = (
  action: AuditEvent["action"],
  data: AuditEvent["data"] = {},
  subjectName: string | null = null,
) => ({
  subjectName,
  event: new AuditEvent({
    id: AuditEventId.make("audit-1"),
    organizationId: OrganizationId.make("org-1"),
    actorUserId: "alice",
    action,
    subjectType: "member",
    subjectId: "carol",
    data,
    createdAt: new Date("2026-09-17T10:00:00Z"),
    accessKey: null,
  }),
});

describe("describeAudit", () => {
  it("says what happened in plain words", () => {
    expect(describeAudit(event("member.role_changed", { role: "owner" }))).toBe(
      "made carol an owner",
    );
    expect(
      describeAudit(event("worktree.handed_off", { projectId: "p-1", sessionId: "s-1" })),
    ).toBe("handed off a checkout into worktree carol · session s-1");
    expect(describeAudit(event("member.removed", {}, "Carol Chen"))).toBe("removed Carol Chen");
    expect(
      describeAudit({
        ...event("session.stopped_no_access", {
          reason: "no_standing",
          words: "stopped · you can no longer see this project",
        }),
      }),
    ).toContain("stopped · you can no longer see this project");
    expect(describeAudit(event("folder.created", { name: "fixtures" }))).toBe(
      "created folder fixtures",
    );
    expect(describeAudit(event("invitation.accepted", { role: "member" }))).toBe(
      "joined as member",
    );
  });
});

describe("describeAudit for organization defaults (docs/adr/0003)", () => {
  it("names each changed default and its new value", () => {
    expect(
      describeAudit(
        event("organization.settings_changed", {
          workspaceImage: "fedora · 2 packages",
          autoLand: true,
          autoTour: null,
        }),
      ),
    ).toBe(
      "set the organization defaults: workspace environment fedora · 2 packages, land when a turn completes on, description & tour follows the instance",
    );
    expect(describeAudit(event("organization.settings_changed", {}))).toBe(
      "changed the organization defaults",
    );
  });

  it("says where new sessions run, in plain words", () => {
    expect(describeAudit(event("organization.settings_changed", { sessionRuntime: "boat" }))).toBe(
      "set the organization defaults: new sessions run on Boat",
    );
    expect(
      describeAudit(event("organization.settings_changed", { sessionRuntime: "docker" })),
    ).toBe("set the organization defaults: new sessions run on this server's Docker");
    expect(describeAudit(event("organization.settings_changed", { sessionRuntime: null }))).toBe(
      "set the organization defaults: new sessions run on the server's default",
    );
  });
});

describe("describeAudit for the Boat key (SLNT-790)", () => {
  it("says what happened to the key and never names it", () => {
    expect(describeAudit(event("boat_key.connected", {}))).toBe(
      "connected the organization's Boat key",
    );
    expect(describeAudit(event("boat_key.replaced", {}))).toBe(
      "replaced the organization's Boat key",
    );
    expect(describeAudit(event("boat_key.removed", {}))).toBe(
      "removed the organization's Boat key",
    );
  });
});

describe("describeAudit for Slack (docs/adr/0006)", () => {
  it("names the workspace, what changed, and whose link", () => {
    expect(describeAudit(event("slack.installed", { teamName: "Acme HQ" }))).toBe(
      "connected the Slack workspace Acme HQ",
    );
    expect(
      describeAudit(
        event("slack.replaced", { teamName: "Acme HQ", previousTeamId: "T-old", linksKept: false }),
      ),
    ).toBe("connected the Slack workspace Acme HQ in place of T-old, dropping its links");
    expect(describeAudit(event("slack.settings_changed", { showDiffs: true }))).toBe(
      "set Slack show diffs true",
    );
    expect(describeAudit(event("slack.settings_changed", { landAutomatically: false }))).toBe(
      "set Slack land automatically false",
    );
    expect(describeAudit(event("slack.link_created", { slackUserId: "U1" }, "Carol Chen"))).toBe(
      "linked Slack user U1 to Carol Chen",
    );
    expect(
      describeAudit(
        event("slack.link_removed", { slackUserId: "U1", memberRemoved: true }, "Carol"),
      ),
    ).toBe("removed the Slack link of Carol with their membership");
    const ownKey = event("ssh_key.added", { fingerprint: "SHA256:abc", name: "laptop" }, "Carol");
    expect(
      describeAudit({
        ...ownKey,
        event: new AuditEvent({ ...ownKey.event, actorUserId: "carol" }),
      }),
    ).toBe("registered workspace SSH key SHA256:abc (laptop)");
    expect(
      describeAudit(
        event("ssh_key.removed", { fingerprint: "SHA256:abc", name: "laptop" }, "Carol"),
      ),
    ).toBe("removed the workspace SSH key SHA256:abc (laptop) of Carol");
    expect(
      describeAudit(
        event("ssh_key.removed", { fingerprint: "SHA256:abc", memberRemoved: true }, "Carol"),
      ),
    ).toBe("removed the workspace SSH key SHA256:abc of Carol with their membership");
    expect(
      describeAudit(
        event(
          "ssh_key.removed",
          { fingerprint: "SHA256:abc", memberRemoved: true, attempt: 3 },
          "Carol",
        ),
      ),
    ).toBe("removed the workspace SSH key SHA256:abc of Carol with their membership · attempt 3");
    expect(
      describeAudit(event("ssh_key.revocation_pending", { removed: 99, outstanding: 2 }, "Carol")),
    ).toBe(
      "removed Carol · 2 of their workspace SSH keys could not be removed yet; Mend keeps trying",
    );
    expect(
      describeAudit(
        event("ssh_key.revocation_pending", { removed: 0, outstanding: null }, "Carol"),
      ),
    ).toBe(
      "removed Carol · their workspace SSH keys are not all confirmed removed yet; Mend keeps trying",
    );
    expect(describeMemberRemoval({ sshKeysOutstanding: 0 })).toBeNull();
    expect(describeMemberRemoval({ sshKeysOutstanding: 1 })).toBe(
      "member removed · 1 of their workspace SSH keys could not be removed yet; Mend keeps trying",
    );
    expect(
      describeAudit(
        event("slack.session_started", {
          projectName: "billing-api",
          projectSource: "channel-default",
          slackUserId: "U1",
        }),
      ),
    ).toBe("started session carol from Slack in billing-api · channel default");
    expect(
      describeAudit(
        event("slack.channel_default_set", { channelId: "C1", projectName: "billing-api" }),
      ),
    ).toBe("set the default project of Slack channel C1 to billing-api");
    expect(
      describeAudit(
        event("slack.channel_default_cleared", { channelId: "C1", projectName: "billing-api" }),
      ),
    ).toBe("cleared the default project of Slack channel C1 (was billing-api)");
  });

  it("words a landing by what origin and GitHub answered", () => {
    const onChange = (action: AuditEvent["action"], data: AuditEvent["data"]) => ({
      subjectName: null,
      event: new AuditEvent({
        ...event(action, data).event,
        subjectType: "change",
        subjectId: "change-1",
      }),
    });
    const landed = (data: AuditEvent["data"]) => describeAudit(onChange("change.landed", data));
    expect(
      landed({ outcome: "pull-request", remoteBranch: "mend/fix-login", pullRequest: 412 }),
    ).toBe("pushed change change-1 to mend/fix-login · pull request #412");
    expect(
      landed({
        outcome: "pushed",
        remoteBranch: "mend/fix-login",
        pushedSha: "3f2a1c0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    ).toBe("pushed change change-1 to mend/fix-login · 3f2a1c0");
    expect(landed({ outcome: "refused", remoteBranch: "mend/fix-login" })).toBe(
      "landing of change change-1 refused by origin · mend/fix-login",
    );
    expect(landed({ outcome: "failed", remoteBranch: "mend/fix-login" })).toBe(
      "landing of change change-1 failed · mend/fix-login",
    );
    expect(
      describeAudit(
        onChange("change.pull_request_refreshed", { pullRequest: 412, state: "merged" }),
      ),
    ).toBe("read pull request #412 of change change-1 · merged");
    expect(
      describeAudit(
        onChange("change.bundle_downloaded", {
          branch: "mend/fix-login",
          tip: "3f2a1c0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          commits: 2,
        }),
      ),
    ).toBe("downloaded change change-1 as a bundle · mend/fix-login · 3f2a1c0");
  });
});

describe("describeAudit for access keys (docs/adr/0023)", () => {
  const ciBot = { id: "key-1", name: "ci-bot" };
  const onKey = (action: AuditEvent["action"], accessKey: typeof ciBot | null) =>
    new AuditEvent({
      ...event(action, { name: "ci-bot" }).event,
      subjectType: "access_key",
      subjectId: "key-1",
      accessKey,
    });

  it("names the key a person created, revoked or used", () => {
    expect(
      [
        onKey("access_key.created", null),
        onKey("access_key.revoked", null),
        onKey("access_key.used", ciBot),
      ].map((audited) => describeAudit({ event: audited, subjectName: null })),
    ).toEqual(["created access key ci-bot", "revoked access key ci-bot", "used access key ci-bot"]);
  });

  it("names the key beside an action taken with it, once", () => {
    const landed = new AuditEvent({
      ...event("change.landed", { outcome: "pushed", remoteBranch: "mend/fix" }).event,
      accessKey: ciBot,
    });
    expect({
      landed: auditAccessKeyNote(landed),
      withoutKey: auditAccessKeyNote(event("change.landed").event),
      used: auditAccessKeyNote(onKey("access_key.used", ciBot)),
    }).toEqual({ landed: "access key ci-bot", withoutKey: null, used: null });
  });
});

describe("joinState", () => {
  const open = { state: "open" as const, organizationId: OrganizationId.make("org-acme") };

  it("tells a spent link apart by what spent it", () => {
    expect(joinState({ ...open, state: "revoked" }, null)).toEqual({
      kind: "spent",
      message: "This invitation was revoked by an owner. Ask an owner for a new link.",
    });
  });

  it("asks a visitor who is not signed in to register or sign in", () => {
    expect(joinState(open, null)).toEqual({ kind: "register" });
  });

  it("joins a signed-in account in another organization as one more", () => {
    // Another organization with the same name is still another organization.
    expect(joinState(open, [membership("org-acme-2", "Acme", "owner", true)])).toEqual({
      kind: "join",
    });
  });

  it("spends nothing for a member, saying whether this sign-in already acts there", () => {
    const acme = membership("org-acme", "Acme", "member", false);
    const beta = membership("org-beta", "Beta", "owner", true);
    expect(joinState(open, [acme, beta])).toEqual({ kind: "member", active: false });
    expect(joinState(open, [{ ...acme, active: true }])).toEqual({ kind: "member", active: true });
  });
});

const file = (path: string, size: number) => ({ path, size });

describe("planUpload", () => {
  it("packs files into requests under the cap and names what it left out", () => {
    const plan = planUpload(
      [file("a.txt", 4), file("b.txt", 4), file(".git/HEAD", 1), file("big.bin", 20), file("c", 3)],
      { file: 10, request: 8 },
    );
    expect(plan.batches.map((batch) => batch.map((staged) => staged.path))).toEqual([
      ["a.txt", "b.txt"],
      ["c"],
    ]);
    expect(plan.rejected).toEqual([
      { path: ".git/HEAD", reason: "skipped" },
      { path: "big.bin", reason: "over 1 MiB" },
    ]);
  });

  it("places a picked directory's files relative to it", () => {
    expect(stagedPath({ name: "x.md", webkitRelativePath: "" })).toBe("x.md");
    expect(stagedPath({ name: "x.md", webkitRelativePath: "docs/guides/x.md" })).toBe(
      "guides/x.md",
    );
  });

  it("encodes and sizes bytes", () => {
    expect(toBase64(new TextEncoder().encode("hello"))).toBe("aGVsbG8=");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KiB");
  });
});

describe("describeAudit for a discard (e2e run 4, 2026-09-27)", () => {
  it("says what Mend knew when the discard was asked", () => {
    expect(
      describeAudit(
        event("session.unsaved_discarded", {
          words:
            "asked at 19:57:10 UTC · last saved capture 37 at 19:54:41 UTC · unsaved since 19:55:02 UTC (snaps failing · EACCES) · no final flush completed",
        }),
      ),
    ).toBe(
      "discarded unsaved captures and stopped session carol · asked at 19:57:10 UTC · last saved capture 37 at 19:54:41 UTC · unsaved since 19:55:02 UTC (snaps failing · EACCES) · no final flush completed",
    );
    expect(describeAudit(event("session.unsaved_discarded", { pending: 0 }))).toBe(
      "discarded unsaved captures and stopped session carol",
    );
  });
});
