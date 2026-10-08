/**
 * Executors started before per-person homes, and the migration of the shared home they wrote
 * (docs/adr/0016-per-person-harness-homes.md, decision 14, Delivery 19): the parts that need no
 * engine. Whom an old shared home's memory is credited to, what a re-run still has to credit,
 * what would stop if a retiring executor were replaced now, and the check Mend runs in it before
 * it replaces it on its own. Reached only behind `MEND_HARNESS_LAYOUT=person` or a worktree
 * already per person.
 */
import { createHash } from "node:crypto";

import type { RetirementStopRecord } from "@mend/db";
import type { SessionProcess } from "@mend/domain/workbench";

// ─── the migration of an old shared home (memory) ──────────────────────────

/** Whose memory an old shared home holds, and what decided it. */
export interface MemoryCreditor {
  readonly creditedTo: string | null;
  readonly decidedBy: "home-record" | "only-person" | "nobody";
}

/**
 * Whom the memory of a worktree's old shared home goes to (decision 14): the person the saved
 * `agent_memory_homes` record names; else, when every session the worktree had was one person's,
 * that person; else nobody, and it is listed on the worktree as not credited. A person who is no
 * longer a member of the project's organization is credited nothing, and a record naming one is
 * not handed to anyone else.
 */
export const memoryCreditorOf = (input: {
  /** The saved record's person: undefined with no record, null when it names nobody. */
  readonly homeRecord: string | null | undefined;
  /**
   * A record exists that the server's own read-backs would not take: a hand-over pending, or a
   * settled home of another executor than the one that wrote the capture. Then nobody.
   */
  readonly unsettledRecord?: boolean;
  /** The owner of every session the worktree ever had; null for one with no owner. */
  readonly owners: ReadonlyArray<string | null>;
  /** The owners are every session's, deleted ones included; false: the rule cannot apply. */
  readonly ownersComplete?: boolean;
  readonly isMember: (userId: string) => boolean;
}): MemoryCreditor => {
  if (input.unsettledRecord === true) return { creditedTo: null, decidedBy: "nobody" };
  if (typeof input.homeRecord === "string") {
    return input.isMember(input.homeRecord)
      ? { creditedTo: input.homeRecord, decidedBy: "home-record" }
      : { creditedTo: null, decidedBy: "nobody" };
  }
  const people = new Set(input.owners);
  const [only] = [...people];
  if (
    input.ownersComplete !== false &&
    people.size === 1 &&
    typeof only === "string" &&
    input.isMember(only)
  ) {
    return { creditedTo: only, decidedBy: "only-person" };
  }
  return { creditedTo: null, decidedBy: "nobody" };
};

/** One memory file read from a capture, with its digest. */
export interface DigestedMemoryFile {
  readonly path: string;
  readonly digest: string;
}

/**
 * What a run of the migration credits (decision 14, "a re-run credits only what the earlier run
 * did not"): the files whose digest no earlier run credited, each read back against the digest
 * an earlier run credited for its path, else what the old home's own record says was delivered
 * there. Nothing is ever deleted from the store by a migration: only the files read are planned.
 * `credited` is what the record holds once this run's files are credited.
 */
export const memoryToCredit = <F extends DigestedMemoryFile>(input: {
  readonly files: ReadonlyArray<F>;
  /** Every path and digest an earlier run credited. */
  readonly credited: Readonly<Record<string, string>>;
  /** The old home's own record of what was delivered into it (path to digest). */
  readonly homeDelivered: Readonly<Record<string, string>>;
}): {
  readonly fresh: ReadonlyArray<F>;
  readonly base: Readonly<Record<string, string>>;
  readonly credited: Readonly<Record<string, string>>;
} => {
  const fresh = input.files.filter((file) => input.credited[file.path] !== file.digest);
  const base: Record<string, string> = {};
  for (const file of fresh) {
    const earlier = input.credited[file.path] ?? input.homeDelivered[file.path];
    if (earlier !== undefined) base[file.path] = earlier;
  }
  const credited: Record<string, string> = { ...input.credited };
  for (const file of input.files) credited[file.path] = file.digest;
  return { fresh, base, credited };
};

/** The read-back's session id for a migration: never a session's own, so no merge mistakes it. */
export const migrationSessionIdOf = (worktreeId: string): string => `pre-release:${worktreeId}`;

/** What the worktree says of memory credited to nobody. */
export const NOT_CREDITED_WORDS = "memory from before 0.36, not credited";

// ─── the replacement of a pre-release executor ─────────────────────────────

/**
 * A join or a turn from anyone but the executor's launcher, while the worktree's next launch
 * would be `person` and its shared executor still runs (decision 14).
 */
