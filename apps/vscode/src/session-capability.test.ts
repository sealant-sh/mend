import { describe, expect, it } from "vitest";

import { pickDescription, rowCapability, rowContextValue, rowOffer } from "./session-capability.js";
import type { Session } from "./types.js";

type Facts = Pick<
  Session,
  "ownerUserId" | "sharedControlEnabledAt" | "workspaceLauncherUserId" | "livePeople" | "status"
>;

const anas: Facts = {
  ownerUserId: "ana",
  sharedControlEnabledAt: null,
  workspaceLauncherUserId: "ana",
  livePeople: [],
  status: "running",
};
const members = [
  { userId: "ana", name: "Ana" },
  { userId: "dana", name: "Dana" },
];

describe("a session Ana launched, as Dana sees it", () => {
  it("offers Review only, and says why", () => {
    const capability = rowCapability({ session: anas, viewer: "dana", members });
    expect(capability).toEqual({
      kind: "notYours",
      watch: false,
      why: "Ana launched this workspace · Remote-SSH opens it only for them",
    });
    expect(rowContextValue(anas, capability)).toBe("mend.session.live.review");
    expect(rowContextValue({ status: "stopped" }, capability)).toBe("mend.session.settled.review");
  });

  it("offers Watch terminal while Ana has shared control on", () => {
    const shared = { ...anas, sharedControlEnabledAt: "2026-10-19T09:00:00.000Z" };
    const capability = rowCapability({ session: shared, viewer: "dana", members });
    expect(capability).toMatchObject({ kind: "notYours", watch: true });
    expect(rowContextValue(shared, capability)).toBe("mend.session.live.watch");
  });

  it("names Ana from the people live in the workspace when the roster is not read", () => {
    const live = { ...anas, livePeople: [{ accountId: "ana", name: "Ana K." }] };
    expect(rowCapability({ session: live, viewer: "dana", members: [] })).toMatchObject({
      why: "Ana K. launched this workspace · Remote-SSH opens it only for them",
    });
    expect(rowCapability({ session: anas, viewer: "dana", members: [] })).toMatchObject({
      why: "another person launched this workspace · Remote-SSH opens it only for them",
    });
  });
});

describe("a session picker", () => {
  it("lists Ana's session with what helps instead of Open", () => {
    const shared = { ...anas, sharedControlEnabledAt: "2026-10-19T09:00:00.000Z" };
    expect(
      pickDescription(shared, rowCapability({ session: shared, viewer: "dana", members })),
    ).toBe("running · Watch terminal");
    expect(pickDescription(anas, rowCapability({ session: anas, viewer: "dana", members }))).toBe(
      "running · Review",
    );
  });

  it("lists Dana's own session by its status: picking it opens", () => {
    const danas = { ...anas, ownerUserId: "dana", workspaceLauncherUserId: "dana" };
    const capability = rowCapability({ session: danas, viewer: "dana", members });
    expect(rowOffer(capability)).toBe("Open");
    expect(pickDescription(danas, capability)).toBe("running");
  });
});

describe("Open", () => {
  it("is offered on Dana's own workspace", () => {
    const danas = { ...anas, ownerUserId: "dana", workspaceLauncherUserId: "dana" };
    const capability = rowCapability({ session: danas, viewer: "dana", members });
    expect(capability).toEqual({ kind: "open" });
    expect(rowContextValue(danas, capability)).toBe("mend.session.live.open");
  });

  it("is offered when the viewer or the launcher is unknown", () => {
    expect(rowCapability({ session: anas, viewer: null, members })).toEqual({ kind: "open" });
    expect(
      rowCapability({
        session: { ...anas, workspaceLauncherUserId: null },
        viewer: "dana",
        members,
      }),
    ).toEqual({ kind: "open" });
    expect(rowContextValue({ status: "completed" }, { kind: "open" })).toBe(
      "mend.session.settled.open",
    );
  });
});
