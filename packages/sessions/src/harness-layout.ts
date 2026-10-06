/**
 * Per-person harness homes (docs/adr/0016-per-person-harness-homes.md), the parts that need no
 * engine: which layout a launch runs (decision 14), the scripts that make people's users and
 * homes inside an executor (decisions 1 and 2), the worktree repair (decision 2), and the user a
 * process starts as. Everything here is reached only behind `MEND_HARNESS_LAYOUT=person` or a
 * worktree already recorded `person`; with neither, a launch runs exactly as before.
 */
import { createHash } from "node:crypto";

import type { WorkspaceImage } from "@mend/domain";
import {
  type HarnessLayout,
  type HarnessLayoutSource,
  type LinuxIdentity,
  LINUX_UID_RANGE,
  MEND_GROUP,
  linuxHomeOf,
} from "@mend/domain/workbench";

import { shellQuote } from "./workspace-files.ts";

// ─── the decision ────────────────────────────────────────────────────────────

/**
 * What is known, before create, of whether an executor of this image can run the person layout
 * (decision 1). `person` null: nobody knows yet (no record for the image, and Core reports
 * nothing). `missing`: what it lacks, each in the words the refusal line names.
 */
export interface LayoutCapability {
  readonly person: boolean | null;
  readonly missing: ReadonlyArray<string>;
  /** Who said so: Mend's record of a prepare, Core's report, or what Mend knows statically. */
  readonly source: "mend" | "core" | "static" | null;
}

export const UNKNOWN_CAPABILITY: LayoutCapability = { person: null, missing: [], source: null };

export interface LayoutDecisionInput {
  /** `MEND_HARNESS_LAYOUT`: decides only a worktree with no layout yet. */
  readonly flag: HarnessLayout;
  /** `worktrees.harness_layout` and the operator's `harnessLayout` for the worktree. */
  readonly worktree: {
    readonly layout: "person" | null;
    readonly requested: HarnessLayout | null;
  };
  /** The worktree's head capture holds `harness/people/`: person, record or not. */
  readonly headHasPeople: boolean;
  readonly capability: LayoutCapability;
}

/**
 * What prepare does about a `person` launch when it finds the executor cannot run it:
 * `refuse` releases the executor and runs nothing (a worktree already person, or an operator who
 * asked for person); `fallback` runs the launch `shared` on a fresh worktree, after the
 * launcher's logins and dotfiles are put where a shared executor reads them.
 */
export type PrepareFinding = "refuse" | "fallback";

export type LayoutDecision =
  | {
      readonly kind: "launch";
      readonly layout: "person";
      readonly source: HarnessLayoutSource;
      readonly onMissing: PrepareFinding;
    }
  | {
      readonly kind: "launch";
      readonly layout: "shared";
      readonly source: HarnessLayoutSource;
      /** Why, when it is not just the flag: said on the session line. */
      readonly reason: string | null;
      /** Prepare checks the image and records what it found, so the next launch knows. */
      readonly probe: boolean;
    }
  | { readonly kind: "refuse"; readonly message: string };

/**
 * The refusal of decision 14, naming what the image lacks: "This worktree's sessions are saved per
 * person, and its image cannot run per-person users (no sudo). Pick an image that can, or start a
 * new worktree."
 */
export const personLayoutRefusal = (missing: ReadonlyArray<string>): string =>
  `This worktree's sessions are saved per person, and its image cannot run per-person users` +
  `${missing.length === 0 ? "" : ` (${missing.join(", ")})`}. Pick an image that can, or start a new worktree.`;

/** The operator asked for person on an image that cannot run it (decision 14, the benchmark). */
export const operatorPersonRefusal = (missing: ReadonlyArray<string>): string =>
  `harnessLayout person was asked for, and this image cannot run per-person users` +
  `${missing.length === 0 ? "" : ` (${missing.join(", ")})`}.`;

/**
 * The layout a launch runs, decided before create (decision 14), in this order: the worktree's
 * sticky record (or a head that already holds `people/`), the operator's `harnessLayout` for a
 * worktree it made, then the flag, which the image's capability can rule `person` out of.
 */
