import { describe, expect, it } from "vitest";

import { ACCESS_GRACE_MS, makeLoginWalk } from "#/lib/login-walk";

const world = (pathname = "/") => {
  const assigned: Array<string> = [];
  const timers: Array<{ readonly run: () => void; readonly ms: number }> = [];
  const walk = makeLoginWalk({
    pathname: () => pathname,
    loginUrl: () => (pathname === "/" ? "/login" : `/login?next=${encodeURIComponent(pathname)}`),
    assign: (url) => void assigned.push(url),
    later: (run, ms) => void timers.push({ run, ms }),
  });
  const elapse = () => {
    for (const timer of timers.splice(0)) timer.run();
  };
  return { walk, assigned, timers, elapse };
};

describe("the walk to sign-in", () => {
  it("says why when the access event follows a refused request within the grace", () => {
    const { walk, assigned, timers, elapse } = world();
    walk.refused();
    expect(timers.map((timer) => timer.ms)).toEqual([ACCESS_GRACE_MS]);
    walk.accessRemoved();
    elapse();
    expect(assigned).toEqual(["/login?reason=access"]);
  });

  it("walks to a plain sign-in, keeping where the page was, when no access event comes", () => {
    const { walk, assigned, elapse } = world("/settings");
    walk.refused();
    walk.refused();
    elapse();
    expect(assigned).toEqual(["/login?next=%2Fsettings"]);
  });

  it("goes at once on the access event", () => {
    const { walk, assigned, timers } = world();
    walk.accessRemoved();
    walk.refused();
    expect(assigned).toEqual(["/login?reason=access"]);
    expect(timers).toEqual([]);
  });

  it("starts over at Now when the sign-in moved organization, once, even over a pending refusal", () => {
    const { walk, assigned, elapse } = world("/projects/p1");
    walk.refused();
    walk.organizationChanged();
    walk.organizationChanged();
    elapse();
    expect(assigned).toEqual(["/"]);
  });

  it("lets a removal from the last organization overrule starting over", () => {
    const { walk, assigned } = world();
    walk.accessRemoved();
    walk.organizationChanged();
    expect(assigned).toEqual(["/login?reason=access"]);
  });

  it("does nothing on a refusal at sign-in itself", () => {
    const { walk, assigned, timers } = world("/login");
    walk.refused();
    expect(assigned).toEqual([]);
    expect(timers).toEqual([]);
  });
});
