/**
 * Deliveries per person (docs/adr/0016-per-person-harness-homes.md, Delivery 15), the parts that
 * need no engine: where each delivery lands in a person's home `R` and saved directory `P`, the
 * one exec that reads back what Mend last delivered there, the links put back after a person's
 * dotfiles, and the opencode scrub of decision 8a. Everything here runs as the person's own user,
 * into their own home, and is reached only in a person-layout executor.
 */
import { linuxHomeOf, type LinuxIdentity } from "@mend/domain/workbench";

import {
  ASIDE_FUNCTION,
  assertScriptSafe,
  PERSON_RECORDS_IN_SAVED,
  PERSON_SAVED_STATE,
  savedDirOf,
} from "./harness-layout.ts";
import { OPENCODE_DATABASE } from "./opencode-state.ts";
import { shellQuote } from "./workspace-files.ts";

// ─── where things land ───────────────────────────────────────────────────────

/**
 * Mend's per-person saved records (decision 2): `P/.mend-saved/`, addressed by their absolute
 * path, never through `~/.mend`, which is a real directory in `R` that is never saved (it holds the
 * person's Mend token and their secret files' record).
 */
export const PERSON_RECORDS_DIR = PERSON_RECORDS_IN_SAVED;

/** Codex's summary database, which Codex keeps where `CODEX_SQLITE_HOME` says: `P/codex-db`. */
const CODEX_MEMORY_DATABASE_IN_HOME = ".codex/memories_1.sqlite";
const CODEX_DATABASE_DIR = "codex-db";

/**
 * Where a home-relative path of what Mend delivers or reads back (a memory file, a record under
 * `.mend/`) lies in a person's saved directory, relative to `P`. Claude's memory and Codex's
 * memory folder are under `.claude/projects` and `.codex/memories`, which `R` links into `P` at the
 * same relative path; Codex's summary database is in `P/codex-db` (`CODEX_SQLITE_HOME`); Mend's own
 * records under `.mend/` are in `P/.mend-saved/`.
 */
export const personSavedPathOf = (homeRelative: string): string => {
  for (const suffix of ["", "-wal", "-shm"]) {
    if (homeRelative === `${CODEX_MEMORY_DATABASE_IN_HOME}${suffix}`) {
      return `${CODEX_DATABASE_DIR}/memories_1.sqlite${suffix}`;
    }
  }
  if (homeRelative.startsWith(".mend/")) {
    return `${PERSON_RECORDS_DIR}/${homeRelative.slice(".mend/".length)}`;
  }
  return homeRelative;
};

/** `personSavedPathOf` undone: the home-relative path a path in `P` was delivered as. */
export const homePathOfPersonSaved = (savedRelative: string): string => {
  for (const suffix of ["", "-wal", "-shm"]) {
    if (savedRelative === `${CODEX_DATABASE_DIR}/memories_1.sqlite${suffix}`) {
      return `${CODEX_MEMORY_DATABASE_IN_HOME}${suffix}`;
    }
  }
  if (savedRelative.startsWith(`${PERSON_RECORDS_DIR}/`)) {
    return `.mend/${savedRelative.slice(PERSON_RECORDS_DIR.length + 1)}`;
  }
  return savedRelative;
};

/** The skills manifests a person's delivery keeps in `P` (`skills.ts`'s, in the shared home). */
export const PERSON_SKILLS_MANIFEST = `${PERSON_RECORDS_DIR}/managed-skills.json`;
export const PERSON_SKILLS_DIGESTS = `${PERSON_RECORDS_DIR}/managed-skills-digests.json`;
/** Where a skills directory that is not Mend's to replace goes, in `P` (never deleted). */
export const PERSON_SKILLS_KEPT = `${PERSON_RECORDS_DIR}/skills-kept`;

/** The places one person's deliveries use in an executor. */
export interface PersonPlaces {
  /** `R`: the passwd home. */
  readonly home: string;
  /** `P`: the saved directory under the harness home. */
  readonly saved: string;
}

export const personPlacesOf = (harnessHome: string, person: LinuxIdentity): PersonPlaces => ({
  home: linuxHomeOf(person),
  saved: savedDirOf(harnessHome, person.accountId),
});

// ─── what was delivered before ───────────────────────────────────────────────

/** The records one person's deliveries compare against (`personRecordsExec`). */
export type PersonRecord =
  | "skills-manifest"
  | "skills-digests"
  | "memory-delivered"
  | "secret-files"
  /** Their first-process deliveries ran in this executor (`FIRST_PROCESS_DONE`). */
  | "first-done";