export const decideHarnessLayout = (input: LayoutDecisionInput): LayoutDecision => {
  const { capability } = input;
  // There is no way back from person: whatever the flag, the operator or the image says.
  if (input.worktree.layout === "person" || input.headHasPeople) {
    if (capability.person === false) {
      return { kind: "refuse", message: personLayoutRefusal(capability.missing) };
    }
    return { kind: "launch", layout: "person", source: "worktree", onMissing: "refuse" };
  }
  if (input.worktree.requested === "shared") {
    return { kind: "launch", layout: "shared", source: "operator", reason: null, probe: false };
  }
  if (input.worktree.requested === "person") {
    if (capability.person === false) {
      return { kind: "refuse", message: operatorPersonRefusal(capability.missing) };
    }
    // Asked for by name: a prepare that finds otherwise refuses, it never falls back silently.
    return { kind: "launch", layout: "person", source: "operator", onMissing: "refuse" };
  }
  if (input.flag === "shared") {
    return { kind: "launch", layout: "shared", source: "flag", reason: null, probe: false };
  }
  if (capability.person === true) {
    return { kind: "launch", layout: "person", source: "flag", onMissing: "fallback" };
  }
  if (capability.person === false) {
    return {
      kind: "launch",
      layout: "shared",
      source: "capability",
      reason: `this image cannot run per-person users (${capability.missing.join(", ")}), so this workspace takes one person`,
      probe: capability.source !== "static",
    };
  }
  // Unknown means shared: the launch runs as before and its prepare records the answer, so the
  // next launch on this image can be person.
  return {
    kind: "launch",
    layout: "shared",
    source: "capability",
    reason: "per-person users not yet known for this image; checked while this workspace starts",
    probe: true,
  };
};

/**
 * What Mend knows without asking anyone: nix images keep their passwd in the read-only store
 * (decision 3), and a platform that cannot start a process as a user cannot run the layout at
 * all. Null when nothing static rules it out.
 */
export const staticLayoutObstacle = (
  image: WorkspaceImage,
  platform: { readonly processUser: boolean },
): string | null => {
  if (!platform.processUser) return "this Mend's platform cannot start processes as a user";
  if (image.mode === "family" && image.os === "nix") return "nix images run one person";
  return null;
};

/**
 * The key Mend records an image's capability under: Core's digest when it reports one, else the
 * image as Mend asks for it, which builds the same image until Core's images or pins change (and
 * each prepare records again, so a stale answer lasts one launch).
 */
export const imageLayoutKeyOf = (image: WorkspaceImage, digest: string | null): string => {
  if (digest !== null) return `digest:${digest}`;
  const spec =
    image.mode === "custom"
      ? { mode: "custom", baseImage: image.baseImage, packages: [...image.packages].toSorted() }
      : {
          mode: "family",
          os: image.os,
          shell: image.shell,
          packages: [...image.packages].toSorted(),
          docker: image.services.docker,
        };
  return `spec:${createHash("sha256").update(JSON.stringify(spec)).digest("hex").slice(0, 32)}`;
};

// ─── places ──────────────────────────────────────────────────────────────────

/** The saved root every person's saved directory sits under (decision 2). */
export const PEOPLE_DIR = "people";

/** `P`: a person's saved directory, under the harness home. */
export const savedDirOf = (harnessHome: string, accountId: string): string =>
  `${harnessHome}/${PEOPLE_DIR}/${accountId}`;

/** Codex's thread index and memory database, saved in `P` (`CODEX_SQLITE_HOME`). */
export const codexDatabaseDirOf = (harnessHome: string, accountId: string): string =>
  `${savedDirOf(harnessHome, accountId)}/codex-db`;

/**
 * The conversation state a person's home links into their saved directory (decision 2): every
 * piece of a harness's home saved today, each reached from `R` through one link at the same
 * relative path in `P`. Logins stay out: they are files in `R`, never under these links.
 */
