import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { MergeText, StoredMemoryFile } from "@mend/db";
import {
  AGENT_MEMORY_FILES,
  AGENT_MEMORY_ROOTS,
  agentMemoryMaxFileBytes,
  piProfileFileBytes,
  validateAgentMemoryPath,
} from "@mend/domain/workbench";
import { Effect, Schema } from "effect";

import { consolidateCodexDatabase } from "./codex-memory.ts";
import { shellQuote } from "./workspace-files.ts";

/**
 * A person's agent memory for a project (docs/adr/0009-agent-memory-per-person-per-project.md),
 * into and out of a session's harness home. Delivery runs at launch, after the home is relocated;
 * the read-back runs when the agent ends.
 *
 * One program delivers in both stores (`AGENT_MEMORY_DELIVER_PROGRAM`): the stored files are first
 * staged under `.mend/agent-memory-incoming/`, then the program puts each in place unless the
 * session changed it since the last delivery, moves aside (never deletes) a file Mend delivered and
 * no longer stores, and records what it delivered in `AGENT_MEMORY_DELIVERED` and whose memory
 * it is in `AGENT_MEMORY_OWNER`. The read-back compares against that record.
 */

/** What was delivered, path to digest, relative to the harness home. */
export const AGENT_MEMORY_DELIVERED = ".mend/agent-memory-delivered.json";

/**
 * Whose memory the harness home holds, as the last delivery or hand-over wrote it, relative to the
 * harness home. Never what Mend credits: anything running in the executor can write it. The
 * server decides whose memory an executor holds (the person whose launch made it); this record
 * only withholds. A read-back or hand-over that finds it naming someone else credits nobody.
 */
export const AGENT_MEMORY_OWNER = ".mend/agent-memory-owner";

/**
 * Everything of one person's memory in a harness home, relative to it: the memory roots, Codex's
 * summary database with its write-ahead log and shared memory, the delivered record and the owner
 * record. A hand-over moves all of it aside before another person's memory is laid down.
 */
export const AGENT_MEMORY_HANDOVER_PATHS: ReadonlyArray<string> = [
  ...AGENT_MEMORY_ROOTS.map(({ root }) => root),
  ...AGENT_MEMORY_FILES.flatMap(({ path: file }) => [file, `${file}-wal`, `${file}-shm`]),
  AGENT_MEMORY_DELIVERED,
  AGENT_MEMORY_OWNER,
];

/**
 * The exec that hands a capture-mode harness home over to `owner` (plain `sh`, no node): each of
 * `AGENT_MEMORY_HANDOVER_PATHS` that is there moves to `kept` (relative to the home), never
 * deleted, and the owner record then names `owner`. Prints `memory moved <path>` per path. Exits
 * non-zero the moment a path cannot be moved: the launch must not start on another person's
 * memory.
 */
export const handOverAgentMemoryExec = (
  home: string,
  kept: string,
  owner: string,
): ReadonlyArray<string> => [
  "sh",
  "-c",
  [
    `home=${shellQuote(home)}; kept="$home"/${shellQuote(kept)};`,
    `for p in ${AGENT_MEMORY_HANDOVER_PATHS.map(shellQuote).join(" ")}; do`,
    `if [ -e "$home/$p" ] || [ -L "$home/$p" ]; then`,
    `mkdir -p "$kept/$(dirname "$p")" && mv "$home/$p" "$kept/$p" || exit 1; echo "memory moved $p"; fi; done;`,
    `mkdir -p "$home/.mend" && printf %s ${shellQuote(owner)} > "$home"/${shellQuote(AGENT_MEMORY_OWNER)}`,
  ].join(" "),
];

/** A fresh kept directory for one hand-over, relative to the harness home. */
export const agentMemoryHandoverKeptDir = (now: Date = new Date()): string =>
  path.posix.join(
    AGENT_MEMORY_KEPT_DIR,
    `${now.toISOString().replace(/[:.]/g, "-")}-handover-${randomUUID().slice(0, 8)}`,
  );

/** Where the stored files wait for the program, relative to the harness home. */
const AGENT_MEMORY_INCOMING = ".mend/agent-memory-incoming";

/** Where a delivered file Mend no longer stores goes, relative to the harness home. */
export const AGENT_MEMORY_KEPT_DIR = ".mend/agent-memory-kept";

