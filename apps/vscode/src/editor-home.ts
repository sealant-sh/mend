import * as path from "node:path";

import { isWorkspaceSshAlias } from "@mend/workspace-ssh";

export class MendWorkspace {
  readonly #authority: string;

  private constructor(
    authority: string,
    readonly user: string,
    readonly alias: string,
  ) {
    this.#authority = authority;
  }

  get authority(): string {
    return this.#authority;
  }

  static parse(authority: string | undefined): MendWorkspace | null {
    const match = /^ssh-remote\+([A-Za-z0-9._-]+)@([^@]+)$/.exec(authority ?? "");
    if (match === null) return null;
    const [, user = "", alias = ""] = match;
    return isWorkspaceSshAlias(alias) ? new MendWorkspace(authority ?? "", user, alias) : null;
  }

  static ofWindow(
    remoteName: string | undefined,
    folderAuthorities: ReadonlyArray<string>,
  ): MendWorkspace | null {
    const authorities = new Set(folderAuthorities);
    if (remoteName !== "ssh-remote" || authorities.size !== 1) return null;
    return MendWorkspace.parse([...authorities][0]);
  }
}

export interface RemoteProcess {
  readonly uids: ReadonlyArray<number>;
  readonly home: string;
  readonly agentFolder: string | undefined;
}

const environValue = (environ: string, name: string): string | undefined =>
  environ
    .split("\0")
    .find((pair) => pair.startsWith(`${name}=`))
    ?.slice(name.length + 1);

const isInside = (child: string, parent: string): boolean => {
  if (!path.posix.isAbsolute(child)) return false;
  const relative = path.posix.relative(parent, path.posix.normalize(child));
  return relative !== "" && !relative.startsWith("..") && !path.posix.isAbsolute(relative);
};

export const parseRemoteProcess = (status: string, environ: string): RemoteProcess | null => {
  const uidLine = status.split("\n").find((line) => line.startsWith("Uid:"));
  const fields = (uidLine ?? "").slice("Uid:".length).trim().split(/\s+/);
  const home = environValue(environ, "HOME");
  if (fields.length !== 4 || !fields.every((field) => /^\d+$/.test(field))) return null;
  if (home === undefined || !path.posix.isAbsolute(home)) return null;
  return {
    uids: fields.map(Number),
    home,
    agentFolder: environValue(environ, "VSCODE_AGENT_FOLDER"),
  };
};

export const PERSON_UIDS = { min: 40_001, max: 49_999 } as const;

const PERSON_HOME = /^\/home\/m[a-z0-9]+$/;

export class PersonHome {
  readonly kind = "person";
  readonly #agentFolder: string;

  private constructor(
    readonly workspace: MendWorkspace,
    readonly uid: number,
    agentFolder: string,
  ) {
    this.#agentFolder = agentFolder;
  }

  get extensionsJson(): string {
    return `${this.#agentFolder}/extensions/extensions.json`;
  }

  static of(workspace: MendWorkspace, process: RemoteProcess): PersonHome | null {
    const [uid, ...rest] = process.uids;
    if (uid === undefined || rest.length !== 3 || rest.some((other) => other !== uid)) return null;
    if (uid < PERSON_UIDS.min || uid > PERSON_UIDS.max) return null;
    if (!PERSON_HOME.test(process.home)) return null;
    const { agentFolder = `${process.home}/.vscode-server` } = process;
    if (!isInside(agentFolder, process.home)) return null;
    return new PersonHome(workspace, uid, path.posix.normalize(agentFolder));
  }
}

export type EditorHome = PersonHome | { readonly kind: "shared" };

export const editorHomeOf = (workspace: MendWorkspace, process: RemoteProcess): EditorHome =>
  PersonHome.of(workspace, process) ?? { kind: "shared" };
