import * as fs from "node:fs";
import * as path from "node:path";

import type { ApiCall } from "./pair.ts";

/**
 * The organization from a terminal (docs/adr/0003-organizations-and-tenancy.md): `mend invite`,
 * `mend members`, `mend folder` and `mend session share`. Owners act; members read. The server
 * enforces every rule; these commands only say plainly what it answered.
 */

const paint = (code: string) => (text: string) =>
  process.stdout.isTTY === true ? `[${code}m${text}[0m` : text;
const dim = paint("2");
const green = paint("32");
const say = (line: string) => process.stdout.write(`${line}\n`);
const fail = (message: string): never => {
  process.stderr.write(`mend: ${message}\n`);
  process.exit(1);
};

const takeFlagValue = (args: ReadonlyArray<string>, flag: string): string | null => {
  const at = args.indexOf(flag);
  return at !== -1 && args[at + 1] !== undefined ? String(args[at + 1]) : null;
};

interface OrganizationView {
  readonly organization: { readonly id: string; readonly name: string };
  readonly userId: string;
  readonly role: "owner" | "member";
  readonly memberCount: number;
  readonly mountDelivery: "bind" | "none";
}

interface MemberDto {
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  readonly role: "owner" | "member";
  readonly joinedAt: string;
}

interface FolderDto {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
}

const day = (iso: string) => iso.slice(0, 10);

const organizationOf = (api: ApiCall) => api<OrganizationView>("GET", "/organization");

// ─── members ────────────────────────────────────────────────────────────────

/** The roster as the terminal prints it: a header, then one aligned row per member. */
export const renderMembers = (
  view: Pick<OrganizationView, "organization" | "userId">,
  members: ReadonlyArray<MemberDto>,
): ReadonlyArray<string> => {
  const nameWidth = Math.max(4, ...members.map((member) => member.name.length));
  const emailWidth = Math.max(5, ...members.map((member) => member.email.length));
  return [
    `${view.organization.name} · ${members.length} ${members.length === 1 ? "member" : "members"}`,
    ...members.map(
      (member) =>
        `${member.userId === view.userId ? "▸" : " "} ${member.name.padEnd(nameWidth)}  ${member.email.padEnd(emailWidth)}  ${member.role.padEnd(6)}  joined ${day(member.joinedAt)}`,
    ),
  ];
};

export const membersCommand = async (api: ApiCall) => {
  const view = await organizationOf(api);
  const members = await api<ReadonlyArray<MemberDto>>("GET", "/organization/members");
  for (const line of renderMembers(view, members)) say(line);
};

// ─── invite ─────────────────────────────────────────────────────────────────

export const inviteCommand = async (api: ApiCall, baseUrl: string, args: ReadonlyArray<string>) => {
  const role = takeFlagValue(args, "--role") ?? "member";
  if (role !== "member" && role !== "owner") {
    return fail(`--role takes "member" or "owner", not "${role}"`);
  }
  const email = takeFlagValue(args, "--email");
  const daysValue = takeFlagValue(args, "--days");
  const days = daysValue === null ? null : Number.parseInt(daysValue, 10);
  if (days !== null && (Number.isNaN(days) || days < 1)) {
    return fail(`--days takes a whole number of days, not "${daysValue}"`);
  }
  const view = await organizationOf(api);
  if (view.role !== "owner") return fail("only an owner can invite; mend members shows who");
  const created = await api<{
    readonly path: string;
    readonly invitation: { readonly expiresAt: string };
  }>("POST", "/organization/invitations", {
    role,
    ...(email === null ? {} : { email }),
    ...(days === null ? {} : { expiresInDays: days }),
  });
  say(`${baseUrl.replace(/\/+$/, "")}${created.path}`);
  say(
    dim(
      `works once · ${role}${email === null ? "" : ` · for ${email}`} · expires ${day(created.invitation.expiresAt)}`,
    ),
  );
};

// ─── folders ────────────────────────────────────────────────────────────────

/** The server's caps: per file, and per upload request (decoded bytes). */
export const FOLDER_FILE_BYTES = 1024 * 1024;
export const FOLDER_REQUEST_BYTES = 4 * 1024 * 1024;

const SKIPPED_DIRECTORIES = new Set([".git", "node_modules"]);

/** A file to push by its place in the folder and its size; its bytes are read per batch. */
export interface ScannedFile {
  readonly path: string;
  readonly size: number;
}

export interface ScannedFolder {
  readonly files: ReadonlyArray<ScannedFile>;
  readonly skipped: ReadonlyArray<{ readonly path: string; readonly reason: string }>;
}

/**
 * Everything under `dir` that an upload may carry, as folder-relative paths with forward slashes.
 * Version control and dependency directories are left out, symlinks are never followed, and files
 * over the per-file cap are named rather than sent.
 */