export const PERSON_SAVED_STATE: ReadonlyArray<{
  readonly path: string;
  readonly kind: "directory" | "file";
}> = [
  // Claude: transcripts, tool results, sub-agents and auto memory; plans; todos; the task list;
  // `/rewind`'s file history; what the agent writes of its own agents, commands and skills.
  { path: ".claude/projects", kind: "directory" },
  { path: ".claude/plans", kind: "directory" },
  { path: ".claude/todos", kind: "directory" },
  { path: ".claude/tasks", kind: "directory" },
  { path: ".claude/file-history", kind: "directory" },
  { path: ".claude/agents", kind: "directory" },
  { path: ".claude/commands", kind: "directory" },
  { path: ".claude/skills", kind: "directory" },
  { path: ".claude/history.jsonl", kind: "file" },
  // Codex: rollouts, archived threads, memories, approvals, the session index and history; its
  // databases are `codex-db` (`CODEX_SQLITE_HOME`).
  { path: ".codex/sessions", kind: "directory" },
  { path: ".codex/archived_sessions", kind: "directory" },
  { path: ".codex/memories", kind: "directory" },
  { path: ".codex/rules", kind: "directory" },
  { path: ".codex/session_index.jsonl", kind: "file" },
  { path: ".codex/history.jsonl", kind: "file" },
  // pi: sessions and its settings.
  { path: ".pi/agent/sessions", kind: "directory" },
  { path: ".pi/agent/settings.json", kind: "file" },
  // opencode: its data directory (its database) and its state directory.
  { path: ".local/share/opencode", kind: "directory" },
  { path: ".local/state/opencode", kind: "directory" },
];

/** A process's private temporary and runtime directories (decision 1), both 0700. */
export const privateTmpOf = (uid: number): string => `/tmp/u-${uid}`;
export const privateRuntimeOf = (uid: number): string => `/run/user/${uid}`;

/** The marker the worktree repair walks from: made when the executor starts, moved per repair. */
export const REPAIR_MARKER = "/run/mend/repair";

// ─── who a process runs as ───────────────────────────────────────────────────

/**
 * The user a process starts as: what the SDK's `user` option on sessions and exec carries
 * (Core Delivery 8, sealantd Delivery 5). sealantd sets uid, gid and groups, `HOME`, `USER`,
 * `LOGNAME` and `SHELL` from the passwd entry, umask `0002`, and the private `TMPDIR` and
 * `XDG_RUNTIME_DIR`; Mend names the user and the ids it allocated.
 */
export interface ProcessUser {
  readonly name: string;
  readonly uid: number;
  readonly gid: number;
  readonly groups: ReadonlyArray<number>;
  readonly home: string;
  readonly umask: number;
}

export const processUserOf = (identity: LinuxIdentity): ProcessUser => ({
  name: identity.name,
  uid: identity.uid,
  gid: MEND_GROUP.gid,
  groups: [MEND_GROUP.gid],
  home: linuxHomeOf(identity),
  umask: 0o002,
});

/**
 * The environment a person's agent process gets beside what sealantd derives from the passwd
 * entry: Codex's databases in the person's saved directory, so a first start does not re-index
 * and the person's thread index is saved with their conversations (decision 2, Performance).
 */
export const personProcessEnv = (
  harnessHome: string,
  identity: LinuxIdentity,
): Readonly<Record<string, string>> => ({
  CODEX_SQLITE_HOME: codexDatabaseDirOf(harnessHome, identity.accountId),
  TMPDIR: privateTmpOf(identity.uid),
  XDG_RUNTIME_DIR: privateRuntimeOf(identity.uid),
});

// ─── the scripts ─────────────────────────────────────────────────────────────

const SAFE_ACCOUNT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_LOGIN = /^m[a-z2-7]{8}$/;

/** Account ids and login names go into scripts unquoted only after this. */
export const assertScriptSafe = (identity: LinuxIdentity): void => {
  if (!SAFE_ACCOUNT_ID.test(identity.accountId)) {
    throw new Error(`account id ${JSON.stringify(identity.accountId)} cannot name a directory`);
  }
  if (!SAFE_LOGIN.test(identity.name)) {
    throw new Error(`login name ${JSON.stringify(identity.name)} is not one Mend allocates`);
  }
  if (identity.uid <= LINUX_UID_RANGE.first || identity.uid > LINUX_UID_RANGE.last) {
    throw new Error(
      `uid ${identity.uid} is outside ${LINUX_UID_RANGE.first}–${LINUX_UID_RANGE.last}`,
    );
  }
};

/** What a layout line on stdout says (`parseLayoutReport`). */
export const LAYOUT_LINE = "mend-layout";

/**
 * The image probe of decision 1, inside the executor, as root: `sudo`, `useradd` and `setfacl`,
 * sealantd's `exec.user`, `dotfiles.user` and `restore.owner_map` (`sealantd capabilities
 * --json`), no user or group in the reserved range other than `mend`, none of the people's names
 * taken by another uid, and ACLs on `/workspace`. Prints one `mend-layout missing <words>` per
 * thing missing, then `mend-layout probed`. Folded into the executor's first exec, so it costs no
 * exec of its own.
 */
