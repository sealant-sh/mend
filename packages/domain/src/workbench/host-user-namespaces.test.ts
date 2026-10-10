import { describe, expect, it } from "vitest";

import {
  HOST_USER_NAMESPACE_FIXES,
  hostUserNamespacesFix,
  hostUserNamespacesOf,
  hostUserNamespacesRefusal,
  hostUserNamespacesRefusalParts,
  hostUserNamespacesSysctlLines,
} from "./host-user-namespaces.ts";

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

describe("HOST_USER_NAMESPACE_FIXES", () => {
  it("is the command for each setting hostUserNamespacesOf can ask for, and nothing else", () => {
    const settings = [
      { ...none, apparmorRestrictUnprivilegedUserns: "1" },
      { ...none, unprivilegedUsernsClone: "0" },
    ].flatMap((readings) => {
      const verdict = hostUserNamespacesOf(readings);
      return verdict.allowed ? [] : [verdict.setting];
    });
    expect(HOST_USER_NAMESPACE_FIXES).toEqual(settings.map(hostUserNamespacesFix));
  });
});

describe("hostUserNamespacesRefusal", () => {
  const setting = "kernel.apparmor_restrict_unprivileged_userns = 0";

  it("says what is refused, then where and how to allow it", () => {
    expect(hostUserNamespacesRefusal(setting)).toBe(
      "the server's host refuses user namespaces · no workspace can start · on the server's host: echo 'kernel.apparmor_restrict_unprivileged_userns = 0' | sudo tee /etc/sysctl.d/60-mend-rootless-docker.conf && sudo sysctl --system",
    );
  });

  it("splits a line that carries it around the command", () => {
    const line = `launch failed: ${hostUserNamespacesRefusal(setting)} · saved at 07:34:21 UTC`;
    expect(hostUserNamespacesRefusalParts(line)).toEqual({
      lead: "launch failed: the server's host refuses user namespaces · no workspace can start · on the server's host: ",
      command: hostUserNamespacesFix(setting),
      rest: " · saved at 07:34:21 UTC",
    });
    expect(
      hostUserNamespacesRefusalParts(`launch failed: ${hostUserNamespacesRefusal(setting)}`),
    ).toMatchObject({ command: hostUserNamespacesFix(setting), rest: "" });
    expect(hostUserNamespacesRefusalParts("launch failed: setup command failed")).toBeNull();
  });
});

describe("hostUserNamespacesSysctlLines", () => {
  it("marks the file as setup's and keeps the setting it replaced", () => {
    expect(
      hostUserNamespacesSysctlLines("kernel.apparmor_restrict_unprivileged_userns = 0"),
    ).toEqual([
      "# written by mend server setup; mend uninstall removes it",
      "# previous: kernel.apparmor_restrict_unprivileged_userns = 1",
      "kernel.apparmor_restrict_unprivileged_userns = 0",
    ]);
    expect(hostUserNamespacesSysctlLines("kernel.unprivileged_userns_clone = 1")).toEqual([
      "# written by mend server setup; mend uninstall removes it",
      "# previous: kernel.unprivileged_userns_clone = 0",
      "kernel.unprivileged_userns_clone = 1",
    ]);
  });
});
