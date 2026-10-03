import { describe, expect, it } from "vitest";

import { secretFileLines, secretFilePathOf, secretFileUploadOf } from "./secret-files.ts";

describe("secretFilePathOf", () => {
  const home = "/home/anna";

  it("takes a home-relative path, a ~ path and an absolute path under this machine's home alike", () => {
    expect(secretFilePathOf(".aws/credentials", home)).toEqual({
      path: ".aws/credentials",
      issue: null,
    });
    expect(secretFilePathOf("~/.aws/credentials", home)).toEqual({
      path: ".aws/credentials",
      issue: null,
    });
    expect(secretFilePathOf("/home/anna/.kube/config", home)).toEqual({
      path: ".kube/config",
      issue: null,
    });
    expect(secretFilePathOf("./.npmrc", home)).toEqual({ path: ".npmrc", issue: null });
  });

  it("refuses a path outside the home, one that escapes it, and one a session captures", () => {
    expect(secretFilePathOf("/etc/passwd", home).issue).toContain("outside your home directory");
    expect(secretFilePathOf("/home/annabel/.npmrc", home).issue).toContain(
      "outside your home directory",
    );
    expect(secretFilePathOf("../other/.npmrc", home).issue).not.toBeNull();
    expect(secretFilePathOf("~", home).issue).toContain("required");
    expect(secretFilePathOf(".claude/.credentials.json", home).issue).toBe(
      ".claude/.credentials.json is under .claude, which sessions capture",
    );
  });
});

describe("secretFileUploadOf", () => {
  it("sends text as utf8 and anything else as base64", () => {
    expect(secretFileUploadOf(".npmrc", Buffer.from("token=x\n"))).toEqual({
      path: ".npmrc",
      encoding: "utf8",
      contents: "token=x\n",
    });
    const binary = Buffer.from([0x30, 0x82, 0x00, 0xff]);
    expect(secretFileUploadOf(".keytab", binary)).toEqual({
      path: ".keytab",
      encoding: "base64",
      contents: binary.toString("base64"),
    });
  });
});

describe("secretFileLines", () => {
  it("shows the path as the workspace sees it, the size and when it changed, never content", () => {
    const lines = secretFileLines([
      {
        id: "a",
        path: ".aws/credentials",
        name: "credentials",
        bytes: 116,
        revision: 3,
        createdAt: "2026-10-01T09:00:00.000Z",
        updatedAt: "2026-10-03T12:30:00.000Z",
      },
      {
        id: "b",
        path: ".npmrc",
        name: ".npmrc",
        bytes: 2048,
        revision: 1,
        createdAt: "2026-10-01T09:00:00.000Z",
        updatedAt: "2026-10-01T09:00:00.000Z",
      },
    ]);
    expect(lines).toEqual([
      "~/.aws/credentials     116 B  2026-10-03 12:30 · replaced 2 times",
      "~/.npmrc              2.0 KB  2026-10-01 09:00",
    ]);
  });
});