export class AgentMemoryDeliveryError extends Schema.TaggedErrorClass<AgentMemoryDeliveryError>()(
  "AgentMemoryDeliveryError",
  { message: Schema.String },
) {}

type MemoryFile = {
  readonly path: string;
  readonly encoding: "utf8" | "base64";
  readonly contents: string;
};

/**
 * Puts the staged memory in place (`node -e`, argv: home, the incoming directory and a fresh kept
 * directory relative to it, the stored files as `[{path, digest}]` JSON, and the account they are
 * for, written to `AGENT_MEMORY_OWNER` before any file moves; "" writes none). Prints one
 * `memory <outcome> <path>` line per file: `written`, `unchanged` (already exactly the stored
 * file), `left` (the session changed it since the last delivery and Mend has not read it back),
 * `kept` (Mend no longer stores it; moved aside) or `error`. Exits 1 after any `error`.
 */
export const AGENT_MEMORY_DELIVER_PROGRAM = [
  `const fs=require("fs"),path=require("path"),crypto=require("crypto");`,
  `const [home,incoming,kept,list,owner]=process.argv.slice(1),store=JSON.parse(list);`,
  `const M=path.join(home,${JSON.stringify(AGENT_MEMORY_DELIVERED)});`,
  `if(owner){const O=path.join(home,${JSON.stringify(AGENT_MEMORY_OWNER)});fs.mkdirSync(path.dirname(O),{recursive:true});fs.writeFileSync(O,owner)}`,
  `let before={};try{const v=JSON.parse(fs.readFileSync(M,"utf8"));if(v&&typeof v==="object")before=v}catch{}`,
  `const sha=b=>crypto.createHash("sha256").update(b).digest("hex");`,
  `const digestOf=p=>{try{const st=fs.lstatSync(p);if(!st.isFile())return "not-a-file";return sha(fs.readFileSync(p))}catch(e){if(e.code==="ENOENT")return null;throw e}};`,
  `const say=(o,p)=>process.stdout.write("memory "+o+" "+p+"\\n");const after={};let failed=false;`,
  `for(const f of store){const to=path.join(home,f.path);try{const have=digestOf(to);`,
  `if(have===f.digest){after[f.path]=f.digest;say("unchanged",f.path);continue}`,
  `if(have!==null&&have!==before[f.path]){if(before[f.path])after[f.path]=before[f.path];say("left",f.path);continue}`,
  `fs.mkdirSync(path.dirname(to),{recursive:true});const t=to+".mend-"+process.pid;`,
  `fs.copyFileSync(path.join(home,incoming,f.path),t);fs.renameSync(t,to);after[f.path]=f.digest;say("written",f.path)}`,
  `catch{failed=true;say("error",f.path)}}`,
  `const now=new Set(store.map(f=>f.path));`,
  `for(const [p,d] of Object.entries(before)){if(now.has(p))continue;const at=path.join(home,p);try{const have=digestOf(at);`,
  `if(have===null)continue;if(have!==d){say("left",p);continue}`,
  `const to=path.join(home,kept,p);fs.mkdirSync(path.dirname(to),{recursive:true});fs.renameSync(at,to);say("kept",p)}`,
  `catch{failed=true;say("error",p)}}`,
  `fs.mkdirSync(path.dirname(M),{recursive:true});fs.writeFileSync(M,JSON.stringify(after,null,2));`,
  `fs.rmSync(path.join(home,incoming),{recursive:true,force:true});process.exit(failed?1:0)`,
].join("");

/** What the program did with one file. */
export interface AgentMemoryOutcome {
  readonly outcome: "written" | "unchanged" | "left" | "kept" | "error";
  readonly path: string;
}

export const parseAgentMemoryOutcomes = (stdout: string): ReadonlyArray<AgentMemoryOutcome> =>
  stdout.split("\n").flatMap((line): ReadonlyArray<AgentMemoryOutcome> => {
    const match = /^memory (written|unchanged|left|kept|error) (.+)$/.exec(line);
    const outcome = match?.[1];
    if (
      outcome !== "written" &&
      outcome !== "unchanged" &&
      outcome !== "left" &&
      outcome !== "kept" &&
      outcome !== "error"
    ) {
      return [];
    }
    return [{ outcome, path: match?.[2] ?? "" }];
  });

/** One delivery: the files to stage, relative to the harness home, and the program's input. */
export interface AgentMemoryPlan {
  readonly staged: ReadonlyArray<{ readonly path: string; readonly bytes: Uint8Array }>;
  readonly list: string;
  readonly kept: string;
}

