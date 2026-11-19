import { describe, expect, it } from "vitest";

import {
  accessKeyNote,
  AUDIT_PAGE_SIZE,
  type AuditEntryView,
  type AuditNames,
  describeAudit,
  nextAuditPage,
  projectOf,
  whenLine,
} from "./audit-log.ts";

const NOW = new Date("2026-11-19T11:00:00");
const names: AuditNames = {
  organization: "Northwind",
  people: new Map([
    ["ada", "Ada Lovelace"],
    ["grace", "Grace Hopper"],
  ]),
  projects: new Map([["p-web", "web"]]),
};

const entry = (
  action: string,
  data: AuditEntryView["event"]["data"] = {},
  over: Partial<AuditEntryView["event"]> = {},
  subjectName: string | null = null,
): AuditEntryView => ({
  event: {
    id: "ev-1",
    actorUserId: "ada",
    action,
    subjectType: "member",
    subjectId: "grace",
    data,
    createdAt: NOW,
    accessKey: null,
    ...over,
  },
  actorName: "Ada Lovelace",
  subjectName,
});

describe("when each event happened", () => {
  it("says today and yesterday by name, then the day", () => {
    expect(whenLine(new Date("2026-11-19T10:58:00"), NOW)).toBe("Today, 10:58");
    expect(whenLine(new Date("2026-11-18T18:04:00"), NOW)).toBe("Yesterday, 18:04");
    expect(whenLine(new Date("2026-11-12T17:30:00"), NOW)).toBe("12 Nov, 17:30");
    expect(whenLine(new Date("2025-12-24T09:00:00"), NOW)).toBe("24 Dec 2025, 09:00");
  });
});

describe("paging", () => {
  it("asks for the next page before the last event of a full page, and stops after a short one", () => {
    const full = Array.from({ length: AUDIT_PAGE_SIZE }, (_, index) =>
      entry("member.left", {}, { id: `ev-${index}` }),
    );
    expect(nextAuditPage(full)).toBe(`ev-${AUDIT_PAGE_SIZE - 1}`);
    expect(nextAuditPage(full.slice(0, 3))).toBeUndefined();
    expect(nextAuditPage([])).toBeUndefined();
  });
});

describe("what each event says", () => {
  it("names members, removed ones included, as the server resolved them", () => {
    expect(
      describeAudit(entry("member.role_changed", { role: "owner" }, {}, "Grace Hopper"), names),
    ).toBe("Made Grace Hopper an owner");
    expect(describeAudit(entry("member.removed", {}, {}, "Dorothy Vaughan"), names)).toBe(
      "Removed Dorothy Vaughan from Northwind",
    );
    expect(
      describeAudit(entry("member.password_reset_issued", {}, {}, "Grace Hopper"), names),
    ).toBe("Created a password reset link for Grace Hopper");
    expect(describeAudit(entry("invitation.accepted", { role: "member" }), names)).toBe(
      "Joined Northwind as a member",
    );
    expect(
      describeAudit(entry("invitation.created", { role: "member", emailBound: true }), names),
    ).toBe("Created an invitation link to join as a member, for one email address");
  });

  it("names the person given shared control from the roster (shared-control.md audit)", () => {
    const session = { subjectType: "session", subjectId: "1a2b3c4d-5e6f-7a8b" };
    expect(describeAudit(entry("session.shared_control_on", {}, session), names)).toBe(
      "Shared control of session 1a2b3c4d with everyone who can see it",
    );
    expect(describeAudit(entry("session.shared_control_off", {}, session), names)).toBe(
      "Turned off shared control of session 1a2b3c4d",
    );
    expect(
      describeAudit(entry("session.shared_control_granted", { userId: "grace" }, session), names),
    ).toBe("Shared control of session 1a2b3c4d with Grace Hopper");
    expect(
      describeAudit(entry("session.shared_control_taken_back", { userId: "bob" }, session), names),
    ).toBe("Took back shared control of session 1a2b3c4d from someone no longer here");
  });

  it("says what the operator did, as the operator (operator.md operator-audit)", () => {
    expect(describeAudit(entry("recovery.owner_granted", {}, {}, "Grace Hopper"), names)).toBe(
      "Made Grace Hopper an owner, as this server's operator",
    );
    expect(
      describeAudit(
        entry("organization.renamed", { name: "Northwind Labs" }, { subjectType: "organization" }),
        names,
      ),
    ).toBe("Renamed the organization to Northwind Labs");
  });

  it("names a project and puts it in the Project column", () => {
    const shared = entry(
      "project.visibility_changed",
      { visibility: "shared" },
      { subjectType: "project", subjectId: "p-web" },
    );
    expect(describeAudit(shared, names)).toBe("Shared web with everyone in Northwind");
    expect(projectOf(shared, names)).toBe("web");
    const unseen = entry(
      "project.removed",
      { name: "secret-api" },
      { subjectType: "project", subjectId: "p-x" },
    );
    expect(describeAudit(unseen, names)).toBe("Removed secret-api");
    expect(projectOf(entry("slack.session_started", { projectName: "web" }), names)).toBe("web");
    expect(projectOf(entry("member.left"), names)).toBeNull();
  });

  it("says what the Slack app, Boat key and landing did", () => {
    expect(describeAudit(entry("slack.replaced", { teamName: "Northwind" }), names)).toBe(
      "Replaced the Slack app's tokens",
    );
    expect(describeAudit(entry("slack.settings_changed", { showDiffs: true }), names)).toBe(
      "Turned on Diffs for the Slack app",
    );
    expect(describeAudit(entry("boat_key.replaced"), names)).toBe("Replaced Northwind's Boat key");
    expect(describeAudit(entry("boat_key.connected", { key: "own" }), names)).toBe(
      "Connected their own Boat key",
    );
    expect(
      describeAudit(
        entry("change.landed", { outcome: "pull-request", pullRequest: 412, remoteBranch: "fix" }),
        names,
      ),
    ).toBe("Opened pull request #412 from fix");
    expect(
      describeAudit(entry("organization.settings_changed", { sessionRuntime: "boat" }), names),
    ).toBe("Set where new sessions run to Boat");
  });

  it("says what happened to a folder", () => {
    expect(
      describeAudit(
        entry("folder.renamed", { name: "runbooks", from: "notes" }, { subjectType: "folder" }),
        names,
      ),
    ).toBe("Renamed the folder notes to runbooks");
  });

  it("still says something for an action a newer server added", () => {
    expect(
      describeAudit(
        entry("widget.polished", {}, { subjectType: "widget", subjectId: "w1" }),
        names,
      ),
    ).toBe("widget polished (widget w1)");
  });

  it("notes the access key an action was taken with, but not on the key's own events", () => {
    const key = { id: "k1", name: "ci" };
    expect(accessKeyNote(entry("member.removed", {}, { accessKey: key }).event)).toBe(
      "with the access key ci",
    );
    expect(
      accessKeyNote(
        entry("access_key.used", {}, { accessKey: key, subjectType: "access_key", subjectId: "k1" })
          .event,
      ),
    ).toBeNull();
    expect(accessKeyNote(entry("member.removed").event)).toBeNull();
  });
});
