import type { WorktreeId } from "@mend/domain";
import {
  WorktreeBranchResult,
  WorktreeGitRefused,
  type WorktreeBranchAction,
} from "@mend/domain/workbench";
import { Effect, Schema } from "effect";

/** Engine-local ordering, shared by explicit Git actions and a whole landing. Git also holds its own locks. */
export type WorktreeGitGate = <A, E, R>(
  id: WorktreeId,
  effect: Effect.Effect<A, E, R>,
) => Effect.Effect<A, E | WorktreeGitRefused, R>;

export const makeWorktreeGitGate = (): WorktreeGitGate => {
  const held = new Set<WorktreeId>();
  return <A, E, R>(
    id: WorktreeId,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | WorktreeGitRefused, R> =>
    Effect.acquireUseRelease(
      Effect.suspend(() => {
        if (held.has(id))
          return Effect.fail(
            new WorktreeGitRefused({
              code: "busy",
              message:
                "A Git action or landing is already in progress in this worktree. Try again when it finishes.",
            }),
          );
        held.add(id);
        return Effect.void;
      }),
      () => effect,
      () =>
        Effect.sync(() => {
          held.delete(id);
        }),
    );
};

// Pinned T3 v0.1.2 GitVcsDriverCore switchRef/createRef. Arguments never enter shell text.
const PROGRAM = String.raw`
const cp = require("node:child_process");
const input = JSON.parse(process.argv[1]);
const git = args => cp.spawnSync("git",args,{cwd:input.repository,encoding:"utf8",maxBuffer:1024*1024,timeout:15000});
const run = args => {const r=git(args);if(r.error||r.status!==0)throw new Error(r.stderr?.trim()||r.error?.message||"Git did not finish the branch operation.");return r.stdout.trim();};
const exists = ref => git(["show-ref","--verify","--quiet",ref]).status===0;
try {
 const ref=input.action.refName;
 if(typeof ref!=="string"||ref.length===0||ref.length>1024||ref.includes("\0")||(ref.startsWith("-")&&ref!=="-"))throw new Error("Choose a valid Git branch or ref name.");
 const checkout = () => {
  if(ref === "-" && !run(["rev-parse","--symbolic-full-name","@{-1}"]).startsWith("refs/heads/"))throw new Error("Choose a named branch. This worktree cannot switch to a detached ref.");
  if(ref !== "-" && !exists("refs/heads/"+ref) && !exists("refs/remotes/"+ref))throw new Error("Choose an existing named branch. This worktree cannot switch to a detached ref.");
  let args=["checkout",ref];
  if(!exists("refs/heads/"+ref)&&exists("refs/remotes/"+ref)) {
   const tracking=run(["for-each-ref","--format=%(refname:short)\t%(upstream:short)","refs/heads"]).split("\n").map(x=>x.split("\t")).find(x=>x[1]===ref)?.[0];
   const local=ref.includes("/")?ref.slice(ref.indexOf("/")+1):null;
   if(!tracking && local && exists("refs/heads/"+local))throw new Error("A local branch with that name already exists. Choose it or rename it before switching to this remote branch.");
   args=tracking?["checkout",tracking]:["checkout","--track",ref];
  }
  run([...args,"--"]);
 };
 if(input.action.kind==="create") {run(["branch","--",ref]);if(input.action.switchRef)checkout();}
 else checkout();
 const branch=run(["branch","--show-current"])||null;
 process.stdout.write(JSON.stringify({refName:input.action.kind==="create"?ref:branch??ref,branch}));
} catch(error) {process.stderr.write(error.message+"\n");process.exitCode=1;}
`;

/** Run Git in the authoritative workspace as the same person as an ordinary shell. */
export const changeWorktreeBranch = (
  repository: string,
  action: WorktreeBranchAction,
  execute: (
    argv: ReadonlyArray<string>,
  ) => Effect.Effect<
    { readonly exitCode: number; readonly stdout: string; readonly stderr: string },
    WorktreeGitRefused
  >,
): Effect.Effect<WorktreeBranchResult, WorktreeGitRefused> =>
  Effect.gen(function* () {
    const result = yield* execute(["node", "-e", PROGRAM, JSON.stringify({ repository, action })]);
    if (result.exitCode !== 0)
      return yield* new WorktreeGitRefused({
        code: "git",
        message: result.stderr.trim() || "Git did not finish the branch operation.",
      });
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(WorktreeBranchResult))(
      result.stdout,
    ).pipe(
      Effect.mapError(
        () =>
          new WorktreeGitRefused({
            code: "unavailable",
            message:
              "Git finished without reporting its current branch. Refresh before trying again.",
          }),
      ),
    );
  });
