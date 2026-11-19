/**
 * Settings → a project → Folders and references (Doop "Settings · Project · checkout-api · Folders
 * and references"; references-folders.md `folder-select`, `ref-select`, `host-mounts`) and the
 * Linked projects section of its General page (`link-project`). The organization keeps the folders
 * and references (docs/adr/0025); a project picks which its sessions get. What each row says, and
 * the selection each change sends, built from what the server last confirmed. Pure, so each rule is
 * tested without a server.
 */

import { sizeWords } from "./byte-size.ts";

/** How a project's sessions get one of the organization's folders. */
export type FolderAccess = "off" | "read" | "write";

/** One folder as the project has picked it: where it mounts and whether sessions may write. */
export interface FolderPick {
  readonly folder: { readonly id: string };
  readonly name: string;
  readonly readOnly: boolean;
}

/** One folder's access changed on the page. */
export interface FolderChange {
  readonly projectId: string;
  readonly folderId: string;
  readonly name: string;
  readonly access: FolderAccess;
}

/** What `projects.setFolders` takes: the project's whole selection. */
export interface FolderSelection {
  readonly folderId: string;
  readonly name: string;
  readonly readOnly: boolean;
}

/**
 * The selection to send for one folder's change: every other folder as the server last confirmed
 * it, and this one at its new access (left out when off). A folder already picked keeps the
 * directory name it mounts at.
 */
export const nextFolderSelection = (
  confirmed: ReadonlyArray<FolderPick>,
  change: Omit<FolderChange, "projectId">,
): ReadonlyArray<FolderSelection> => {
  const kept = confirmed.find((pick) => pick.folder.id === change.folderId);
  return [
    ...confirmed
      .filter((pick) => pick.folder.id !== change.folderId)
      .map((pick) => ({ folderId: pick.folder.id, name: pick.name, readOnly: pick.readOnly })),
    ...(change.access === "off"
      ? []
      : [
          {
            folderId: change.folderId,
            name: kept?.name ?? change.name,
            readOnly: change.access === "read",
          },
        ]),
  ];
};

/** A folder's access as the server holds it. */
export const confirmedAccess = (
  confirmed: ReadonlyArray<FolderPick>,
  folderId: string,
): FolderAccess => {
  const pick = confirmed.find((entry) => entry.folder.id === folderId);
  return pick === undefined ? "off" : pick.readOnly ? "read" : "write";
};

/** The access a folder shows: the newest change still on its way, else what the server holds. */
export const shownAccess = (
  confirmed: ReadonlyArray<FolderPick>,
  pending: ReadonlyArray<Pick<FolderChange, "folderId" | "access">>,
  folderId: string,
): FolderAccess =>
  pending.findLast((change) => change.folderId === folderId)?.access ??
  confirmedAccess(confirmed, folderId);

/** The words for each access, as the frame's control and a reader's row say them. */
export const ACCESS_WORDS: Readonly<Record<FolderAccess, string>> = {
  off: "Off",
  read: "Read only",
  write: "Read and write",
};

/** Narrows a mutation's stored variables back to a folder change. */
export const isFolderChange = (value: unknown): value is FolderChange =>
  typeof value === "object" &&
  value !== null &&
  typeof Reflect.get(value, "projectId") === "string" &&
  typeof Reflect.get(value, "folderId") === "string" &&
  typeof Reflect.get(value, "name") === "string" &&
  (["off", "read", "write"] as const).some((access) => access === Reflect.get(value, "access"));

/** One reference turned on or off for a project. */
export interface ReferenceChange {
  readonly projectId: string;
  readonly referenceId: string;
  readonly selected: boolean;
}

/** The references to send for one change: what the server last confirmed, with this one in or out. */
export const nextReferenceIds = (
  confirmed: ReadonlyArray<{ readonly id: string }>,
  change: Pick<ReferenceChange, "referenceId" | "selected">,
): ReadonlyArray<string> => {
  const ids = confirmed.map((reference) => reference.id).filter((id) => id !== change.referenceId);
  return change.selected ? [...ids, change.referenceId] : ids;
};

