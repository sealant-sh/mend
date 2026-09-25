import { AuditEventId, OrganizationId } from "@mend/domain";
import { AuditEvent } from "@mend/domain/workbench";
import { describe, expect, it } from "vitest";

import {
  describeAudit,
  formatBytes,
  joinState,
  planUpload,
  stagedPath,
  toBase64,
} from "./organization.ts";

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
  }),
});

describe("describeAudit", () => {
  it("says what happened in plain words", () => {
    expect(describeAudit(event("member.role_changed", { role: "owner" }))).toBe(
      "made carol an owner",
    );
    expect(describeAudit(event("member.removed", {}, "Carol Chen"))).toBe("removed Carol Chen");
    expect(describeAudit(event("folder.created", { name: "fixtures" }))).toBe(
      "created folder fixtures",
    );
    expect(describeAudit(event("invitation.accepted", { role: "member" }))).toBe(
      "joined as member",
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
});

describe("joinState", () => {
  const open = { state: "open" as const, organizationId: OrganizationId.make("org-acme") };

  it("tells a spent link apart by what spent it", () => {
    expect(joinState({ ...open, state: "revoked" }, false, null)).toEqual({
      kind: "spent",
      message: "This invitation was revoked by an owner. Ask an owner for a new link.",
    });
  });

  it("registers a visitor, and never moves a signed-in account between organizations", () => {
    expect(joinState(open, false, null)).toEqual({ kind: "register" });
    expect(joinState(open, true, { id: "org-acme", name: "Acme" })).toEqual({
      kind: "already-member",
    });
    // Another organization with the same name is still another organization.
    expect(joinState(open, true, { id: "org-acme-2", name: "Acme" })).toEqual({
      kind: "other-organization",
      current: "Acme",
    });
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
