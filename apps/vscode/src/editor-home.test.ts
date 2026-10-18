import { describe, expect, it } from "vitest";

import { MendWorkspace, PersonHome, editorHomeOf, parseRemoteProcess } from "./editor-home.js";

const ALIAS = "mend-ws-172-17-0-3-de2f165a9e5801413f7fb934";
const AUTHORITY = `ssh-remote+ws-61aaf28f-f715-4ce1-89be-8626d33acbb6@${ALIAS}`;

const status = (uids: string) =>
  `Name:\tMainThread\nPid:\t1440\nPPid:\t1436\nUid:\t${uids}\nGid:\t40000\t40000\t40000\t40000\nGroups:\t40000 \n`;
const environ = (vars: Record<string, string>) =>
  Object.entries(vars)
    .map(([name, value]) => `${name}=${value}`)
    .join("\0");

const PERSON = {
  status: status("40001\t40001\t40001\t40001"),
  environ: environ({
    USER: "mm7l6bfej",
    HOME: "/home/mm7l6bfej",
    VSCODE_AGENT_FOLDER: "/home/mm7l6bfej/.vscode-server",
    SHELL: "/bin/bash",
    GITHUB_TOKEN: "ghp_never_kept",
  }),
};
const SHARED = {
  status: status("0\t0\t0\t0"),
  environ: environ({ HOME: "/root", VSCODE_AGENT_FOLDER: "/root/.vscode-server" }),
};

const workspace = (): MendWorkspace => {
  const parsed = MendWorkspace.parse(AUTHORITY);
  if (parsed === null) throw new Error("the fixture authority is not a Mend workspace");
  return parsed;
};

describe("MendWorkspace.parse", () => {
  it("reads the gateway user and the managed alias", () => {
    expect(MendWorkspace.parse(AUTHORITY)).toMatchObject({
      authority: AUTHORITY,
      user: "ws-61aaf28f-f715-4ce1-89be-8626d33acbb6",
      alias: ALIAS,
    });
  });

  it.each([
    ["a local window", undefined],
    ["a foreign host", "ssh-remote+me@build.example.com"],
    ["a WSL window", `wsl+Ubuntu`],
    ["the legacy alias", "ssh-remote+ws-1@mend-ws"],
    ["a mend-ws host without the server hash", "ssh-remote+ws-1@mend-ws-evil"],
    ["a suffix after the alias", `ssh-remote+ws-1@${ALIAS}.example.com`],
    ["a port after the alias", `ssh-remote+ws-1@${ALIAS}:22`],
    ["no user", `ssh-remote+${ALIAS}`],
    ["a dev container", `dev-container+${ALIAS}`],
  ])("refuses %s", (_name, authority) => {
    expect(MendWorkspace.parse(authority)).toBeNull();
  });
});

describe("MendWorkspace.ofWindow", () => {
  it("takes the one authority of a Remote-SSH window", () => {
    expect(MendWorkspace.ofWindow("ssh-remote", [AUTHORITY, AUTHORITY])?.authority).toBe(AUTHORITY);
  });

  it.each([
    ["a non-SSH remote name", "dev-container", [AUTHORITY]],
    ["a local window", undefined, [AUTHORITY]],
    ["no remote folder", "ssh-remote", []],
    ["folders on two hosts", "ssh-remote", [AUTHORITY, "ssh-remote+me@build.example.com"]],
    ["folders on two Mend workspaces", "ssh-remote", [AUTHORITY, `ssh-remote+ws-2@${ALIAS}`]],
  ])("refuses %s", (_name, remoteName, authorities) => {
    expect(MendWorkspace.ofWindow(remoteName, authorities)).toBeNull();
  });
});

describe("nominal types", () => {
  it("no object literal passes for a parsed workspace or a person home", () => {
    // @ts-expect-error MendWorkspace is built only by MendWorkspace.parse.
    const workspaceLike: MendWorkspace = { authority: AUTHORITY, user: "ws-1", alias: ALIAS };
    // @ts-expect-error PersonHome is built only by PersonHome.of.
    const homeLike: PersonHome = { kind: "person", workspace: workspaceLike, uid: 40001 };
    expect(workspaceLike).not.toBeInstanceOf(MendWorkspace);
    expect(homeLike).not.toBeInstanceOf(PersonHome);
  });

  it("an object made from the prototype has no paths", () => {
    const forged: PersonHome = Object.create(PersonHome.prototype);
    expect(() => forged.extensionsJson).toThrow(TypeError);
    const forgedWorkspace: MendWorkspace = Object.create(MendWorkspace.prototype);
    expect(() => forgedWorkspace.authority).toThrow(TypeError);
  });
});

