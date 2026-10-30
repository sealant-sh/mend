import type { WorktreeId } from "@mend/domain";
import {
  choicesFor,
  type ResourceApprovalOffers,
  type ResourceApprovalRequest,
  type ResourceDefinitionInput,
  type ResourceRefusal,
  resourceProposalNotices,
  resourceReviewRows,
  resourceRuntimeRefusal,
  type WorktreeChoice,
} from "@mend/domain/workbench";
import { Button } from "@mend/ui/components/ui/button";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useRef, useState } from "react";

import {
  approveResource,
  choiceInUse,
  choiceWords,
  chooseResource,
  EMPTY_DRAFT,
  fieldOf,
  type ProposalDraft,
  type ProposalField,
  proposalOf,
  proposeResource,
  readerZone,
  removeResourceDefinition,
  type ResourceProposalView,
  type ResourcesPageView,
  type ResourceSettingView,
  withdrawResourceProposal,
} from "#/lib/resources";
import {
  type Answer,
  answered,
  type ItemNote,
  refusedNote,
  resourcesRead,
  settleChoice,
} from "#/lib/resources-card";
import { useTRPC } from "#/lib/trpc";

/**
 * A project's resources in its setup (ADR 0019): definitions settings hold, members' proposals,
 * and a chosen worktree's `mend.toml` tables, each on the one status line the server sends. Every
 * control comes from the page: its flags, and the approval requests the server built for it.
 */

/** An approval under review: the request the server built, and the read it came from. */
export interface Confirming {
  readonly key: string;
  readonly spec: ResourceDefinitionInput;
  readonly digest: string;
  readonly request: ResourceApprovalRequest;
  readonly target: string;
  readonly worktreeId: WorktreeId | null;
}

/** The act running on each item, by item key; one at a time per item. */
export type Busy = ReadonlyMap<string, string>;

const quiet =
  "shrink-0 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50";
const field =
  "w-full rounded-lg border border-input bg-background px-2.5 py-1.5 font-mono text-xs text-foreground placeholder:text-faint";
const hint = "mt-1 text-[11px] text-label";
const toggle = (on: boolean) =>
  `rounded-lg border px-2 py-1 font-mono text-[11px] transition-colors disabled:opacity-50 ${
    on
      ? "border-[color-mix(in_oklab,var(--sw-accent)_45%,transparent)] bg-wash text-foreground"
      : "border-border bg-card text-muted-foreground hover:text-foreground"
  }`;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const PROPOSE = "form";

/** An act's answer, and whatever else it changes on screen once it is known to be this read's. */
type Settled = Answer & { readonly apply?: () => void };

/** An act answered with nothing to say: the item's earlier note goes. */
const none = (key: string): Answer => ({ at: key, note: null });

