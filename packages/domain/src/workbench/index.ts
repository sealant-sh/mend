/**
 * @mend/domain/workbench — the agent-workbench object model
 * (MEND-AGENT-WORKBENCH-PLAN.md §5).
 *
 * ```
 * machine      1 ── 1..n organizations the tenant (docs/adr/0003)
 * organization 1 ── 0..n members       one organization per account
 * organization 1 ── 0..n projects      a repository adopted into the central store
 * project      1 ── 0..n worktrees     a durable named place in the store; explicit removal only
 * worktree     1 ── 0..n sessions      one agent conversation each; several may be live at once
 * worktree     1 ── 1    change        worktree vs base — the reviewable object
 * worktree     1 ── 0..n checkpoints   hidden git ref + exact record pointer; two = a slice
 * change       1 ── 0..n landings      a push, and its pull request, of one checkpoint (docs/adr/0007)
 * session      1 ── 0..n runs          Sealant execution records, one sequence space each
 * session      1 ── 0..n processes     PTYs in the current workspace: agent, shells, Services
 * session      1 ── 0..1 snapshot      immutable context manifest
 * change       1 ── 0..n comments      reviewer's and Mend's, same pipeline
 * ```
 *
 * Lives on a subpath while the queue-era model retires; promotes to the root
 * barrel when `issue.ts` and friends go (docs/M0-INVENTORY.md).
 */
export * from "./audit.ts";
export * from "./agent-protocol.ts";
export * from "./change.ts";
export * from "./checkpoint.ts";
export * from "./connected-credential.ts";
export * from "./context.ts";
export * from "./dotenv.ts";
export * from "./folder.ts";
export * from "./follow-up.ts";
export * from "./harness-launch.ts";
export * from "./hot-workspace.ts";
export * from "./landing.ts";
export * from "./landing-description.ts";
export * from "./mount.ts";
export * from "./link.ts";
export * from "./organization.ts";
export * from "./pass.ts";
export * from "./project.ts";
export * from "./project-cluster-binding.ts";
export * from "./project-environment.ts";
export * from "./project-secret.ts";
export * from "./reference.ts";
export * from "./review-comment.ts";
export * from "./review-slice.ts";
export * from "./service-recipe.ts";
export * from "./service.ts";
export * from "./session.ts";
export * from "./session-fold.ts";
export * from "./session-process.ts";
export * from "./session-control.ts";
export * from "./session-run.ts";
export * from "./skill.ts";
export * from "./slack.ts";
export * from "./tour.ts";
export * from "./worktree.ts";
