import {
  WorktreeCommitResult,
  WorktreeGitRefused,
  type WorktreeCommitRequest,
} from "@mend/domain/workbench";
import { isWorktreeRelativePath } from "@mend/store";
import { Effect, Schema } from "effect";

/** A bounded preview prepared without changing the person's real index. */
export const WorktreeCommitContext = Schema.Struct({
  summary: Schema.String,
  patch: Schema.String,
  recentMessages: Schema.String,
});
export type WorktreeCommitContext = typeof WorktreeCommitContext.Type;

/** An ordinary workspace exec, under the session person's uid, home, groups and Git config. */
export type WorktreeGitExec = (argv: ReadonlyArray<string>) => Effect.Effect<
  {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  },
  WorktreeGitRefused
>;

// Pinned T3 v0.1.2 GitVcsDriverCore.prepareCommitContext and commit. Never interpolate shell text.
const PROGRAM = String.raw`
const cp=require("node:child_process"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const input=JSON.parse(process.argv[1]);
let temporary;
const git=(args,env)=>cp.spawnSync("git",args,{cwd:input.repository,env:env?{...process.env,...env}:process.env,encoding:"utf8",maxBuffer:8*1024*1024,timeout:120000});
const run=(args,env)=>{const r=git(args,env);if(r.error||r.status!==0)throw new Error(r.stderr?.trim()||r.stdout?.trim()||r.error?.message||"Git did not finish the commit.");return r.stdout;};
const stage=(env)=>{
 const config=env?["-c","core.splitIndex=false","-c","splitIndex.sharedIndexExpire=never"]:[];
 if(input.filePaths?.length){
  if(env)run([...config,"read-tree",...(git(["rev-parse","--verify","--quiet","HEAD"]).status===0?["HEAD"]:["--empty"])],env);
  else git(["reset"]);
  run([...config,"add","-A","--",...input.filePaths.map(p=>":(top,literal)"+p)],env);
 } else run([...config,"add","-A"],env);
};
try {
 if(input.phase==="prepare"){
  temporary=fs.mkdtempSync(path.join(os.tmpdir(),"mend-commit-index-"));
  const index=path.resolve(input.repository,run(["rev-parse","--git-path","index"]).trim());
  const target=path.join(temporary,"index"),env={GIT_INDEX_FILE:target};
  const config=["-c","core.splitIndex=false","-c","splitIndex.sharedIndexExpire=never"];
  if(fs.existsSync(index)){
   fs.copyFileSync(index,target);const time=Math.max(0,Math.floor(fs.statSync(index).mtimeMs/1000));fs.utimesSync(target,time,time);
   run([...config,"update-index","--no-split-index"],env);
  } else run([...config,"read-tree","--empty"],env);
  stage(env);
  const summary=run(["diff","--cached","--name-status"],env).trim();
  const patch=summary&&input.includePatch?run(["diff","--no-ext-diff","--cached","--patch","--minimal"],env).slice(0,50000):"";
  const recent=git(["log","-10","--format=%s"]).stdout?.slice(0,4000)||"";
  process.stdout.write(JSON.stringify(summary?{summary:summary.slice(0,8000),patch,recentMessages:recent}:null));
 } else {
  stage();run(["commit","-m",input.message]);
  process.stdout.write(JSON.stringify({status:"created",commitSha:run(["rev-parse","HEAD"]).trim(),subject:run(["log","-1","--format=%s"]).trim()}));
 }
}catch(error){process.stderr.write(error.message+"\n");process.exitCode=1;}
finally{if(temporary)fs.rmSync(temporary,{recursive:true,force:true});}
`;

const decode = <S extends Schema.Top>(schema: S, raw: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(raw).pipe(
    Effect.mapError(
      () =>
        new WorktreeGitRefused({
          code: "unavailable",
          message: "Git did not report the commit result. Refresh before trying again.",
        }),
    ),
  );

/** Commit all or selected literal paths, generating only when blank; a clean retry creates nothing. */
export const commitWorktree = (
  repository: string,
  input: WorktreeCommitRequest,
  execute: WorktreeGitExec,
  generate: (context: WorktreeCommitContext) => Effect.Effect<string, WorktreeGitRefused>,
): Effect.Effect<WorktreeCommitResult, WorktreeGitRefused> =>
  Effect.gen(function* () {
    if (
      input.filePaths?.some(
        (path) => !isWorktreeRelativePath(path.endsWith("/") ? path.slice(0, -1) : path),
      )
    )
      return yield* new WorktreeGitRefused({
        code: "git",
        message: "Choose files inside this worktree, outside .git.",
      });
    const run = (phase: "prepare" | "commit", message?: string) =>
      execute([
        "node",
        "-e",
        PROGRAM,
        JSON.stringify({
          repository,
          phase,
          filePaths: input.filePaths,
          includePatch: !input.message?.trim(),
          message,
        }),
      ]).pipe(
        Effect.flatMap((result) =>
          result.exitCode === 0
            ? Effect.succeed(result.stdout)
            : Effect.fail(
                new WorktreeGitRefused({
                  code: "git",
                  message: result.stderr.trim() || "Git did not finish the commit.",
                }),
              ),
        ),
      );
    const context = yield* decode(Schema.NullOr(WorktreeCommitContext), yield* run("prepare"));
    if (context === null) return { status: "skipped_no_changes" };
    const message = input.message?.trim() || (yield* generate(context)).trim();
    if (message.length === 0)
      return yield* new WorktreeGitRefused({
        code: "unavailable",
        message: "No commit message was generated. Enter one and try again.",
      });
    return yield* decode(WorktreeCommitResult, yield* run("commit", message));
  });