/**
 * The one exec, as the person, that reads what Mend last delivered into their home and saved
 * directory: the skills manifests and the memory record in `P/.mend-saved/`, and the sealed
 * secret-files record in `~/.mend` (never saved). Each is printed as
 * `mend-record <name> <base64>`, or `mend-record <name> -` when it is not a plain file. Folded
 * into one exec so a person's deliveries cost one read, whatever they deliver.
 */
export const personRecordsExec = (
  places: PersonPlaces,
  paths: { readonly memoryDelivered: string },
): ReadonlyArray<string> => {
  const q = shellQuote;
  const records: ReadonlyArray<readonly [PersonRecord, string]> = [
    ["skills-manifest", `${places.saved}/${PERSON_SKILLS_MANIFEST}`],
    ["skills-digests", `${places.saved}/${PERSON_SKILLS_DIGESTS}`],
    ["memory-delivered", `${places.saved}/${paths.memoryDelivered}`],
  ];
  return [
    "sh",
    "-c",
    [
      `out() { if [ -f "$2" ] && [ ! -L "$2" ]; then printf 'mend-record %s ' "$1"; ` +
        `base64 < "$2" | tr -d '\\n'; printf '\\n'; else printf 'mend-record %s -\\n' "$1"; fi; }`,
      ...records.map(([name, file]) => `out ${name} ${q(file)}`),
      // The secret files' record is in the home's own `~/.mend`, read as `secretFilesDeliveredExec`
      // reads it: nothing through a link.
      `if [ -L ${q(`${places.home}/.mend`)} ]; then printf 'mend-record secret-files -\\n'; printf 'mend-record first-done -\\n'; ` +
        `else out secret-files ${q(`${places.home}/.mend/secret-files`)}; out first-done ${q(`${places.home}/.mend/first-process-done`)}; fi`,
      `exit 0`,
    ].join("\n"),
  ];
};

/** What `personRecordsExec` printed: each record's text, null when it is not there. */
export const parsePersonRecords = (stdout: string): ReadonlyMap<PersonRecord, string | null> => {
  const found = new Map<PersonRecord, string | null>();
  for (const line of stdout.split("\n")) {
    const match =
      /^mend-record (skills-manifest|skills-digests|memory-delivered|secret-files|first-done) (\S+)$/.exec(
        line.trim(),
      );
    const name = match?.[1];
    const value = match?.[2];
    if (
      value === undefined ||
      (name !== "skills-manifest" &&
        name !== "skills-digests" &&
        name !== "memory-delivered" &&
        name !== "secret-files" &&
        name !== "first-done")
    ) {
      continue;
    }
    found.set(name, value === "-" ? null : Buffer.from(value, "base64").toString("utf8"));
  }
  return found;
};

// ─── after a person's dotfiles ───────────────────────────────────────────────

/** Every parent directory of the saved state's entries, shallowest first, once each. */
const SAVED_STATE_PARENTS: ReadonlyArray<string> = [
  ...new Set(
    PERSON_SAVED_STATE.flatMap(({ path: entry }) => {
      const parts = entry.split("/").slice(0, -1);
      return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
    }),
  ),
].toSorted((left, right) => left.split("/").length - right.split("/").length);

/** Marks a person's first-process deliveries (dotfiles, shell profile) done in this executor. */
export const FIRST_PROCESS_DONE = ".mend/first-process-done";

/**
 * Mend's links put back over whatever a person's dotfiles put in their place (decision 11: the
 * links win), as the person, in their home, and their first-process deliveries marked done
 * (`FIRST_PROCESS_DONE`). Nothing is deleted and nothing outside their home is written:
 * - a parent directory the dotfiles made a link (a stow-folded `~/.claude`, absolute or relative)
 *   is unfolded: its target is resolved from the link's own directory, the link is recorded aside,
 *   and a real directory holding a copy of what the target had takes its place; the checkout is
 *   only read;
 * - an entry that is a link anywhere but `P` is recorded aside, and Mend's goes in its place;
 * - a real directory is merged into `P` entry by entry: whatever `P` already holds under the same
 *   name stays, and the other copy is moved aside;
 * - a file moves into `P` when `P` has none, else aside.
 * Running it again changes nothing. Prints `mend-links displaced <path>` for each thing moved
 * aside (`ASIDE_FUNCTION`).
 */