/** The plan for the stored memory; a path that fails validation is left out. */
export const planAgentMemory = (
  stored: ReadonlyArray<StoredMemoryFile>,
  now: Date = new Date(),
): AgentMemoryPlan => {
  const files = stored.flatMap((file) => {
    const bytes = piProfileFileBytes(file);
    return bytes === null || validateAgentMemoryPath(file.path) !== null ? [] : [{ file, bytes }];
  });
  return {
    staged: files.map(({ file, bytes }) => ({
      path: path.posix.join(AGENT_MEMORY_INCOMING, file.path),
      bytes,
    })),
    list: JSON.stringify(files.map(({ file }) => ({ path: file.path, digest: file.digest }))),
    kept: path.posix.join(
      AGENT_MEMORY_KEPT_DIR,
      `${now.toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`,
    ),
  };
};

/**
 * The exec that delivers `plan`, `owner`'s memory, into a workspace's harness home, once its files
 * are staged.
 */
export const deliverAgentMemoryExec = (
  home: string,
  plan: AgentMemoryPlan,
  owner: string,
): ReadonlyArray<string> => [
  "sh",
  "-c",
  `exec node -e ${shellQuote(AGENT_MEMORY_DELIVER_PROGRAM)} "$1" "$2" "$3" "$4" "$5"`,
  "mend-agent-memory",
  home,
  AGENT_MEMORY_INCOMING,
  plan.kept,
  plan.list,
  owner,
];

/** Deliver into a harness home on this machine: the co-located store's mounted home. */
export const materializeAgentMemory = (
  harnessHomePath: string,
  plan: AgentMemoryPlan,
  owner: string,
): Effect.Effect<ReadonlyArray<AgentMemoryOutcome>, AgentMemoryDeliveryError> =>
  Effect.tryPromise({
    try: async () => {
      // A harness home that was never made was never mounted: nothing here would reach the agent.
      await fs.access(harnessHomePath);
      for (const file of plan.staged) {
        const target = path.join(harnessHomePath, file.path);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, file.bytes, { mode: 0o644 });
      }
      const delivered = spawnSync(
        process.execPath,
        [
          "-e",
          AGENT_MEMORY_DELIVER_PROGRAM,
          harnessHomePath,
          AGENT_MEMORY_INCOMING,
          plan.kept,
          plan.list,
          owner,
        ],
        { encoding: "utf8" },
      );
      const outcomes = parseAgentMemoryOutcomes(delivered.stdout ?? "");
      if (delivered.status !== 0) {
        throw new Error(`exit ${delivered.status}: ${delivered.stderr ?? ""}`);
      }
      return outcomes;
    },
    catch: (error) =>
      new AgentMemoryDeliveryError({
        message: `agent memory could not be written into the harness home: ${String(error)}`,
      }),
  });

/** The delivered record's contents; anything unreadable is "nothing was delivered". */
export const parseAgentMemoryDelivered = (raw: string | null): Readonly<Record<string, string>> => {
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === "string" && validateAgentMemoryPath(entry[0]) === null,
      ),
    );
  } catch {
    return {};
  }
};

/**
 * What a home's owner record says (`AGENT_MEMORY_OWNER`): nothing (absent or empty), an account,
 * or that it could not be read, which is never taken as "absent".
 */
export type AgentMemoryOwnerRecord =
  | { readonly kind: "absent" }
  | { readonly kind: "named"; readonly userId: string }
  | { readonly kind: "unreadable" };

export const parseAgentMemoryOwner = (raw: string | null): AgentMemoryOwnerRecord => {
  const owner = raw?.trim() ?? "";
  return owner === "" ? { kind: "absent" } : { kind: "named", userId: owner };
};

/** Whether the owner record leaves `userId` as the home's owner: absent, or naming them. */
export const ownerRecordAllows = (record: AgentMemoryOwnerRecord, userId: string): boolean =>
  record.kind === "absent" || (record.kind === "named" && record.userId === userId);

/** A file's bytes as a stored memory file: text when it is UTF-8 without NULs. */
export const asMemoryFile = (filePath: string, bytes: Uint8Array): MemoryFile => {
  if (!bytes.includes(0)) {
    try {
      return {
        path: filePath,
        encoding: "utf8",
        contents: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      };
    } catch {
      // Not UTF-8: base64.
    }
  }
  return { path: filePath, encoding: "base64", contents: Buffer.from(bytes).toString("base64") };
};