/** Whether a reference shows as on: the newest change still on its way, else the server's. */
export const shownSelected = (
  confirmed: ReadonlyArray<{ readonly id: string }>,
  pending: ReadonlyArray<Pick<ReferenceChange, "referenceId" | "selected">>,
  referenceId: string,
): boolean =>
  pending.findLast((change) => change.referenceId === referenceId)?.selected ??
  confirmed.some((reference) => reference.id === referenceId);

/** Narrows a mutation's stored variables back to a reference change. */
export const isReferenceChange = (value: unknown): value is ReferenceChange =>
  typeof value === "object" &&
  value !== null &&
  typeof Reflect.get(value, "projectId") === "string" &&
  typeof Reflect.get(value, "referenceId") === "string" &&
  typeof Reflect.get(value, "selected") === "boolean";

/**
 * A reference's version, as the frame's Version column says it: the branch or tag it is held at,
 * else the commit Mend last fetched, else "default branch".
 */
export const referenceVersion = (reference: {
  readonly pinnedRef: string | null;
  readonly headSha: string | null;
}): string => reference.pinnedRef ?? reference.headSha?.slice(0, 7) ?? "default branch";

/** A folder's size, from its listing: "12 files · 180 KB". A listing the server cut short says so. */
export const folderSize = (listing: {
  readonly files: ReadonlyArray<{ readonly bytes: number }>;
  readonly truncated: boolean;
}): string => {
  const count = listing.files.length;
  if (count === 0) return "Empty";
  const bytes = listing.files.reduce((sum, file) => sum + file.bytes, 0);
  const files = `${count}${listing.truncated ? "+" : ""} ${count === 1 && !listing.truncated ? "file" : "files"}`;
  return `${files} · ${listing.truncated ? "over " : ""}${sizeWords(bytes)}`;
};

/**
 * What a captured deployment does to each kind of material (`mountDelivery: "sources"`): folders
 * and references arrive as copies, while server folders and linked projects don't arrive at all.
 * Null where everything is mounted as it is.
 */
export const capturedNote = (
  kind: "folders" | "server-folders" | "links",
  mountDelivery: "bind" | "sources",
  projectName: string,
): string | null => {
  if (mountDelivery === "bind") return null;
  switch (kind) {
    case "folders":
      return "Sessions here get a copy of each folder, so what they write stays in their own workspace.";
    case "server-folders":
      return `Sessions here run in captured workspaces, which don't get server folders, so sessions in ${projectName} start without them.`;
    case "links":
      return `Sessions here run in captured workspaces, which don't get linked projects, so sessions in ${projectName} start without them.`;
  }
};

/** The projects a project can link: every other project not linked already, by name. */
export const linkCandidates = <P extends { readonly id: string; readonly name: string }>(
  projects: ReadonlyArray<P>,
  projectId: string,
  links: ReadonlyArray<{ readonly linkedProjectId: string }>,
): ReadonlyArray<P> =>
  projects
    .filter(
      (project) =>
        project.id !== projectId && !links.some((link) => link.linkedProjectId === project.id),
    )
    .toSorted((a, b) => a.name.localeCompare(b.name));

/** Where a linked project appears in sessions. */
export const linkPath = (name: string): string => `/workspace/repos/${name}`;

/**
 * What Link project sends, from the dialog's fields: the directory name defaults to the linked
 * project's own name, and a blank worktree means the default branch's. Null until a project is
 * picked.
 */
export const linkRequest = (
  linked: { readonly id: string; readonly name: string } | null,
  name: string,
  worktree: string,
): {
  readonly linkedProjectId: string;
  readonly name: string;
  readonly worktreeName: string | null;
} | null => {
  if (linked === null) return null;
  const mount = name.trim() === "" ? linked.name : name.trim();
  return {
    linkedProjectId: linked.id,
    name: mount,
    worktreeName: worktree.trim() === "" ? null : worktree.trim(),
  };
};