export const retirementRefusalOf = (preRelease: boolean): string =>
  preRelease
    ? "This worktree's workspace started before Mend 0.36 and shares one home; it takes another person once it is replaced."
    : "This worktree's workspace shares one home; it takes another person once it is replaced.";

/** Any new start while Mend checks the executor, flushes it and replaces it. */
export const RETIRING_REFUSAL =
  "This worktree's workspace is being replaced so that each person runs as themselves. Nothing was started; start again once it has been replaced.";

/** "Replace this workspace now" from anyone but the change's owner. */
export const REPLACE_NOT_OWNER = "Only the change's owner replaces this worktree's workspace.";

/** "Replace this workspace now" with nothing to replace. */
export const REPLACE_NOT_MARKED = "This session's workspace is not waiting to be replaced.";

/** "Replace this workspace now" while an agent's turn runs: never stopped under work. */
export const REPLACE_TURN_RUNNING =
  "An agent's turn or background work is in flight in this workspace. Replace it once that has finished.";

/**
 * An opencode conversation from a 0.36 prerelease, resumed in a person executor (decision 14):
 * opencode keeps its conversations in one database, which the person layout never opens for
 * anyone, and no released Mend could resume it, so nothing is copied.
 */
export const OPENCODE_PRE_RELEASE_REFUSAL =
  "This opencode conversation was saved in a workspace that shared one home, and it cannot be carried into your own opencode data. It could be resumed only in that workspace, which has ended. Start a new opencode session.";

/**
 * Whether an opencode conversation a person launch resumes was last held by a process that ran as
 * nobody's user, in another executor: one that shared one home, whose database the person layout
 * never opens (decision 14).
 */