/**
 * What a read-back found: the files, what was delivered and for whom, and the paths that are there
 * but were not read (over the limit, or a database that did not open). A skipped path is not a
 * deleted one: `withoutSkipped` takes it out of `delivered`, so the stored file stays.
 */
export interface AgentMemoryRead {
  readonly delivered: Readonly<Record<string, string>>;
  /** What the home's owner record says (`AGENT_MEMORY_OWNER`); never what Mend credits. */
  readonly owner: AgentMemoryOwnerRecord;
  readonly files: ReadonlyArray<MemoryFile>;
  readonly skipped: ReadonlyArray<string>;
}

/** `delivered` without the paths a read-back found and could not read. */
export const withoutSkipped = (read: AgentMemoryRead): Readonly<Record<string, string>> =>
  Object.fromEntries(
    Object.entries(read.delivered).filter(([filePath]) => !read.skipped.includes(filePath)),
  );

/**
 * The memory in a harness home on this machine, and what was delivered there: the co-located
 * read-back. Links are not read; anything over the per-file limit is skipped.
 */
export const readAgentMemoryFromHome = (harnessHomePath: string): Effect.Effect<AgentMemoryRead> =>
  Effect.promise(async () => {
    const files: Array<MemoryFile> = [];
    const skipped: Array<string> = [];
    const walk = async (relative: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(path.join(harnessHomePath, relative), { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const at = path.posix.join(relative, entry.name);
        if (entry.isDirectory()) await walk(at);
        else if (entry.isFile()) {
          const abs = path.join(harnessHomePath, at);
          const stat = await fs.stat(abs);
          if (stat.size > agentMemoryMaxFileBytes(at)) {
            skipped.push(at);
            continue;
          }
          files.push(asMemoryFile(at, await fs.readFile(abs)));
        }
      }
    };
    for (const { root } of AGENT_MEMORY_ROOTS) await walk(root);
    for (const { path: file } of AGENT_MEMORY_FILES) {
      const abs = path.join(harnessHomePath, file);
      const stat = await fs.lstat(abs).catch(() => null);
      if (stat === null || !stat.isFile()) continue;
      if (stat.size > agentMemoryMaxFileBytes(file)) {
        skipped.push(file);
        continue;
      }
      // A SQLite file is read with its write-ahead log and stored as one consolidated file.
      const wal = await fs.readFile(`${abs}-wal`).catch(() => null);
      const consolidated = await Effect.runPromise(
        consolidateCodexDatabase(await fs.readFile(abs), wal),
      );
      if (consolidated === null || consolidated.byteLength > agentMemoryMaxFileBytes(file)) {
        skipped.push(file);
        continue;
      }
      files.push(asMemoryFile(file, consolidated));
    }
    const delivered = await fs
      .readFile(path.join(harnessHomePath, AGENT_MEMORY_DELIVERED), "utf8")
      .then(
        (raw) => raw,
        () => null,
      );
    const owner: AgentMemoryOwnerRecord = await fs
      .readFile(path.join(harnessHomePath, AGENT_MEMORY_OWNER), "utf8")
      .then(parseAgentMemoryOwner, (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "ENOENT"
          ? { kind: "absent" as const }
          : { kind: "unreadable" as const },
      );
    return {
      delivered: parseAgentMemoryDelivered(delivered),
      owner,
      files,
      skipped,
    };
  });

/**
 * Three versions of a text file merged as `git merge-file --union` does: both sides' changes, with
 * no conflict markers. The input never reaches a shell; it goes through temporary files.
 */
export const mergeTextUnion: MergeText = ({ base, ours, theirs }) =>
  Effect.promise(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mend-memory-merge-"));
    try {
      const write = (name: string, text: string) => fs.writeFile(path.join(dir, name), text);
      await Promise.all([write("ours", ours), write("base", base), write("theirs", theirs)]);
      const merged = spawnSync("git", ["merge-file", "-p", "--union", "ours", "base", "theirs"], {
        cwd: dir,
        encoding: "utf8",
      });
      // Exit status is the number of conflicts; --union leaves none. Anything else: keep both.
      return merged.error === undefined && merged.status !== null && merged.status < 128
        ? merged.stdout
        : `${ours}${ours.endsWith("\n") ? "" : "\n"}${theirs}`;
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
