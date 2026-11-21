import { currentAgentProcess, isLiveProcess, type SessionProcess } from "@mend/domain/workbench";
import { Schema } from "effect";

/**
 * Going back to a checkpoint (SLNT-1259), the part that runs in the workspace. It puts the
 * worktree's files back to the checkpoint's tree: every file Git tracks and every untracked file
 * that isn't ignored. A file the checkpoint doesn't have is removed; an ignored file is left
 * alone, because a checkpoint never saved it. Git's own `checkout-index` writes the files, so the
 * repository's filters and line endings apply as they do on a checkout. The branch, its commits
 * and HEAD don't move; staging goes back to HEAD. Nothing changes until every object the tree
 * needs is known to be here. The engine saves a checkpoint of the files first, so this is undone
 * by going back to that one.
 */
const PROGRAM = String.raw`
const cp = require("node:child_process"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const input = JSON.parse(process.argv[1]);
const repo = fs.realpathSync(input.repository);
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
const git = (args, extra = {}, stdin) => cp.execFileSync("git", args, {cwd: repo, env: {...env, ...extra}, input: stdin, maxBuffer: 1024 * 1024 * 1024});
const list = b => b.toString("utf8").split("\0").filter(Boolean);
const fail = m => { throw new Error(m); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mend-restore-"));
try {
 if (!/^[0-9a-f]{40,64}$/.test(input.commit)) fail("The checkpoint's commit is not a Git object id.");
 if (input.pack !== null) git(["index-pack", "--stdin"], {}, fs.readFileSync(input.pack));
 let tree;
 try { tree = git(["rev-parse", "--verify", input.commit + "^{tree}"]).toString("utf8").trim(); }
 catch { fail("This workspace doesn't have the checkpoint's files."); }
 const at = {GIT_INDEX_FILE: path.join(dir, "index")};
 git(["read-tree", tree], at);
 const entries = list(git(["ls-files", "-s", "-z"], at)).map(line => {
  const tab = line.indexOf("\t"), [mode, oid] = line.slice(0, tab).split(" ");
  return {mode, oid, path: line.slice(tab + 1)};
 });
 const blobs = entries.filter(e => e.mode !== "160000").map(e => e.oid);
 if (blobs.length > 0) {
  const seen = git(["cat-file", "--batch-check"], {}, Buffer.from(blobs.join("\n") + "\n")).toString("utf8");
  if (/ missing$/m.test(seen)) fail("This workspace doesn't have every file of the checkpoint.");
 }
 const wanted = new Set(entries.map(e => e.path));
 const present = list(git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]));
 let removed = 0;
 for (const p of present) {
  if (wanted.has(p)) continue;
  const full = path.join(repo, p);
  let st;
  try { st = fs.lstatSync(full); } catch (e) { if (e.code === "ENOENT") continue; throw e; }
  if (st.isDirectory()) continue;
  fs.unlinkSync(full);
  removed++;
  for (let d = path.dirname(full); d !== repo && d.startsWith(repo + path.sep); d = path.dirname(d)) {
   try { fs.rmdirSync(d); } catch { break; }
  }
 }
 git(["checkout-index", "--all", "--force"], at);
 git(["reset", "--quiet"]);
 process.stdout.write(JSON.stringify({kind: "restored", files: wanted.size, removed}));
} catch (e) { process.stderr.write("Mend restore: " + e.message + "\n"); process.exitCode = 3; }
finally { fs.rmSync(dir, {recursive: true, force: true}); }
`;

/**
 * The one exec that puts a worktree's files back to `commit`'s tree. `pack`, when given, is a Git
 * pack already placed in the workspace holding the objects its repository may lack (capture mode:
 * the checkpoint was made on Mend's side, not in the workspace).
 */
export const restoreCheckpointExec = (input: {
  readonly repository: string;
  readonly commit: string;
  readonly pack: string | null;
}): ReadonlyArray<string> => ["node", "-e", PROGRAM, JSON.stringify(input)];

/** What the restore exec reports when it put the files back. */
export const RestoreOutcome = Schema.Struct({
  kind: Schema.Literal("restored"),
  files: Schema.Int,
  removed: Schema.Int,
});

/** The refusal the exec wrote, without its prefix; a generic sentence when it wrote none. */
export const restoreFailureWords = (stderr: string): string => {
  const line = stderr
    .split("\n")
    .map((text) => text.trim())
    .find((text) => text.startsWith("Mend restore: "));
  return line === undefined
    ? "Mend couldn't put the files back. The checkpoint it saved first holds the files from before."
    : line.slice("Mend restore: ".length);
};

/**
 * Whether a session's agent works in a terminal right now: its newest agent process is a live
 * terminal one whose hooks report no wait. One whose harness reports no wait at all reads as
 * working, so a restore asks for it to be stopped first.
 */
export const terminalAgentWorking = (processes: ReadonlyArray<SessionProcess>): boolean => {
  const agent = currentAgentProcess(processes);
  return (
    agent !== null && agent.kind === "agent-pty" && isLiveProcess(agent) && agent.waiting === null
  );
};