export const layoutProbeScript = (
  people: ReadonlyArray<LinuxIdentity>,
  options: { readonly passwd?: string; readonly group?: string; readonly aclDir?: string } = {},
): string => {
  for (const person of people) assertScriptSafe(person);
  const passwd = shellQuote(options.passwd ?? "/etc/passwd");
  const group = shellQuote(options.group ?? "/etc/group");
  const aclDir = options.aclDir ?? "/workspace";
  const range = `$3>=${LINUX_UID_RANGE.first} && $3<=${LINUX_UID_RANGE.last}`;
  return [
    `layout_missing=0`,
    `missing() { printf '%s missing %s\\n' ${LAYOUT_LINE} "$1"; layout_missing=1; }`,
    `command -v sudo >/dev/null 2>&1 || missing "no sudo"`,
    `command -v useradd >/dev/null 2>&1 || missing "no useradd"`,
    `command -v setfacl >/dev/null 2>&1 || missing "no setfacl"`,
    `caps=$(sealantd capabilities --json 2>/dev/null || true)`,
    `for c in exec.user dotfiles.user restore.owner_map; do case "$caps" in *"\\"$c\\""*) ;; ` +
      `*) missing "its sealantd cannot run processes as a user"; break ;; esac; done`,
    // Every reserved uid and gid the image already uses, whoever holds it; the people's names.
    `for w in $(awk -F: '${range} { print $3 }' ${passwd} 2>/dev/null); do missing "uid $w is taken in this image"; done`,
    `for w in $(awk -F: '${range} && !($1=="${MEND_GROUP.name}" && $3==${MEND_GROUP.gid}) { print $3 }' ${group} 2>/dev/null); ` +
      `do missing "gid $w is taken in this image"; done`,
    `awk -F: '$1=="${MEND_GROUP.name}" && $3!=${MEND_GROUP.gid} { f=1 } END { exit !f }' ${group} 2>/dev/null && ` +
      `missing "group ${MEND_GROUP.name} is taken in this image"`,
    ...people.map(
      (person) =>
        `awk -F: '$1=="${person.name}" && $3!=${person.uid} { f=1 } END { exit !f }' ${passwd} 2>/dev/null && ` +
        `missing "user ${person.name} is taken in this image"`,
    ),
    `if t=$(mktemp -d ${shellQuote(`${aclDir}/.mend-acl.`)}XXXXXX 2>/dev/null); then ` +
      `setfacl -m d:g::rwx "$t" >/dev/null 2>&1 || missing "no ACLs on /workspace"; rm -rf "$t"; ` +
      `else missing "no ACLs on /workspace"; fi`,
    `printf '%s probed\\n' ${LAYOUT_LINE}`,
  ].join("\n");
};

/** What the probe and the prepare said, read from stdout. */
export interface LayoutReport {
  /** The probe ran to its end. */
  readonly probed: boolean;
  readonly missing: ReadonlyArray<string>;
  /** The person layout was made (`mend-layout ready`). */
  readonly ready: boolean;
  /**
   * The login names whose user and home this prepare made (`mend-layout made <name>`), and no
   * one else: a member with an identity but no saved directory in this head is not among them,
   * so their first process makes them.
   */
  readonly made: ReadonlyArray<string>;
}

export const parseLayoutReport = (stdout: string): LayoutReport => {
  const missing: Array<string> = [];
  const made: Array<string> = [];
  let probed = false;
  let ready = false;
  for (const line of stdout.split("\n")) {
    if (!line.startsWith(`${LAYOUT_LINE} `)) continue;
    const rest = line.slice(LAYOUT_LINE.length + 1).trim();
    if (rest === "probed") probed = true;
    else if (rest === "ready") ready = true;
    else if (rest.startsWith("made ")) {
      const name = rest.slice("made ".length).trim();
      if (name !== "" && !made.includes(name)) made.push(name);
    } else if (rest.startsWith("missing ")) {
      const words = rest.slice("missing ".length).trim();
      if (words !== "" && !missing.includes(words)) missing.push(words);
    }
  }
  return { probed, missing, ready, made };
};

/** Every parent directory of these relative paths, shallowest first, once each. */
const parentsOf = (paths: ReadonlyArray<string>): ReadonlyArray<string> => [
  ...new Set(
    paths.flatMap((entry) => {
      const parts = entry.split("/").slice(0, -1);
      return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
    }),
  ),
];