export const personLinksScript = (
  person: LinuxIdentity,
  options: { readonly harnessHome: string; readonly home?: string },
): string => {
  assertScriptSafe(person);
  const home = options.home ?? linuxHomeOf(person);
  const saved = savedDirOf(options.harnessHome, person.accountId);
  return [
    `H=${shellQuote(home)}; S=${shellQuote(saved)}`,
    ASIDE_FUNCTION,
    `for p in ${SAVED_STATE_PARENTS.join(" ")}; do if [ -L "$H/$p" ]; then ` +
      `t=$(readlink -f "$H/$p" 2>/dev/null || true); aside "$p" || exit 1; mkdir -p "$H/$p"; ` +
      `if [ -n "$t" ] && [ -d "$t" ]; then cp -a "$t/." "$H/$p/" || exit 1; fi; fi; done`,
    `for e in ${PERSON_SAVED_STATE.map(({ path: entry }) => entry).join(" ")}; do f="$H/$e"; t="$S/$e"; ` +
      `if [ -L "$f" ]; then [ "$(readlink "$f")" = "$t" ] || { aside "$e" && ln -s "$t" "$f"; }; ` +
      `elif [ -d "$f" ]; then mkdir -p "$t"; for c in "$f"/* "$f"/.[!.]* "$f"/..?*; do ` +
      `[ -e "$c" ] || [ -L "$c" ] || continue; n=\${c##*/}; ` +
      `if [ -e "$t/$n" ] || [ -L "$t/$n" ]; then aside "$e/$n"; else mv "$c" "$t/$n"; fi; done; ` +
      `rmdir "$f" && ln -s "$t" "$f"; ` +
      `elif [ -e "$f" ]; then { if [ ! -e "$t" ]; then mkdir -p "$(dirname "$t")" && mv "$f" "$t"; else aside "$e"; fi; } && ln -s "$t" "$f"; ` +
      `else mkdir -p "$(dirname "$f")" && ln -s "$t" "$f"; fi; done`,
    `mkdir -p "$H/.mend" && printf done > "$H/${FIRST_PROCESS_DONE}"`,
    `exit 0`,
  ].join("\n");
};

/** The entries `personLinksScript` moved aside. */
export const parseDisplacedLinks = (stdout: string): ReadonlyArray<string> =>
  stdout.split("\n").flatMap((line) => {
    const match = /^mend-links displaced (.+)$/.exec(line.trim());
    return match?.[1] === undefined ? [] : [match[1]];
  });

// ─── the opencode scrub (decision 8a) ────────────────────────────────────────

/** Where a person's opencode database is, under their home or their saved directory. */
export const opencodeDatabaseOf = (root: string): string => `${root}/${OPENCODE_DATABASE}`;

/**
 * Decision 8a: a login a person made inside opencode stays in their own opencode data, which only
 * their own sessions use, and Mend deletes it when opencode exits, before that person's opencode
 * starts, and at prepare for every restored database. A checkpoint something else's read blocked
 * is a failure, not a scrub: the log would still hold the rows. As the person's user, with `node:sqlite`:
 * every row of `account`, `control_account` and `credential` deleted and every
 * `session_share.secret` nulled (with `secure_delete` on), then `VACUUM` and
 * `PRAGMA wal_checkpoint(TRUNCATE)`, so neither the database nor its write-ahead log keeps a page
 * of what was deleted, then closed. A table opencode does not have is skipped. Argv: the databases.
 * Prints `mend-scrub scrubbed <rows> <file>`, `mend-scrub absent <file>` or
 * `mend-scrub failed <file> <why>` for each; exits 1 after any failure, leaving that database as
 * it is.
 */
