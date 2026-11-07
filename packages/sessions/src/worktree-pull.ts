import { WorktreeGitRefused, WorktreePullResult } from "@mend/domain/workbench";
import { Effect, Schema } from "effect";

import type { WorktreeGitExec } from "./worktree-commit.ts";

// T3 v0.1.2 GitVcsDriverCore.pullCurrentBranch. Pull only fast-forwards; it never makes a merge commit.
const PROGRAM = String.raw`
const cp=require("node:child_process"),input=JSON.parse(process.argv[1]);
const git=(args,quiet=false)=>cp.spawnSync("git",args,{cwd:input.repository,encoding:"utf8",maxBuffer:8*1024*1024,timeout:30000,...(quiet?{stdio:["ignore","ignore","pipe"]}:{})});
const read=args=>{const r=git(args);if(r.error||r.status!==0)throw new Error("Git could not read this worktree. Refresh and try again.");return r.stdout.trim();};
try {
 const branch=git(["symbolic-ref","--quiet","--short","HEAD"]).stdout?.trim();
 if(!branch)throw new Error("Cannot pull from detached HEAD.");
 const upstream=git(["rev-parse","--abbrev-ref","--symbolic-full-name","@{upstream}"]);
 if(upstream.status!==0)throw new Error("Current branch has no upstream configured. Push with upstream first.");
 const before=read(["rev-parse","HEAD"]);
 const result=git(["pull","--ff-only"],true);
 if(result.error||result.status!==0){
  const detail=result.stderr||"";
  if(/would be overwritten|local changes|unmerged files/i.test(detail))throw new Error("Pull would overwrite local changes. Commit or move them, then try again.");
  if(/not possible to fast-forward|diverging branches|cannot fast-forward/i.test(detail))throw new Error("This branch and its upstream have diverged. Pull only fast-forwards; reconcile the branches before trying again.");
  if(/authentication|permission denied|could not read Username|repository not found/i.test(detail))throw new Error("Git could not authenticate to the upstream. Check your connected Git account and repository rights.");
  throw new Error("Git could not pull the configured upstream. Check your connection and Git configuration, then try again.");
 }
 const after=read(["rev-parse","HEAD"]);
 process.stdout.write(JSON.stringify({status:before===after?"skipped_up_to_date":"pulled",refName:branch,upstreamRef:upstream.stdout.trim()}));
}catch(error){process.stderr.write(error.message+"\n");process.exitCode=1;}
`;

/** Pull in the authoritative workspace through its ordinary person-scoped Git exec. */
export const pullWorktree = (
  repository: string,
  execute: WorktreeGitExec,
): Effect.Effect<WorktreePullResult, WorktreeGitRefused> =>
  Effect.gen(function* () {
    const result = yield* execute(["node", "-e", PROGRAM, JSON.stringify({ repository })]);
    if (result.exitCode !== 0)
      return yield* new WorktreeGitRefused({
        code: "git",
        message: result.stderr.trim() || "Git did not finish the pull.",
      });
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(WorktreePullResult))(
      result.stdout,
    ).pipe(
      Effect.mapError(
        () =>
          new WorktreeGitRefused({
            code: "unavailable",
            message: "Git finished without reporting its pull result. Refresh before trying again.",
          }),
      ),
    );
  });