export const opencodeFromSharedHomeOf = (
  rows: ReadonlyArray<
    Pick<SessionProcess, "providerSessionId" | "sealantWorkspaceId" | "runsAs" | "createdAt">
  >,
  workspaceId: string,
  resumeId: string,
): boolean => {
  const latest = rows
    .filter((row) => row.providerSessionId === resumeId)
    .toSorted((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0];
  return (
    latest !== undefined && latest.sealantWorkspaceId !== workspaceId && latest.runsAs === null
  );
};

/** A Service started by hand stops for good with the executor; a `mend.toml` one restarts. */
const HAND_STARTED: ReadonlySet<string> = new Set([
  "explicit-run",
  "explicit-adopt",
  "legacy-unknown",
]);

/**
 * What would stop if the executor were replaced now, from what Mend recorded of it (decision 14):
 * terminal agents (they end resumable), shells, Services started by hand, and protocol agents with
 * a turn or background work in flight. A protocol agent that is quiescent, and a `mend.toml`
 * Service (it restarts), stop nothing anyone would miss.
 */
export const retirementStopsOf = (input: {
  /** The executor's live process rows. */
  readonly processes: ReadonlyArray<SessionProcess>;
  /** The Services those rows belong to, by id. */
  readonly services: ReadonlyMap<
    string,
    { readonly name: string; readonly declarationSource: string }
  >;
  /** A session's name as the owner reads it. */
  readonly sessionLabel: (sessionId: string) => string;
  /** A protocol agent is quiescent; null when Mend cannot tell (counts as in flight). */
  readonly quiescent: (processId: string) => boolean | null;
}): ReadonlyArray<RetirementStopRecord> => {
  const stops: Array<RetirementStopRecord> = [];
  for (const process of input.processes) {
    const session = input.sessionLabel(process.sessionId);
    switch (process.kind) {
      case "agent-pty":
      case "agent-external":
        stops.push({ kind: "terminal", label: `${session} · ${process.harness ?? "agent"}` });
        break;
      case "shell":
        stops.push({ kind: "shell", label: `${session} · ${process.label ?? "shell"}` });
        break;
      case "service": {
        const service = process.serviceId === null ? null : input.services.get(process.serviceId);
        if (service === null || service === undefined) {
          stops.push({ kind: "service", label: `${session} · ${process.label ?? "Service"}` });
        } else if (HAND_STARTED.has(service.declarationSource)) {
          stops.push({ kind: "service", label: `${session} · ${service.name}` });
        }
        break;
      }
      case "agent-protocol":
        if (input.quiescent(process.id) !== true) {
          stops.push({ kind: "turn", label: `${session} · ${process.harness ?? "agent"}` });
        }
        break;
    }
  }
  return stops;
};

/** Stops that hold an automatic replacement back; any one of them does. */
export const holdsReplacement = (stops: ReadonlyArray<RetirementStopRecord>): boolean =>
  stops.length > 0;

/** Stops that refuse even "Replace this workspace now": work in flight is never stopped. */
export const refusesManualReplacement = (stops: ReadonlyArray<RetirementStopRecord>): boolean =>
  stops.some((stop) => stop.kind === "turn");

const STOP_NOUNS: Readonly<Record<RetirementStopRecord["kind"], readonly [string, string]>> = {
  terminal: ["terminal session", "terminal sessions"],
  shell: ["shell", "shells"],
  service: ["Service started by hand", "Services started by hand"],
  turn: ["agent turn in flight", "agent turns in flight"],
  process: ["process Mend did not start", "processes Mend did not start"],
  container: ["running container", "running containers"],
  unchecked: ["thing Mend could not check", "things Mend could not check"],
};

/**
 * Why an automatic replacement did not go ahead, as observed: "not replaced · 1 shell, 2
 * processes Mend did not start". Evidence, never a verdict.
 */
export const notReplacedWords = (stops: ReadonlyArray<RetirementStopRecord>): string => {
  const counts = new Map<RetirementStopRecord["kind"], number>();
  for (const stop of stops) counts.set(stop.kind, (counts.get(stop.kind) ?? 0) + 1);
  const parts = [...counts].map(([kind, count]) => {
    const [one, many] = STOP_NOUNS[kind];
    return `${count} ${count === 1 ? one : many}`;
  });
  return `not replaced · ${parts.join(", ")}`;
};

/** What a line of the retire check says (`retireCheckScript`). */
export const RETIRE_LINE = "mend-retire";

/**
 * The check Mend runs in a pre-release executor, as root, before it replaces it (decision 14).
 *
 * **Processes.** A process counts as Mend's only when it is in the session (`setsid`) of a process
 * Mend recorded and is still running there: the pids sealantd reported when it started them
 * (`processStarted` in each process's record, `known`), or sealantd's own (PID 1's session).
 * Everything else is listed: sealantd is PID 1 and adopts every orphan, so parentage says nothing.
 * A `nohup` job left by a shell that has ended, a `setsid` or `tmux new -d` job, a daemon, a
 * `docker exec`: all are in sessions no live recorded process leads. Kernel threads and the
 * check's own session are not listed. A process is named by its command name and pid only (never
 * its arguments, which can hold a secret).
 *
 * **Containers.** When the executor has a Docker sidecar (the image's `services.docker`, or a
 * `DOCKER_HOST` in sealantd's own environment, which is the container's), `docker ps` must answer:
 * no `docker` command, no daemon address, a refusal or a timeout each prints
 * `mend-retire unknown <why>`, which holds an automatic replacement and tells the owner why. It
 * never reads as "no containers".
 *
 * One line per finding (`mend-retire process <pid> <name>`, `mend-retire container <name>
 * (<image>)`, `mend-retire unknown <why>`), then `mend-retire checked`. It changes nothing.
 */
export const retireCheckScript = (options: {
  /** Pids sealantd reported for the executor's live recorded processes. */
  readonly known: ReadonlyArray<number>;
  /** The executor has a Docker sidecar, as its image says. */
  readonly docker: boolean;
  readonly proc?: string;
  /** The `docker` command to run (a test's stand-in); `docker` on PATH otherwise. */
  readonly dockerCommand?: string;
  /** The daemon socket looked for without a `DOCKER_HOST`; `/var/run/docker.sock` otherwise. */
  readonly dockerSocket?: string;
  /** How long `docker ps` may take; 20 s otherwise. */
  readonly dockerTimeoutSeconds?: number;
}): string => {
  const proc = options.proc ?? "/proc";
  const known = options.known.filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  const docker = shellQuoteSafe(options.dockerCommand ?? "docker");
  const socket = shellQuoteSafe(options.dockerSocket ?? "/var/run/docker.sock");
  const socketUrl = `unix://${(options.dockerSocket ?? "/var/run/docker.sock").replace(/[^A-Za-z0-9._/-]/g, "")}`;
  const seconds = Math.max(1, Math.floor(options.dockerTimeoutSeconds ?? 20));
  return [
    `P=${shellQuoteSafe(proc)}`,
    // The session id: field 6 of stat, counted after the command name's closing parenthesis.
    `sid_of() { sed 's/^.*) //' "$P/$1/stat" 2>/dev/null | awk '{ print $4 }'; }`,
    `self=$(sid_of $$)`,
    `known=" $(sid_of 1) "`,
    `for k in ${known.join(" ")}; do s=$(sid_of "$k"); [ -n "$s" ] && known="$known$s "; done`,
    `for p in "$P"/[0-9]*; do`,
    `  pid=\${p##*/}; [ "$pid" = 1 ] && continue`,
    `  [ -s "$p/cmdline" ] || continue`,
    `  s=$(sid_of "$pid"); [ -n "$s" ] || continue`,
    `  [ "$s" = "$self" ] && continue`,
    `  case "$known" in *" $s "*) continue ;; esac`,
    `  c=$(tr -d '\\n' < "$p/comm" 2>/dev/null | tr -c 'A-Za-z0-9._+-' '_' | cut -c1-32)`,
    `  printf '%s process %s %s\\n' ${RETIRE_LINE} "$pid" "\${c:-unknown}"`,
    `done`,
    `unknown() { printf '%s unknown %s\\n' ${RETIRE_LINE} "$1"; }`,
    `dh=$(tr '\\0' '\\n' < "$P/1/environ" 2>/dev/null | sed -n 's/^DOCKER_HOST=//p' | head -n 1)`,
    `if [ ${options.docker ? "1" : "0"} = 1 ] || [ -n "$dh" ]; then`,
    `  if ! command -v ${docker} >/dev/null 2>&1; then unknown "running containers: no docker command in this image";`,
    `  elif [ -z "$dh" ] && [ ! -S ${socket} ]; then unknown "running containers: no Docker daemon address (DOCKER_HOST)";`,
    `  else`,
    `    t=; command -v timeout >/dev/null 2>&1 && t="timeout ${seconds}"`,
    `    out=$(DOCKER_HOST="\${dh:-${socketUrl}}" $t ${docker} ps --format '{{.Names}} ({{.Image}})' 2>&1); st=$?`,
    `    if [ "$st" != 0 ]; then unknown "running containers: docker ps failed ($(printf '%s' "$out" | tail -n 1 | tr -c 'A-Za-z0-9 .:/_()-' ' ' | cut -c1-120))";`,
    `    else printf '%s\\n' "$out" | while IFS= read -r line; do [ -n "$line" ] && printf '%s container %s\\n' ${RETIRE_LINE} "$line"; done; fi`,
    `  fi`,
    `fi`,
    `printf '%s checked\\n' ${RETIRE_LINE}`,
  ].join("\n");
};

/** A path that goes into the script as is: the tests' temporary directories and `/proc`. */
const shellQuoteSafe = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * What the retire check found. `checked` false when it did not run to its end: then nothing it
 * would have found is known, and an automatic replacement does not go ahead.
 */
export const parseRetireCheck = (
  stdout: string,
): { readonly checked: boolean; readonly stops: ReadonlyArray<RetirementStopRecord> } => {
  let checked = false;
  const stops: Array<RetirementStopRecord> = [];
  for (const line of stdout.split("\n")) {
    if (!line.startsWith(`${RETIRE_LINE} `)) continue;
    const rest = line.slice(RETIRE_LINE.length + 1).trim();
    if (rest === "checked") checked = true;
    else if (rest.startsWith("process ")) {
      const [pid, ...name] = rest.slice("process ".length).trim().split(" ");
      stops.push({ kind: "process", label: `${name.join(" ") || "unknown"} (pid ${pid ?? "?"})` });
    } else if (rest.startsWith("container ")) {
      stops.push({ kind: "container", label: rest.slice("container ".length).trim() });
    } else if (rest.startsWith("unknown ")) {
      stops.push({ kind: "unchecked", label: rest.slice("unknown ".length).trim() });
    }
  }
  return { checked, stops };
};

/** Why a check found nothing it could read: one `unchecked` stop. */
export const uncheckedStop = (why: string): RetirementStopRecord => ({
  kind: "unchecked",
  label: why,
});

/**
 * One token for what a viewer was shown: the stops, in order, and when they were checked. The
 * owner's "Replace this workspace now" names it, and Mend ends nothing that was not listed.
 */
export const retirementFingerprintOf = (input: {
  readonly stops: ReadonlyArray<RetirementStopRecord>;
  readonly checkedAt: Date | null;
}): string =>
  createHash("sha256")
    .update(
      JSON.stringify([
        input.checkedAt?.toISOString() ?? null,
        input.stops.map((stop) => [stop.kind, stop.label]),
      ]),
    )
    .digest("base64url")
    .slice(0, 22);

/**
 * Whether everything that would stop now was among what the owner was shown: a replacement goes
 * ahead only then. A process is the same one only by its pid and name.
 */
export const stopsWithin = (
  now: ReadonlyArray<RetirementStopRecord>,
  shown: ReadonlyArray<RetirementStopRecord>,
): boolean =>
  now.every((stop) => shown.some((seen) => seen.kind === stop.kind && seen.label === stop.label));

/** "Replace this workspace now" after what would stop changed since the owner looked. */
export const REPLACE_STOPS_CHANGED =
  "What would stop has changed since you looked. Nothing was stopped; look at the list again and replace it from there.";

/** A process or container's label is the change's owner's to read: everyone else sees its kind. */
export const stopsForViewer = (
  stops: ReadonlyArray<RetirementStopRecord>,
  isOwner: boolean,
): ReadonlyArray<RetirementStopRecord> =>
  isOwner
    ? stops
    : stops.map((stop) =>
        stop.kind === "process" || stop.kind === "container" ? { ...stop, label: "" } : stop,
      );