export function ResourcesSection({ projectId }: { readonly projectId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [worktreeId, setWorktreeId] = useState<WorktreeId | null>(null);
  const worktreesQuery = useQuery(trpc.worktrees.list.queryOptions({ projectId }));
  const worktrees = worktreesQuery.data?.worktrees ?? [];
  const listOptions = trpc.resources.list.queryOptions({
    projectId,
    timeZone: readerZone(),
    worktreeId,
  });
  const query = useQuery(listOptions);
  const read = resourcesRead(query, worktreeId);
  const [busy, setBusy] = useState<Busy>(new Map());
  const running = useRef(new Map<string, string>());
  const [notes, setNotes] = useState<ReadonlyMap<string, ItemNote>>(new Map());
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const [draft, setDraft] = useState<ProposalDraft | null>(null);
  const [formRefusals, setFormRefusals] = useState<ReadonlyArray<ResourceRefusal>>([]);
  // The read on screen: its project and worktree. An act's answer belongs to the read it started
  // from, and one that returns after the read changed is dropped, never shown under another.
  const reading = `${projectId}\u0000${worktreeId ?? ""}`;
  const shown = useRef(reading);
  shown.current = reading;

  const invalidate = () => queryClient.invalidateQueries(trpc.resources.pathFilter());
  const reload = () => {
    setNotes(new Map());
    setConfirming(null);
    return invalidate();
  };
  /**
   * One act on one item, never two at once on it: the guard reads a ref, so a second click before
   * the next render is refused too. Its answer lands once, where the act says.
   */
  const act = (key: string, action: string, run: () => Promise<Settled>) => {
    if (running.current.has(key)) return;
    running.current.set(key, action);
    setBusy(new Map(running.current));
    const startedOn = reading;
    void run()
      .catch(
        (error: unknown): Settled => ({
          at: key,
          note: { refused: true, lines: [message(error)], reload: false },
        }),
      )
      .then((answer) => {
        // Everything an answer changes on screen happens here, for the read it started from only.
        if (shown.current !== startedOn) return false;
        setNotes((current) => answered(current, key, answer));
        answer.apply?.();
        return true;
      })
      .finally(() => {
        running.current.delete(key);
        setBusy(new Map(running.current));
      });
  };

  const handlers: ResourceHandlers = {
    withdraw: (entry) => {
      const key = `p:${entry.id}`;
      act(key, "withdraw", async () => {
        const outcome = await withdrawResourceProposal(projectId, entry.id);
        if (!outcome.ok) {
          return {
            at: key,
            note: {
              refused: true,
              lines: [`@${entry.spec.name} · this proposal is gone since you read it`],
              reload: true,
            },
          };
        }
        await invalidate();
        return none(key);
      });
    },
    remove: (entry) => {
      const key = `s:${entry.id}`;
      act(key, "remove", async () => {
        const outcome = await removeResourceDefinition(projectId, entry);
        if (!outcome.ok) return { at: key, note: refusedNote(outcome) };
        await invalidate();
        return none(key);
      });
    },
    confirm: setConfirming,
    approve: (pending) =>
      act(pending.key, "approve", async () => {
        const outcome = await approveResource(projectId, pending.request);
        const close = () => setConfirming((open) => (open?.key === pending.key ? null : open));
        if (!outcome.ok) return { at: pending.key, note: refusedNote(outcome), apply: close };
        const { definition, image, resolvedBy } = outcome.result;
        await invalidate();
        // A proposal or a file table approved is now the definition settings hold.
        return {
          apply: close,
          at: `s:${definition.id}`,
          note: {
            refused: false,
            lines: [`image ${image}${resolvedBy === null ? "" : ` · digest from ${resolvedBy}`}`],
            reload: false,
          },
        };
      }),
    choose: (entry, readFor, mode) => {
      if (readFor === null) return;
      const key = `s:${entry.id}`;
      act(key, "choose", async () => {
        const outcome = await chooseResource(projectId, readFor, entry.id, mode);
        if (!outcome.ok) return { at: key, note: refusedNote(outcome) };
        await settleChoice(queryClient, listOptions.queryKey, outcome.result);
        return none(key);
      });
    },
    reload: () => void reload(),
  };

  const propose = (current: ProposalDraft) => {
    if (running.current.has(PROPOSE)) return;
    const checked = proposalOf(current);
    if (!checked.ok) return setFormRefusals(checked.refusals);
    setFormRefusals([]);
    act(PROPOSE, "propose", async () => {
      const outcome = await proposeResource(projectId, checked.proposal);
      if (!outcome.ok) {
        const refusals =
          outcome.kind === "rejected"
            ? outcome.refusals
            : [{ key: "proposal", message: outcome.message }];
        return { ...none(PROPOSE), apply: () => setFormRefusals(refusals) };
      }
      await invalidate();
      return {
        apply: () => setDraft(null),
        at: `p:${outcome.result.id}`,
        note: { refused: false, lines: ["Proposed. A manager approves it here."], reload: false },
      };
    });
  };

  const readName = (id: WorktreeId | null) =>
    id === null ? null : (worktrees.find((each) => each.id === id)?.name ?? id);
  return (
    <section id="resources" className="project-setup-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2 className="font-sans text-sm font-semibold">Resources</h2>
        <div className="flex flex-col items-end gap-1">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            read for worktree
            <select
              value={worktreeId ?? ""}
              onChange={(event) => {
                const chosen = worktrees.find((each) => each.id === event.target.value);
                setWorktreeId(chosen?.id ?? null);
                shown.current = `${projectId}\u0000${chosen?.id ?? ""}`;
                setNotes(new Map());
                setConfirming(null);
                // Refusals answered a submit on the read that changed; the draft stays the person's.
                setFormRefusals([]);
              }}
              className="rounded-lg border border-input bg-background px-2 py-1 font-mono text-[11px] text-foreground"
            >
              <option value="">none</option>
              {worktrees.map((each) => (
                <option key={each.id} value={each.id}>
                  {each.name}
                </option>
              ))}
            </select>
          </label>
          {worktreesQuery.isError ? (
            <p className="font-mono text-[11px] text-danger">
              worktrees not read · {message(worktreesQuery.error)}{" "}
              <button type="button" onClick={() => void worktreesQuery.refetch()} className={quiet}>
                retry
              </button>
            </p>
          ) : null}
        </div>
      </div>
      <p className="mt-2.5 max-w-[64ch] text-xs leading-relaxed text-muted-foreground">
        Long-running services for the project or for one worktree, such as a database or a mail
        catcher. Any member proposes one, the project&apos;s creator or an organization owner
        approves it, and a worktree&apos;s change owner chooses how that worktree uses it. Approving
        pins the image; nothing starts until a runtime runs resources.
      </p>
      <ReadState
        read={read}
        worktreeName={readName(worktreeId)}
        onRetry={() => void query.refetch()}
      >
        {(page, readWorktree) => (
          <ResourcesView
            page={page}
            worktreeId={readWorktree}
            worktreeName={readName(readWorktree)}
            busy={busy}
            notes={notes}
            confirming={confirming}
            handlers={handlers}
          />
        )}
      </ReadState>
      {read.kind !== "loaded" || !read.page.canPropose ? null : draft === null ? (
        <button
          type="button"
          onClick={() => {
            setDraft(EMPTY_DRAFT);
            setFormRefusals([]);
          }}
          className="mt-3 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          + propose a resource…
        </button>
      ) : (
        <ProposalForm
          draft={draft}
          refusals={formRefusals}
          note={notes.get(PROPOSE)}
          busy={busy.has(PROPOSE)}
          onChange={(next) => {
            // A refusal answered the draft that was sent; an edit makes a new one.
            setDraft(next);
            setFormRefusals([]);
          }}
          onCancel={() => setDraft(null)}
          onSubmit={() => propose(draft)}
        />
      )}
    </section>
  );
}

/** A read in flight, failed with its words and a retry, or loaded and handed on. */
export function ReadState(props: {
  readonly read: ReturnType<typeof resourcesRead>;
  readonly worktreeName: string | null;
  readonly onRetry: () => void;
  readonly children: (page: ResourcesPageView, worktreeId: WorktreeId | null) => ReactNode;
}) {
  const { read } = props;
  const where = props.worktreeName === null ? "" : ` for ${props.worktreeName}`;
  switch (read.kind) {
    case "pending":
      return <p className="mt-4 font-mono text-[11px] text-faint">reading resources{where}…</p>;
    case "failed":
      return (
        <div className="mt-4 border-l-2 border-[var(--sw-red)] pl-2">
          <p className="font-mono text-[11px] text-danger">
            resources{where} not read · {read.message}
          </p>
          <button type="button" onClick={props.onRetry} className={`${quiet} mt-1`}>
            retry
          </button>
        </div>
      );
    case "loaded":
      return props.children(read.page, read.worktreeId);
  }
}

export interface ResourceHandlers {
  readonly withdraw: (entry: ResourceProposalView) => void;
  readonly remove: (entry: ResourceSettingView) => void;
  readonly confirm: (pending: Confirming | null) => void;
  readonly approve: (pending: Confirming) => void;
  /** `read`: the worktree the page on screen was read for, which the choice is made for. */
  readonly choose: (
    entry: ResourceSettingView,
    read: WorktreeId | null,
    mode: WorktreeChoice,
  ) => void;
  readonly reload: () => void;
}

export interface ResourcesViewProps {
  readonly page: ResourcesPageView;
  /** The worktree this page was read for; every action on it is for that worktree. */
  readonly worktreeId: WorktreeId | null;
  readonly worktreeName: string | null;
  readonly busy: Busy;
  readonly notes: ReadonlyMap<string, ItemNote>;
  readonly confirming: Confirming | null;
  readonly handlers: ResourceHandlers;
}

/** The lists, each item with its line, its image and the acts the page offers on it. */
export function ResourcesView(props: ResourcesViewProps) {
  const { page, worktreeId, worktreeName, busy, handlers } = props;
  const label = (key: string, action: string, idle: string, running: string) =>
    busy.get(key) === action ? running : idle;
  /** One button per target the server built a request for. */
  const approveActions = (
    key: string,
    item: { readonly spec: ResourceDefinitionInput; readonly digest: string },
    offers: ResourceApprovalOffers,
  ) =>
    (
      [
        ["for the project", offers.project],
        [`for worktree ${worktreeName ?? ""}`, offers.worktree],
      ] as const
    ).map(([target, request]) =>
      request === null ? null : (
        <button
          key={target}
          type="button"
          disabled={busy.has(key)}
          onClick={() =>
            handlers.confirm({
              key,
              spec: item.spec,
              digest: item.digest,
              request,
              target,
              worktreeId,
            })
          }
          className={quiet}
        >
          approve {target}…
        </button>
      ),
    );
  const review = (key: string) => {
    const { confirming } = props;
    // A review belongs to the read it was opened on; another worktree's read closes it.
    return confirming?.key === key && confirming.worktreeId === worktreeId ? (
      <ApprovalReview
        pending={confirming}
        busy={busy.get(key) === "approve"}
        onCancel={() => handlers.confirm(null)}
        onApprove={handlers.approve}
      />
    ) : null;
  };
  const item = (
    key: string,
    line: string,
    spec: ResourceDefinitionInput,
    id: string | null,
    actions: ReactNode,
    body?: ReactNode,
  ) => (
    <ResourceItem
      key={key}
      line={line}
      image={spec.image}
      id={id}
      actions={actions}
      note={props.notes.get(key)}
      onReload={handlers.reload}
    >
      {body}
      {review(key)}
    </ResourceItem>
  );
  const { file } = page;
  const notices = file.kind === "read" ? resourceProposalNotices(file) : [];
  const empty = page.settings.length === 0 && page.proposals.length === 0 && file.kind !== "read";
  return (
    <div className="mt-4 space-y-5">
      {empty ? (
        <p className="text-xs text-ink-2">No resources yet. Nothing is declared or proposed.</p>
      ) : null}
      {page.settings.length === 0 ? null : (
        <Group label="definitions">
          {page.settings.map((entry) => {
            const key = `s:${entry.id}`;
            const approved = entry.approvals.project !== null || entry.approvals.worktree !== null;
            return item(
              key,
              entry.statusLine,
              entry.spec,
              entry.id,
              <>
                {approveActions(key, entry, entry.approve)}
                {entry.canRemove ? (
                  <button
                    type="button"
                    disabled={busy.has(key)}
                    onClick={() => handlers.remove(entry)}
                    className={`${quiet} hover:text-danger`}
                  >
                    {label(key, "remove", "remove", "removing…")}
                  </button>
                ) : null}
              </>,
              <>
                {worktreeId === null ? null : (
                  <ChoiceLine
                    entry={entry}
                    worktreeName={worktreeName ?? ""}
                    busy={busy.has(key)}
                    onChoose={(mode) => handlers.choose(entry, worktreeId, mode)}
                  />
                )}
                {approved ? (
                  <p className="mt-1.5 font-mono text-[11px] text-muted-foreground">
                    <span className="text-label">start</span>{" "}
                    {resourceRuntimeRefusal(entry.spec.name, "project")}
                  </p>
                ) : null}
              </>,
            );
          })}
        </Group>
      )}
      {page.proposals.length === 0 ? null : (
        <Group label="proposals">
          {page.proposals.map((entry) => {
            const key = `p:${entry.id}`;
            const removal = entry.mine ? "withdraw" : "remove";
            return item(
              key,
              entry.statusLine,
              entry.spec,
              entry.id,
              <>
                {approveActions(key, entry, entry.approve)}
                {entry.canRemove ? (
                  <button
                    type="button"
                    disabled={busy.has(key)}
                    onClick={() => handlers.withdraw(entry)}
                    className={`${quiet} hover:text-danger`}
                  >
                    {label(key, "withdraw", removal, entry.mine ? "withdrawing…" : "removing…")}
                  </button>
                ) : null}
              </>,
            );
          })}
        </Group>
      )}
      {file.kind === "not-selected" ? null : (
        <Group label={`mend.toml in ${worktreeName ?? "this worktree"}`}>
          {file.kind === "read" ? (
            <>
              <p className="px-4 pt-3 font-mono text-[11px] text-faint">{file.observed}</p>
              {file.proposals.map((entry) => {
                const key = `f:${entry.spec.name}`;
                return item(
                  key,
                  entry.statusLine,
                  entry.spec,
                  null,
                  approveActions(key, entry, entry.approve),
                );
              })}
              {notices.map((notice) => (
                <p key={notice} className="px-4 py-2 font-mono text-[11px] text-ink-2">
                  {notice}
                </p>
              ))}
              {file.proposals.length === 0 && notices.length === 0 ? (
                <p className="px-4 py-3 text-xs text-muted-foreground">No [resource.*] tables.</p>
              ) : null}
            </>
          ) : (
            <p className="px-4 py-3 font-mono text-[11px] text-ink-2">
              {file.kind === "absent"
                ? `absent · ${file.observed}`
                : file.kind === "unparsed"
                  ? `${file.observed} · ${file.message}`
                  : file.message}
            </p>
          )}
        </Group>
      )}
    </div>
  );
}

function Group({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div>
      <p className="ev-eyebrow">{label}</p>
      <div className="mt-2 divide-y divide-rule-faint overflow-hidden rounded-xl border border-rule-faint">
        {children}
      </div>
    </div>
  );
}

function ResourceItem(props: {
  readonly line: string;
  readonly image: string;
  readonly id: string | null;
  readonly actions: ReactNode;
  readonly note: ItemNote | undefined;
  readonly onReload: () => void;
  readonly children?: ReactNode;
}) {
  const { note } = props;
  return (
    <div className="px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <p className="min-w-0 font-mono text-[12px] break-words text-foreground">{props.line}</p>
        <div className="flex flex-wrap items-center gap-3">{props.actions}</div>
      </div>
      <p className="mt-1 font-mono text-[11px] break-all text-faint">
        {props.image}
        {props.id === null ? "" : ` · ${props.id}`}
      </p>
      {props.children}
      {note === undefined ? null : (
        <div
          className={`mt-2 border-l-2 pl-2 text-xs ${note.refused ? "border-[var(--sw-red)] text-danger" : "border-rule text-ink-2"}`}
        >
          {note.lines.map((line) => (
            <p key={line} className="font-mono text-[11px] break-words">
              {line}
            </p>
          ))}
          {note.reload ? (
            <button type="button" onClick={props.onReload} className={`${quiet} mt-1`}>
              reload
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** Which mode the read worktree uses, at a glance, and the one action that changes it. */
export function ChoiceLine(props: {
  readonly entry: ResourceSettingView;
  readonly worktreeName: string;
  readonly busy: boolean;
  readonly onChoose: (mode: WorktreeChoice) => void;
}) {
  const { entry } = props;
  const inUse = choiceInUse(entry);
  if (inUse === null) {
    return (
      <p className="mt-2 text-xs text-ink-2">
        {props.worktreeName} gets an instance of its own of this worktree resource, with no choice.
      </p>
    );
  }
  const words = choiceWords(entry.spec, inUse.choice);
  return (
    <div className="mt-2">
      {entry.canChoose ? (
        <div
          role="group"
          aria-label={`How ${props.worktreeName} uses @${entry.spec.name}`}
          className="flex flex-wrap items-center gap-1"
        >
          {choicesFor(entry.spec).map((choice) => (
            <button
              key={choice}
              type="button"
              disabled={props.busy}
              aria-pressed={entry.choice === choice}
              onClick={() => (entry.choice === choice ? undefined : props.onChoose(choice))}
              className={toggle(entry.choice === choice)}
            >
              {choiceWords(entry.spec, choice).label}
            </button>
          ))}
        </div>
      ) : null}
      <p className="mt-1.5 text-xs text-ink-2">
        <span className="font-mono text-[11px] text-foreground">
          {inUse.stored
            ? `${props.worktreeName} uses ${words.label}.`
            : `${props.worktreeName} · nothing chosen yet · ${words.label} at its first launch.`}
        </span>{" "}
        {words.meaning}
      </p>
    </div>
  );
}

/** The exact definition an approval approves, every field apart, before it is sent. */
export function ApprovalReview(props: {
  readonly pending: Confirming;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onApprove: (pending: Confirming) => void;
}) {
  return (
    <div className="mt-3 rounded-xl bg-sunken p-3">
      <p className="text-xs text-ink-2">
        Approve exactly this definition {props.pending.target}. Mend asks the registry for the
        image&apos;s digest and pins it; nothing starts.
      </p>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-[11px]">
        {resourceReviewRows(props.pending.spec, props.pending.digest).map((row) => (
          <div key={row.label} className="contents">
            <dt className="text-label">{row.label}</dt>
            <dd className="break-all whitespace-pre-wrap text-foreground">{row.value}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-3 flex items-center justify-end gap-2.5">
        <button type="button" onClick={props.onCancel} className={quiet}>
          cancel
        </button>
        <Button size="sm" disabled={props.busy} onClick={() => props.onApprove(props.pending)}>
          {props.busy ? "approving…" : "approve"}
        </Button>
      </div>
    </div>
  );
}

const PRESETS = ["postgres", "redis", "mysql"] as const;

/** A preset at a version, or an image with its ports, env and volumes; refusals under each field. */
export function ProposalForm(props: {
  readonly draft: ProposalDraft;
  readonly refusals: ReadonlyArray<ResourceRefusal>;
  /** What answered the last submit when it never reached the server: a request that failed. */
  readonly note: ItemNote | undefined;
  readonly busy: boolean;
  readonly onChange: (draft: ProposalDraft) => void;
  readonly onCancel: () => void;
  readonly onSubmit: () => void;
}) {
  const { draft, onChange } = props;
  const set = <K extends keyof ProposalDraft>(key: K, value: ProposalDraft[K]) =>
    onChange({ ...draft, [key]: value });
  const refused = (at: ProposalField | null) => {
    const own = props.refusals.filter((refusal) => fieldOf(refusal.key) === at);
    return own.length === 0 ? null : (
      <div className="border-l-2 border-[var(--sw-red)] pl-2">
        {own.map((refusal) => (
          <p
            key={`${refusal.key}:${refusal.message}`}
            className="font-mono text-[11px] text-danger"
          >
            {refusal.key} {refusal.message}
          </p>
        ))}
      </div>
    );
  };
  const choices = <V extends string>(
    label: string,
    values: ReadonlyArray<V>,
    value: V,
    pick: (next: V) => void,
  ) => (
    <div role="group" aria-label={label} className="flex items-center gap-1">
      {values.map((each) => (
        <button
          key={each}
          type="button"
          aria-pressed={value === each}
          onClick={() => pick(each)}
          className={toggle(value === each)}
        >
          {each}
        </button>
      ))}
    </div>
  );
  return (
    <form
      className="mt-3 flex flex-col gap-2 rounded-xl border border-rule-faint px-4 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        props.onSubmit();
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        {choices("What it runs", ["preset", "image"], draft.kind, (kind) => set("kind", kind))}
        {choices("Scope", ["project", "worktree"], draft.scope, (scope) => set("scope", scope))}
      </div>
      {refused("scope")}
      <span className={hint}>Name: lower case, as @name reads it</span>
      <input
        aria-label="Name"
        value={draft.name}
        onChange={(event) => set("name", event.target.value)}
        placeholder="db"
        className={field}
      />
      {refused("name")}
      {draft.kind === "preset" ? (
        <>
          <span className={hint}>
            Preset and its version, an image tag that starts with its major
          </span>
          <div className="flex flex-wrap items-center gap-2">
            {choices("Preset", PRESETS, draft.preset, (preset) => set("preset", preset))}
            <input
              aria-label="Version"
              value={draft.version}
              onChange={(event) => set("version", event.target.value)}
              placeholder="17"
              className={`${field} w-32`}
            />
          </div>
          {refused("version")}
        </>
      ) : (
        <>
          <span className={hint}>Image</span>
          <input
            aria-label="Image"
            value={draft.image}
            onChange={(event) => set("image", event.target.value)}
            placeholder="axllent/mailpit:v1.21"
            className={field}
          />
          {refused("image")}
          <span className={hint}>Ports, one per line: name=port, or name=port/udp</span>
          <textarea
            aria-label="Ports"
            rows={2}
            value={draft.ports}
            onChange={(event) => set("ports", event.target.value)}
            placeholder={"smtp=1025\nhttp=8025"}
            className={field}
          />
          {refused("ports")}
          <span className={hint}>Volumes, one per line: name=/mount/path</span>
          <textarea
            aria-label="Volumes"
            rows={2}
            value={draft.volumes}
            onChange={(event) => set("volumes", event.target.value)}
            placeholder="data=/data"
            className={field}
          />
          {refused("volumes")}
          <span className={hint}>Env: a literal value, or a project secret by its name</span>
          {draft.env.map((row, index) => {
            const change = (next: Partial<typeof row>) =>
              set(
                "env",
                draft.env.map((each, at) => (at === index ? { ...each, ...next } : each)),
              );
            return (
              <div key={index} className="flex flex-wrap items-center gap-1.5">
                <input
                  aria-label="Env name"
                  value={row.key}
                  onChange={(event) => change({ key: event.target.value })}
                  placeholder="NAME"
                  className={`${field} w-36`}
                />
                {choices("Env value from", ["literal", "secret"], row.from, (from) =>
                  change({ from }),
                )}
                <input
                  aria-label={row.from === "secret" ? "Project secret name" : "Env value"}
                  value={row.value}
                  onChange={(event) => change({ value: event.target.value })}
                  placeholder={row.from === "secret" ? "project secret's name" : "value"}
                  className={`${field} min-w-0 flex-1`}
                />
                <button
                  type="button"
                  aria-label={`Remove env ${row.key === "" ? "row" : row.key}`}
                  onClick={() =>
                    set(
                      "env",
                      draft.env.filter((_, at) => at !== index),
                    )
                  }
                  className={`${quiet} hover:text-danger`}
                >
                  remove
                </button>
              </div>
            );
          })}
          <button
            type="button"
            onClick={() => set("env", [...draft.env, { key: "", from: "literal", value: "" }])}
            className={`${quiet} self-start`}
          >
            + env
          </button>
          {refused("env")}
        </>
      )}
      {refused(null)}
      {props.note === undefined ? null : (
        <div className="border-l-2 border-[var(--sw-red)] pl-2">
          {props.note.lines.map((line) => (
            <p key={line} className="font-mono text-[11px] text-danger">
              {line}
            </p>
          ))}
        </div>
      )}
      <div className="flex items-center justify-end gap-2.5">
        <button type="button" onClick={props.onCancel} className={quiet}>
          cancel
        </button>
        <button
          type="submit"
          disabled={props.busy}
          className="rounded-xl border border-border bg-card px-3 py-1.5 font-mono text-xs text-foreground shadow-xs transition-transform hover:-translate-y-0.5 disabled:opacity-50"
        >
          {props.busy ? "proposing…" : "propose"}
        </button>
      </div>
    </form>
  );
}