export const scanFolder = (dir: string): ScannedFolder => {
  const files: Array<ScannedFile> = [];
  const skipped: Array<{ readonly path: string; readonly reason: string }> = [];
  const walk = (relative: string) => {
    const entries = fs
      .readdirSync(path.join(dir, relative), { withFileTypes: true })
      .toSorted((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        skipped.push({ path: child, reason: "symlink" });
      } else if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) skipped.push({ path: child, reason: "skipped" });
        else walk(child);
      } else if (entry.isFile()) {
        const size = fs.statSync(path.join(dir, child)).size;
        if (size > FOLDER_FILE_BYTES) skipped.push({ path: child, reason: "over 1 MiB" });
        else files.push({ path: child, size });
      }
    }
  };
  walk("");
  return { files, skipped };
};

/** Pack files into upload requests under the request cap, in order. */
export const uploadBatches = <F extends { readonly size: number }>(
  files: ReadonlyArray<F>,
  cap = FOLDER_REQUEST_BYTES,
): ReadonlyArray<ReadonlyArray<F>> => {
  const batches: Array<Array<F>> = [];
  let current: Array<F> = [];
  let size = 0;
  for (const file of files) {
    if (current.length > 0 && size + file.size > cap) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(file);
    size += file.size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
};

const folderNamed = async (api: ApiCall, name: string | undefined) => {
  if (name === undefined) return fail("name the folder · mend folder list shows them");
  const folders = await api<ReadonlyArray<FolderDto>>("GET", "/organization/folders");
  const folder = folders.find((candidate) => candidate.name === name);
  return folder ?? fail(`no folder named "${name}" · mend folder list shows them`);
};

export const folderCommand = async (api: ApiCall, args: ReadonlyArray<string>) => {
  const [verb, name, dir] = args.filter((arg) => !arg.startsWith("--"));
  switch (verb) {
    case undefined:
    case "list": {
      const folders = await api<ReadonlyArray<FolderDto>>("GET", "/organization/folders");
      if (folders.length === 0) {
        say(dim("no folders yet · an owner creates one with mend folder create <name>"));
        return;
      }
      for (const folder of folders)
        say(`${folder.name}  ${dim(`created ${day(folder.createdAt)}`)}`);
      return;
    }
    case "create": {
      if (name === undefined) return fail("usage: mend folder create <name>");
      const folder = await api<FolderDto>("POST", "/organization/folders", { name });
      say(`${green("✓")} created folder ${folder.name}`);
      return;
    }
    case "push": {
      if (dir === undefined) return fail("usage: mend folder push <name> <dir> [--replace]");
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        return fail(`${dir} is not a directory`);
      }
      const folder = await folderNamed(api, name);
      const scanned = scanFolder(dir);
      const replace = args.includes("--replace");
      const batches = uploadBatches(scanned.files);
      if (batches.length === 0 && replace) {
        await api("POST", `/organization/folders/${folder.id}/files`, { files: [], merge: false });
      }
      for (const [index, batch] of batches.entries()) {
        await api("POST", `/organization/folders/${folder.id}/files`, {
          files: batch.map((file) => ({
            path: file.path,
            // Read one batch at a time, so a large tree never sits in memory at once.
            contentsBase64: fs.readFileSync(path.join(dir, file.path)).toString("base64"),
          })),
          // --replace empties the folder with the first batch; the rest add to it.
          merge: !(replace && index === 0),
        });
      }
      const reasons = [...new Set(scanned.skipped.map((entry) => entry.reason))];
      say(
        `${green("✓")} pushed ${scanned.files.length} ${scanned.files.length === 1 ? "file" : "files"} to ${folder.name}${
          scanned.skipped.length === 0
            ? ""
            : dim(` · ${scanned.skipped.length} skipped (${reasons.join(", ")})`)
        }`,
      );
      return;
    }
    case "rm": {
      const folder = await folderNamed(api, name);
      await api("DELETE", `/organization/folders/${folder.id}`);
      say(`${green("✓")} removed folder ${folder.name}`);
      return;
    }
    default:
      return fail(`unknown folder command "${verb}" · mend help folder`);
  }
};

// ─── session share ──────────────────────────────────────────────────────────

export const sessionShareCommand = async (api: ApiCall, args: ReadonlyArray<string>) => {
  const [prefix, state] = args.filter((arg) => !arg.startsWith("--"));
  if (prefix === undefined || (state !== "on" && state !== "off")) {
    return fail("usage: mend session share <session> on|off");
  }
  const sessions = await api<ReadonlyArray<{ readonly id: string; readonly harness: string }>>(
    "GET",
    "/sessions?retained=1",
  );
  const matches = sessions.filter((session) => session.id.startsWith(prefix));
  if (matches.length === 0) return fail(`no live session starts with "${prefix}"`);
  if (matches.length > 1)
    return fail(`"${prefix}" matches ${matches.length} sessions; type more of the id`);
  const [session] = matches;
  if (session === undefined) return fail(`no live session starts with "${prefix}"`);
  await api("PUT", `/sessions/${session.id}/shared-control`, { enabled: state === "on" });
  say(
    state === "on"
      ? `${green("✓")} shared control on · ${session.harness} ${dim(session.id.slice(0, 8))} · everyone who can see the project steers it on your credentials`
      : `${green("✓")} shared control off · ${session.harness} ${dim(session.id.slice(0, 8))}`,
  );
};