/**
 * One person's user, home and saved directory, as root (decisions 1 and 2): the user made with its
 * fixed uid, primary group `mend`, the image's login shell and a home from `/etc/skel` set 0700;
 * the private temporary and runtime directories; `P` (0710, `conversations/` 2710, `codex-db`)
 * owned by the user; and in `R` one link per entry of `PERSON_SAVED_STATE` into `P`. Idempotent:
 * a user that exists with the same uid is kept, and a link already there is left. A user of that
 * name with another uid fails the script. As a non-root caller (the tests) it makes the same
 * directories and links and skips what only root does.
 *
 * A home that exists before its user does is the launcher's: Core writes their logins into
 * `credentialsHome` at create, before prepare's first exec, as root, because the user it would
 * write them as does not exist yet. `useradd -m` then keeps the directory, copies nothing from
 * `/etc/skel` and changes no owner, so the script copies the skeleton in itself, never over a
 * file already there, and gives the user everything in the home. From then on the home belongs
 * to the user, and Core writes every later login there as the home's owner.
 */
export const personHomeScript = (
  person: LinuxIdentity,
  options: {
    readonly harnessHome: string;
    /** `R`; the passwd home, `/home/<name>`, unless a test names another. */
    readonly home?: string;
    readonly tmpRoot?: string;
    readonly runRoot?: string;
    /** The skeleton a new home is made from; `/etc/skel` unless a test names another. */
    readonly skel?: string;
  },
): string => {
  assertScriptSafe(person);
  const home = options.home ?? linuxHomeOf(person);
  const skel = options.skel ?? "/etc/skel";
  const saved = savedDirOf(options.harnessHome, person.accountId);
  const tmp = `${options.tmpRoot ?? "/tmp"}/u-${person.uid}`;
  const run = `${options.runRoot ?? "/run/user"}/${person.uid}`;
  const owner = `${person.uid}:${MEND_GROUP.gid}`;
  const q = shellQuote;
  const dirs = PERSON_SAVED_STATE.filter((entry) => entry.kind === "directory");
  const all = PERSON_SAVED_STATE.map((entry) => entry.path);
  return [
    `set -e`,
    `fail() { printf 'mend: %s\\n' "$1" >&2; exit 1; }`,
    `root=0; [ "$(id -u)" = 0 ] && root=1`,
    // The user, once: its uid is checked against the passwd entry whoever made it.
    `if [ "$root" = 1 ]; then ` +
      `if id -u ${person.name} >/dev/null 2>&1; then ` +
      `[ "$(id -u ${person.name})" = ${person.uid} ] || fail "user ${person.name} has another uid in this image"; ` +
      `else ` +
      `grep -q '^${MEND_GROUP.name}:' /etc/group || groupadd -g ${MEND_GROUP.gid} ${MEND_GROUP.name}; ` +
      `sh_=$(awk -F: '$1=="root" { print $7 }' /etc/passwd); [ -n "$sh_" ] || sh_=/bin/sh; ` +
      `extra=; grep -q '^docker:' /etc/group && extra="-G docker"; ` +
      `pre=0; [ -d ${q(home)} ] && pre=1; ` +
      `useradd -u ${person.uid} -g ${MEND_GROUP.name} $extra -m -k ${q(skel)} -d ${q(home)} -s "$sh_" ${person.name}; ` +
      // What Core wrote before the user existed is root's, and useradd copied no skeleton into
      // a home that was already there: both become the user's, nothing already there replaced.
      `if [ "$pre" = 1 ]; then ` +
      `[ -d ${q(skel)} ] && cp -an ${q(`${skel}/.`)} ${q(home)}/; ` +
      `chown -hR ${owner} ${q(home)}; fi; ` +
      `fi; fi`,
    `mkdir -p ${q(home)}`,
    `[ "$root" = 1 ] && chown ${owner} ${q(home)} || true`,
    `chmod 0700 ${q(home)}`,
    `mkdir -p ${q(tmp)} ${q(run)}`,
    `[ "$root" = 1 ] && chown ${owner} ${q(tmp)} ${q(run)} || true`,
    `chmod 0700 ${q(tmp)} ${q(run)}`,
    // `P`: the people root is root's and traversable; each saved directory is its person's.
    `mkdir -p ${q(`${options.harnessHome}/${PEOPLE_DIR}`)} ${q(saved)}`,
    // A directory a restore brought back as root (before sealantd's owner map) becomes the
    // person's; one already theirs is not walked.
    `if [ "$root" = 1 ] && [ "$(stat -c %u ${q(saved)})" != ${person.uid} ]; then chown -R ${owner} ${q(saved)}; fi`,
    `chmod 0710 ${q(saved)}`,
    `mkdir -p ${q(`${saved}/conversations`)} ${q(`${saved}/codex-db`)}`,
    `chmod 2710 ${q(`${saved}/conversations`)}`,
    `chmod 0700 ${q(`${saved}/codex-db`)}`,
    ...parentsOf(all).map((dir) => `mkdir -p ${q(`${saved}/${dir}`)} ${q(`${home}/${dir}`)}`),
    ...dirs.map((entry) => `mkdir -p ${q(`${saved}/${entry.path}`)}`),
    // A link per entry; a real directory or file the image or a tool left there first moves
    // into `P` (nothing already in `P` is overwritten), then the link takes its place.
    ...all.map((entry) => {
      const from = q(`${home}/${entry}`);
      const to = q(`${saved}/${entry}`);
      return (
        `if [ -L ${from} ]; then [ "$(readlink ${from})" = ${to} ] || fail "unexpected link: ${home}/${entry}"; ` +
        `else if [ -e ${from} ]; then ` +
        `if [ -d ${from} ]; then cp -an ${from}/. ${to}/ && rm -rf ${from}; ` +
        `elif [ ! -e ${to} ]; then mv ${from} ${to}; else rm -f ${from}; fi; fi; ` +
        `ln -s ${to} ${from}; fi`
      );
    }),
    `if [ "$root" = 1 ]; then ` +
      `chown -h ${owner} ${all.map((entry) => q(`${home}/${entry}`)).join(" ")}; ` +
      `chown ${owner} ${parentsOf(all)
        .map((dir) => `${q(`${saved}/${dir}`)} ${q(`${home}/${dir}`)}`)
        .join(" ")} ${dirs.map((entry) => q(`${saved}/${entry.path}`)).join(" ")} ` +
      `${q(`${saved}/conversations`)} ${q(`${saved}/codex-db`)}; ` +
      `chgrp ${MEND_GROUP.gid} ${q(`${options.harnessHome}/${PEOPLE_DIR}`)}; fi`,
    `chmod 0711 ${q(`${options.harnessHome}/${PEOPLE_DIR}`)}`,
  ].join("\n");
};

