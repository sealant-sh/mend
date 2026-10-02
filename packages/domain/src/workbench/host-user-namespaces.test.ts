import { describe, expect, it } from "vitest";

import { hostUserNamespacesOf } from "./host-user-namespaces.ts";

const none = {
  apparmorRestrictUnprivilegedUserns: null,
  apparmorEnabled: null,
  unprivilegedUsernsClone: null,
};

describe("hostUserNamespacesOf", () => {
  it("allows them on a kernel with neither switch (Fedora, Docker Desktop, older Ubuntu)", () => {
    expect(hostUserNamespacesOf(none)).toEqual({ allowed: true });
  });

  it("refuses them on Ubuntu 24.04's default, and names the setting that allows them", () => {
    expect(
      hostUserNamespacesOf({
        ...none,
        apparmorRestrictUnprivilegedUserns: "1\n",
        apparmorEnabled: "Y\n",
      }),
    ).toEqual({ allowed: false, setting: "kernel.apparmor_restrict_unprivileged_userns = 0" });
    // AppArmor's state unreadable: the switch is taken as applying.
    expect(hostUserNamespacesOf({ ...none, apparmorRestrictUnprivilegedUserns: "1" }).allowed).toBe(
      false,
    );
  });

  it("allows them once the switch is off, or while AppArmor itself is", () => {
    expect(
      hostUserNamespacesOf({
        ...none,
        apparmorRestrictUnprivilegedUserns: "0",
        apparmorEnabled: "Y",
      }),
    ).toEqual({ allowed: true });
    expect(
      hostUserNamespacesOf({
        ...none,
        apparmorRestrictUnprivilegedUserns: "1",
        apparmorEnabled: "N",
      }),
    ).toEqual({ allowed: true });
  });

  it("refuses them where Debian's switch is off", () => {
    expect(hostUserNamespacesOf({ ...none, unprivilegedUsernsClone: "0\n" })).toEqual({
      allowed: false,
      setting: "kernel.unprivileged_userns_clone = 1",
    });
    expect(hostUserNamespacesOf({ ...none, unprivilegedUsernsClone: "1" })).toEqual({
      allowed: true,
    });
  });
});
