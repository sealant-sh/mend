import type { ProjectPreviewTarget, ProjectPreviewView } from "@mend/api-contracts";
import { WorktreeId } from "@mend/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Button, focusRing } from "#/components/kit/button";
import { Panel } from "#/components/kit/section";
import type { ProjectDetailDto } from "#/lib/api";
import { useTRPC } from "#/lib/trpc";

type TargetChoice = { readonly id: string; readonly name: string | null; readonly branch: string };

/** The address remains visible while the selected target is stopped or missing. */
export function ProjectPreviewCard({
  read,
  worktrees,
  busy,
  error,
  onUse,
  onStart,
}: {
  readonly read: ProjectPreviewView;
  readonly worktrees: ReadonlyArray<TargetChoice>;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onUse: (target: ProjectPreviewTarget) => void;
  readonly onStart: () => void;
}) {
  const selected = read.fixed?.targetMode === "worktree" ? (read.target?.id ?? "") : "";
  return (
    <Panel className="mb-5 p-5">
      <section aria-label="Fixed project preview" className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-sans text-[15px] font-semibold">Fixed project preview</h2>
            <p className="mt-1 text-[13px] text-muted-foreground">
              Register this address with your sign-in provider once, then choose which worktree it
              serves.
            </p>
          </div>
          {read.open === null ? null : (
            <a
              className={`${focusRing} text-[13px] text-primary underline`}
              href={read.open}
              target="_blank"
              rel="noreferrer"
            >
              Open preview
            </a>
          )}
        </div>
        <p className="font-mono text-[12px] break-all">
          {read.url ?? "Address unknown. Start after declaring [preview] fixed = true."}
        </p>
        <p className="font-mono text-[11.5px] text-muted-foreground">
          Target ·{" "}
          {read.target === null
            ? "not started"
            : `${read.target.name ?? read.target.branch} · ${read.target.branch}`}
          {read.fixed?.targetMode === "default" ? " · Default · shared Local worktree" : ""}
        </p>
        <div role="status" className="space-y-1 font-mono text-[11.5px] text-faint">
          {read.status.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
        {!read.configured ? (
          <p className="text-[13px] text-muted-foreground">
            In the default branch's .mend/mend.toml, name one HTTP Service with{" "}
            <code>[preview] service = "web"</code> and <code>fixed = true</code>.
          </p>
        ) : null}
        {!read.canManage || !read.configured ? null : (
          <div className="flex flex-wrap items-end gap-3">
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const value = new FormData(event.currentTarget).get("target");
                if (value === "") onUse({ _tag: "Default" });
                else {
                  const chosen = worktrees.find((worktree) => worktree.id === value);
                  if (chosen !== undefined)
                    onUse({ _tag: "Worktree", worktreeId: WorktreeId.make(chosen.id) });
                }
              }}
            >
              <label className="space-y-1 text-[12px] text-muted-foreground">
                Preview target
                <select
                  key={`${read.fixed?.targetMode ?? "default"}:${selected}`}
                  name="target"
                  defaultValue={selected}
                  disabled={busy}
                  className={`${focusRing} block min-h-9 rounded-md border border-rule bg-panel px-2 text-[13px] text-foreground`}
                >
                  <option value="">Default · shared Local worktree</option>
                  {worktrees.map((worktree) => (
                    <option key={worktree.id} value={worktree.id}>
                      {worktree.name ?? worktree.branch}
                    </option>
                  ))}
                </select>
              </label>
              <Button type="submit" size="sm" disabled={busy}>
                Use target
              </Button>
            </form>
            <Button size="sm" variant="primary" disabled={busy} onClick={onStart}>
              Start
            </Button>
            <p className="text-[12px] text-muted-foreground">
              Choosing a target closes its previous preview connections. Start keeps the worktree's
              edits.
            </p>
          </div>
        )}
        {error === null ? null : (
          <p role="alert" className="text-[13px] text-danger">
            {error}
          </p>
        )}
      </section>
    </Panel>
  );
}

/** The Worktrees tab owns this read alongside its existing project detail. */
export function ProjectFixedPreview({ detail }: { readonly detail: ProjectDetailDto }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const id = detail.project.id;
  const query = useQuery(trpc.previews.project.queryOptions({ id }, { refetchInterval: 10_000 }));
  const updated = () =>
    Promise.all([
      queryClient.invalidateQueries(trpc.previews.project.queryFilter({ id })),
      queryClient.invalidateQueries(trpc.projects.detail.queryFilter({ id })),
      queryClient.invalidateQueries(trpc.worktrees.pathFilter()),
    ]);
  const start = useMutation(trpc.previews.start.mutationOptions({ onSuccess: updated }));
  const use = useMutation(trpc.previews.use.mutationOptions({ onSuccess: updated }));
  if (query.data === undefined)
    return (
      <p role="status" className="mb-4 font-mono text-[11.5px] text-faint">
        {query.isError
          ? `Fixed preview could not be read · ${query.error.message}`
          : "Reading fixed preview…"}
      </p>
    );
  return (
    <ProjectPreviewCard
      read={query.data}
      worktrees={detail.worktrees}
      busy={start.isPending || use.isPending}
      error={start.error?.message ?? use.error?.message ?? null}
      onStart={() => start.mutate({ id })}
      onUse={(target) => use.mutate({ id, target })}
    />
  );
}