/**
 * What prepare runs in a person-layout executor beside the helper install, as root and in the
 * same exec (decision 1): the probe, then, only when nothing is missing, every person's user and
 * home (`personHomeScript`), `/root` made traversable (0755: a custom image's toolchains under
 * `/root` still run for everyone), `core.sharedRepository=group` in the worktree's git config, and
 * the repair marker. Prints `mend-layout made <name>` for each person it made, and
 * `mend-layout ready` when all of that was made. People are made one at a time; a person who
 * cannot be made prints `mend-layout failed <name>`, and nobody after them is made. The script
 * never exits itself, so the helper install's status it rides with is still the exec's.
 */
export const personPrepareScript = (
  people: ReadonlyArray<{
    readonly person: LinuxIdentity;
    /** Made only when their saved directory came back with the restored head (members). */
    readonly ifSaved: boolean;
  }>,
  options: {
    readonly harnessHome: string;
    readonly repo: string;
    /** Where the tests put what the executor keeps at fixed paths; the executor's own when absent. */
    readonly places?: {
      readonly homesRoot?: string;
      readonly tmpRoot?: string;
      readonly runRoot?: string;
      readonly skel?: string;
      readonly marker?: string;
      readonly passwd?: string;
      readonly group?: string;
      readonly aclDir?: string;
    };
  },
): string => {
  const q = shellQuote;
  const places = options.places ?? {};
  const marker = places.marker ?? REPAIR_MARKER;
  const markerDir = marker.slice(0, marker.lastIndexOf("/"));
  const identities = people.map((entry) => entry.person);
  const homeOptions = {
    harnessHome: options.harnessHome,
    ...(places.tmpRoot === undefined ? {} : { tmpRoot: places.tmpRoot }),
    ...(places.runRoot === undefined ? {} : { runRoot: places.runRoot }),
    ...(places.skel === undefined ? {} : { skel: places.skel }),
  };
  return [
    layoutProbeScript(identities, {
      ...(places.passwd === undefined ? {} : { passwd: places.passwd }),
      ...(places.group === undefined ? {} : { group: places.group }),
      ...(places.aclDir === undefined ? {} : { aclDir: places.aclDir }),
    }),
    `layout_failed=0`,
    `if [ "$layout_missing" = 0 ]; then`,
    // One person at a time, each in a subshell of its own: a failure names its person, and only
    // a person this prepare made is reported made. The subshell is a statement of its own, never
    // the left side of `&&` or `||`, where the shell would ignore its `set -e` and a failed
    // `useradd` would pass for made.
    ...people.map(({ person, ifSaved }) => {
      const saved = q(savedDirOf(options.harnessHome, person.accountId));
      return (
        `if [ "$layout_failed" = 0 ]${ifSaved ? ` && [ -d ${saved} ]` : ""}; then\n` +
        `( ${personHomeScript(person, {
          ...homeOptions,
          ...(places.homesRoot === undefined ? {} : { home: `${places.homesRoot}/${person.name}` }),
        }).replaceAll("\n", "\n  ")}\n)\n` +
        `if [ "$?" = 0 ]; then printf '%s made %s\\n' ${LAYOUT_LINE} ${person.name}; ` +
        `else printf '%s failed %s\\n' ${LAYOUT_LINE} ${person.name}; layout_failed=1; fi\nfi`
      );
    }),
    `if [ "$layout_failed" = 0 ]; then`,
    `chmod 0755 /root 2>/dev/null || true`,
    `git -C ${q(options.repo)} config core.sharedRepository group 2>/dev/null || true`,
    `mkdir -p ${q(markerDir)} && touch ${q(marker)}`,
    `printf '%s ready\\n' ${LAYOUT_LINE}`,
    `fi`,
    `fi`,
  ].join("\n");
};

