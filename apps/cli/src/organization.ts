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
  readonly operator: boolean;
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

// ─── operator ───────────────────────────────────────────────────────────────

interface OrganizationSummaryDto {
  readonly organization: { readonly id: string; readonly name: string; readonly createdAt: string };
  readonly memberCount: number;
  readonly ownerCount: number;
}

interface OneTimeLinkDto {
  readonly path: string;
  readonly expiresAt: string;
}

/** The operator's organizations as the terminal prints them; an ownerless one says so. */
export const renderOrganizations = (
  rows: ReadonlyArray<OrganizationSummaryDto>,
): ReadonlyArray<string> => {
  if (rows.length === 0) return ["no organizations"];
  const width = Math.max(...rows.map((row) => row.organization.name.length));
  return rows.map(
    (row) =>
      `${row.organization.name.padEnd(width)}  ${row.memberCount} ${row.memberCount === 1 ? "member" : "members"} · ${
        row.ownerCount === 0
          ? "no owner"
          : `${row.ownerCount} ${row.ownerCount === 1 ? "owner" : "owners"}`
      }`,
  );
};

const printLink = (baseUrl: string, link: OneTimeLinkDto, what: string) => {
  say(`${baseUrl.replace(/\/+$/, "")}${link.path}`);
  say(dim(`${what} · works once · expires ${day(link.expiresAt)}`));
};

/**
 * `mend operator …` (docs/adr/0003, "Operator" and "Recovery"): name organizations, bring in an
 * owner, reset a password. The operator never reads organization content from here.
 */
export const operatorCommand = async (
  api: ApiCall,
  /** The same call, throwing instead of exiting, so a refusal can be read. */
  tryApi: ApiCall,
  baseUrl: string,
  args: ReadonlyArray<string>,
) => {
  const words = args.filter((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--email");
  // Ask an operator route itself: an operator may belong to no organization (removed from one,
  // or before the first exists), and only the server knows the role.
  const refused = await tryApi("GET", "/operator/organizations").then(
    () => null,
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
  if (refused !== null) {
    return fail(
      refused.endsWith("→ 404") ? "this account is not the operator of this Mend" : refused,
    );
  }
  const organizationNamed = async (name: string | undefined) => {
    if (name === undefined)
      return fail("name the organization · mend operator org list shows them");
    const rows = await api<ReadonlyArray<OrganizationSummaryDto>>("GET", "/operator/organizations");
    const row = rows.find((candidate) => candidate.organization.name === name);
    return row?.organization ?? fail(`no organization named "${name}"`);
  };
  const [first, second, third, fourth] = words;
  if (first === "org") {
    switch (second) {
      case undefined:
      case "list": {
        const rows = await api<ReadonlyArray<OrganizationSummaryDto>>(
          "GET",
          "/operator/organizations",
        );
        for (const line of renderOrganizations(rows)) say(line);
        return;
      }
      case "create": {
        if (third === undefined) return fail("usage: mend operator org create <name>");
        const created = await api<{ readonly name: string }>("POST", "/operator/organizations", {
          name: third,
        });
        say(
          `${green("✓")} created ${created.name} · mend operator org invite-owner ${created.name}`,
        );
        return;
      }
      case "rename": {
        if (fourth === undefined) return fail("usage: mend operator org rename <org> <name>");
        const organization = await organizationNamed(third);
        await api("PUT", `/operator/organizations/${organization.id}/name`, { name: fourth });
        say(`${green("✓")} renamed ${organization.name} to ${fourth}`);
        return;
      }
      case "invite-owner": {
        const organization = await organizationNamed(third);
        const email = takeFlagValue(args, "--email");
        const link = await api<OneTimeLinkDto>(
          "POST",
          `/operator/organizations/${organization.id}/invitations`,
          email === null ? {} : { email },
        );
        printLink(
          baseUrl,
          link,
          `owner of ${organization.name}${email === null ? "" : ` · for ${email}`}`,
        );
        return;
      }
      default:
        return fail(`unknown operator org command "${second}" · mend help operator org list`);
    }
  }
  if (first === "grant-owner") {
    if (third === undefined) return fail("usage: mend operator grant-owner <org> <email>");
    const organization = await organizationNamed(second);
    await api("POST", `/operator/organizations/${organization.id}/owners`, { email: third });
    say(`${green("✓")} ${third} is an owner of ${organization.name}`);
    return;
  }
  if (first === "reset-link") {
    if (second === undefined) return fail("usage: mend operator reset-link <email>");
    const link = await api<OneTimeLinkDto>("POST", "/operator/password-resets", { email: second });
    printLink(baseUrl, link, `password reset for ${second}`);
    return;
  }
  return fail(`unknown operator command "${first ?? ""}" · mend help operator org list`);
};