export const OPENCODE_SCRUB_PROGRAM = [
  `const fs=require("node:fs");let DatabaseSync;try{({DatabaseSync}=require("node:sqlite"))}catch(e){`,
  `for(const f of process.argv.slice(1))console.log("mend-scrub failed "+f+" this node has no node:sqlite");process.exit(1)}`,
  `let failed=false;`,
  `for(const file of process.argv.slice(1)){`,
  `if(!fs.existsSync(file)){console.log("mend-scrub absent "+file);continue}`,
  `let db=null;try{db=new DatabaseSync(file);db.exec("PRAGMA busy_timeout=2000");db.exec("PRAGMA secure_delete=ON");`,
  `const has=(t)=>db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t)!==undefined;`,
  `let rows=0;db.exec("BEGIN IMMEDIATE");`,
  `for(const t of ["account","control_account","credential"]){if(has(t))rows+=Number(db.prepare("DELETE FROM \\""+t+"\\"").run().changes)}`,
  `if(has("session_share")&&db.prepare("PRAGMA table_info(session_share)").all().some((c)=>c.name==="secret")){`,
  `rows+=Number(db.prepare("UPDATE session_share SET secret=NULL WHERE secret IS NOT NULL").run().changes)}`,
  `db.exec("COMMIT");db.exec("VACUUM");`,
  // The log is emptied only when nothing reads the database: one that is is said, never passed.
  `const cp=db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()||{};`,
  `if(Number(cp.busy)!==0||(Number(cp.log)!==-1&&Number(cp.log)!==Number(cp.checkpointed)))throw new Error("the database is in use, so its write-ahead log still holds what was deleted");`,
  `db.close();db=null;`,
  `console.log("mend-scrub scrubbed "+rows+" "+file)}`,
  `catch(e){failed=true;try{if(db!==null&&db.isTransaction)db.exec("ROLLBACK")}catch{}try{if(db!==null)db.close()}catch{}`,
  `console.log("mend-scrub failed "+file+" "+String((e&&e.message)||e).replace(/\\s+/g," "))}}`,
  `process.exit(failed?1:0)`,
].join("");

/** The exec that scrubs `databases`, run as their person (`OPENCODE_SCRUB_PROGRAM`). */
export const opencodeScrubArgv = (databases: ReadonlyArray<string>): ReadonlyArray<string> => [
  "node",
  "-e",
  OPENCODE_SCRUB_PROGRAM,
  ...databases,
];

/** What one scrub did, per database. */
export interface OpencodeScrubOutcome {
  readonly outcome: "scrubbed" | "absent" | "failed";
  readonly file: string;
  /** Rows deleted or nulled, for `scrubbed`. */
  readonly rows: number;
  /** Why, for `failed`. */
  readonly reason: string | null;
}

export const parseOpencodeScrub = (stdout: string): ReadonlyArray<OpencodeScrubOutcome> =>
  stdout.split("\n").flatMap((line): ReadonlyArray<OpencodeScrubOutcome> => {
    const text = line.trim();
    const scrubbed = /^mend-scrub scrubbed (\d+) (\S+)$/.exec(text);
    if (scrubbed?.[1] !== undefined && scrubbed[2] !== undefined) {
      return [{ outcome: "scrubbed", file: scrubbed[2], rows: Number(scrubbed[1]), reason: null }];
    }
    const absent = /^mend-scrub absent (\S+)$/.exec(text);
    if (absent?.[1] !== undefined) {
      return [{ outcome: "absent", file: absent[1], rows: 0, reason: null }];
    }
    const failed = /^mend-scrub failed (\S+) ?(.*)$/.exec(text);
    if (failed?.[1] !== undefined) {
      return [{ outcome: "failed", file: failed[1], rows: 0, reason: failed[2] || "it failed" }];
    }
    return [];
  });

/** The session line when a scrub failed: the database is left as it is (decision 8a). */
export const opencodeScrubFailedWords = (reason: string): string =>
  `opencode logins not removed · ${reason}`;

// ─── install.sh (decision 11) ────────────────────────────────────────────────

/** How long a person's `dotfiles.apply` may take before it is given up (it is bounded). */
export const DOTFILES_APPLY_BOUND_MS = 120_000;

/**
 * How long an agent waits for its person's `install.sh` when it waits at all (the launcher's, and
 * a joiner who turned on "Start my agents after install.sh"): then it starts anyway, and the line
 * says the script is still running.
 */
export const BOOTSTRAP_WAIT_BOUND_MS = 15 * 60_000;

export const BOOTSTRAP_RUNNING_WORDS = "install.sh running";

/** The line when a joiner's `install.sh` ends after their agent started (decision 11). */
export const bootstrapFinishedLateWords = (exitCode: number | null): string =>
  exitCode === 0 || exitCode === null
    ? "install.sh finished after the agent started"
    : `install.sh finished after the agent started · exit ${exitCode}`;

/** The line when an agent that waited for `install.sh` started before it ended. */
export const BOOTSTRAP_STILL_RUNNING_WORDS =
  "install.sh still running after 15 min · the agent started beside it";

/**
 * Decision 1's fallback for dotfiles, said on the session line: Core's SDK cannot apply a person's
 * dotfiles as them yet (PLATFORM-FEEDBACK.md), so a person launch in a worktree that already runs
 * per person starts without them rather than apply them as anyone else.
 */
export const DOTFILES_NOT_PER_PERSON =
  "this Mend's platform cannot apply dotfiles as each person yet (sealantd's dotfiles.apply through Core), so they were not applied";