describe("parseRemoteProcess", () => {
  it("keeps uid, HOME and the declared server folder, and nothing else", () => {
    const parsed = parseRemoteProcess(PERSON.status, PERSON.environ);
    expect(parsed).toEqual({
      uids: [40001, 40001, 40001, 40001],
      home: "/home/mm7l6bfej",
      agentFolder: "/home/mm7l6bfej/.vscode-server",
    });
    expect(JSON.stringify(parsed)).not.toContain("ghp_");
  });

  it("is null when the files do not say who the server runs as", () => {
    expect(parseRemoteProcess("Name:\tx\n", PERSON.environ)).toBeNull();
    expect(parseRemoteProcess(PERSON.status, environ({ USER: "mm7l6bfej" }))).toBeNull();
    expect(parseRemoteProcess(PERSON.status, environ({ HOME: "relative" }))).toBeNull();
  });

  it.each([
    ["a non-numeric field", "40001\t40001\tx\t40001"],
    ["a signed field", "40001\t-1\t40001\t40001"],
    ["five fields", "40001\t40001\t40001\t40001\t40001"],
    ["four numeric fields and a fifth", "40001\t40001\t40001\t40001\tx"],
  ])("is null for a Uid line with %s", (_name, uids) => {
    expect(parseRemoteProcess(status(uids), PERSON.environ)).toBeNull();
  });
});

describe("editorHomeOf (D5)", () => {
  it("the spike's person window is a person home with its paths", () => {
    const process = parseRemoteProcess(PERSON.status, PERSON.environ);
    if (process === null) throw new Error("fixture did not parse");
    const home = editorHomeOf(workspace(), process);
    expect(home).toBeInstanceOf(PersonHome);
    if (home.kind !== "person") throw new Error("not a person home");
    expect(home.uid).toBe(40001);
    expect(home.extensionsJson).toBe("/home/mm7l6bfej/.vscode-server/extensions/extensions.json");
  });

  it("uses ~/.vscode-server without VSCODE_AGENT_FOLDER", () => {
    const process = parseRemoteProcess(PERSON.status, environ({ HOME: "/home/mm7l6bfej" }));
    if (process === null) throw new Error("fixture did not parse");
    const home = editorHomeOf(workspace(), process);
    if (home.kind !== "person") throw new Error("not a person home");
    expect(home.extensionsJson).toBe("/home/mm7l6bfej/.vscode-server/extensions/extensions.json");
  });

  it.each([
    ["outside HOME", "/root/.vscode-server"],
    ["escaping HOME", "/home/mm7l6bfej/../mother/.vscode-server"],
    ["HOME itself", "/home/mm7l6bfej"],
    ["relative", ".vscode-server"],
  ])("an agent folder %s is not a person home", (_name, folder) => {
    const process = parseRemoteProcess(
      PERSON.status,
      environ({ HOME: "/home/mm7l6bfej", VSCODE_AGENT_FOLDER: folder }),
    );
    if (process === null) throw new Error("fixture did not parse");
    expect(editorHomeOf(workspace(), process)).toEqual({ kind: "shared" });
  });

  it("the spike's root window is shared", () => {
    const process = parseRemoteProcess(SHARED.status, SHARED.environ);
    if (process === null) throw new Error("fixture did not parse");
    expect(editorHomeOf(workspace(), process)).toEqual({ kind: "shared" });
  });

  it.each([
    ["40000", "40000\t40000\t40000\t40000", "/home/mabc", "shared"],
    ["40001", "40001\t40001\t40001\t40001", "/home/mabc", "person"],
    ["49999", "49999\t49999\t49999\t49999", "/home/mabc", "person"],
    ["50000", "50000\t50000\t50000\t50000", "/home/mabc", "shared"],
    ["unequal uid fields", "40001\t0\t40001\t40001", "/home/mabc", "shared"],
    ["three uid fields", "40001\t40001\t40001", "/home/mabc", "shared"],
    ["HOME /home/other", "40001\t40001\t40001\t40001", "/home/other", "shared"],
    ["HOME with a trailing slash", "40001\t40001\t40001\t40001", "/home/mabc/", "shared"],
    ["HOME below a person home", "40001\t40001\t40001\t40001", "/home/mabc/sub", "shared"],
    ["HOME /root", "40001\t40001\t40001\t40001", "/root", "shared"],
  ])("%s → %s", (_name, uids, home, kind) => {
    const process = parseRemoteProcess(status(uids), environ({ HOME: home }));
    expect(process === null ? "shared" : editorHomeOf(workspace(), process).kind).toBe(kind);
  });
});
