import { describe, expect, it } from "vitest";

import {
  mayStop,
  pickDescription,
  rowCapability,
  rowContextValue,
  rowOffer,
  stopRefusal,
} from "./session-capability.js";
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
    expect(rowContextValue(anas, capability, false)).toBe("mend.session.live.review");
    expect(rowContextValue({ status: "stopped" }, capability, false)).toBe(
      "mend.session.settled.review",
    );
  });

  it("offers Watch terminal while Ana has shared control on", () => {
    const shared = { ...anas, sharedControlEnabledAt: "2026-10-19T09:00:00.000Z" };
    const capability = rowCapability({ session: shared, viewer: "dana", members });
    expect(capability).toMatchObject({ kind: "notYours", watch: true });
    expect(rowContextValue(shared, capability, true)).toBe("mend.session.live.watch.steer");
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
    const line = "running · reading src/auth";
    expect(pickDescription(line, rowCapability({ session: shared, viewer: "dana", members }))).toBe(
      "running · reading src/auth · Watch terminal",
    );
    expect(pickDescription(line, rowCapability({ session: anas, viewer: "dana", members }))).toBe(
      "running · reading src/auth · Review",
    );
  });

  it("lists Dana's own session by how its row reads: picking it opens", () => {
    const danas = { ...anas, ownerUserId: "dana", workspaceLauncherUserId: "dana" };
    const capability = rowCapability({ session: danas, viewer: "dana", members });
    expect(rowOffer(capability)).toBe("Open");
    expect(pickDescription("waiting · claude needs your permission to use Bash", capability)).toBe(
      "waiting · claude needs your permission to use Bash",
    );
  });
});

describe("Open", () => {
  it("is offered on Dana's own workspace", () => {
    const danas = { ...anas, ownerUserId: "dana", workspaceLauncherUserId: "dana" };
    const capability = rowCapability({ session: danas, viewer: "dana", members });
    expect(capability).toEqual({ kind: "open" });
    expect(rowContextValue(danas, capability, true)).toBe("mend.session.live.open.steer");
  });

  it("is offered when no one launched the workspace yet: the opener becomes its launcher", () => {
    expect(
      rowCapability({
        session: { ...anas, workspaceLauncherUserId: null },
        viewer: "dana",
        members,
      }),
    ).toEqual({ kind: "open" });
    expect(rowContextValue({ status: "completed" }, { kind: "open" }, true)).toBe(
      "mend.session.settled.open.steer",
    );
  });

  it("is not offered when Mend could not read who the viewer is: the row offers Review", () => {
    const capability = rowCapability({ session: anas, viewer: null, members });
    expect(capability).toEqual({
      kind: "unknown",
      why: "Mend could not read who you are on this server",
    });
    expect(rowOffer(capability)).toBe("Review");
    expect(rowContextValue(anas, capability, mayStop(anas, null))).toBe("mend.session.live.review");
    expect(pickDescription("running", capability)).toBe("running · Review");
  });

  it("is not offered when no one launched the workspace and Mend could not read who the viewer is", () => {
    const unlaunched = { ...anas, workspaceLauncherUserId: null };
    const capability = rowCapability({ session: unlaunched, viewer: null, members });
    expect(capability).toEqual({
      kind: "unknown",
      why: "Mend could not read who you are on this server",
    });
    expect(rowOffer(capability)).toBe("Review");
  });
});

const ownerName = async () => "Ana";

describe("Stop", () => {
  it("is the viewer's to use only on a session she may steer", () => {
    expect(mayStop(anas, "ana")).toBe(true);
    expect(mayStop(anas, "dana")).toBe(false);
    expect(mayStop({ ...anas, sharedControlEnabledAt: "2026-10-19T09:00:00.000Z" }, "dana")).toBe(
      true,
    );
    expect(mayStop(anas, null)).toBe(false);
  });

  const named = { ...anas, id: "session-1", label: "add-rate-limit", harness: "claude" };

  it("refuses at the command when Mend could not read who the viewer is", async () => {
    expect(await stopRefusal(named, null, ownerName)).toBe(
      "Mend could not read who you are on this server, so it did not stop add-rate-limit.",
    );
  });

  it("refuses at the command on someone else's session, and lets its owner stop it", async () => {
    expect(await stopRefusal(named, "dana", ownerName)).toBe(
      "add-rate-limit is Ana's session. Only its owner stops it while shared control is off.",
    );
    expect(await stopRefusal(named, "ana", ownerName)).toBeNull();
  });
});