/**
 * The worktree repair of decision 2, one root exec started after another person's process
 * starts, never awaited by it. A file a tool created with an explicit mode (`install -m 644`,
 * `tar x`, `open(…, 0644)`) is not group-writable whatever the ACL; this gives every entry of the
 * worktree and its git directory changed since the last repair group read and write (and execute
 * where the owner has it), and directories setgid. Changed means the ctime, which the kernel sets
 * at creation: `tar x` restores the archive's older mtimes. The marker for the next repair is
 * touched before the walk and moved over the old one after it, and only entries that need it are
 * changed, so a repair's own `chmod` never makes the next one walk everything again. Prints one
 * `mend-repair <path>` per entry it changed.
 */
export const worktreeRepairScript = (
  options: { readonly repo?: string; readonly marker?: string } = {},
): string => {
  const repo = shellQuote(options.repo ?? "/workspace/repo");
  const marker = shellQuote(options.marker ?? REPAIR_MARKER);
  const next = shellQuote(`${options.marker ?? REPAIR_MARKER}.next`);
  return [
    `m=${marker}; n=${next}`,
    `[ -e "$m" ] || { touch "$n" && mv -f "$n" "$m"; exit 0; }`,
    `touch "$n"`,
    `roots=${repo}`,
    `g=$(git -C ${repo} rev-parse --path-format=absolute --git-common-dir 2>/dev/null) && [ -d "$g" ] && ` +
      `case "$g/" in ${repo}/*) ;; *) roots="$roots $g" ;; esac`,
    `l=$(git -C ${repo} rev-parse --path-format=absolute --git-dir 2>/dev/null) && [ -d "$l" ] && ` +
      `case "$l/" in ${repo}/*|"$g"/*) ;; *) roots="$roots $l" ;; esac`,
    // Directories that lack group rwx or setgid; then anything else (links aside) lacking group
    // rw, or group x where the owner has x.
    `find $roots -cnewer "$m" -type d ! -perm -2070 -print -exec chmod g+rwxs {} + 2>/dev/null | sed 's/^/mend-repair /'`,
    `find $roots -cnewer "$m" ! -type d ! -type l \\( ! -perm -g+rw -o -perm -u+x ! -perm -g+x \\) ` +
      `-print -exec chmod g+rwX {} + 2>/dev/null | sed 's/^/mend-repair /'`,
    `mv -f "$n" "$m"`,
  ].join("\n");
};
