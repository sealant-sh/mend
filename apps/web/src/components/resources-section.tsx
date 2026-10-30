import type { WorktreeId } from "@mend/domain";
import {
  choicesFor,
  type ResourceApprovalRequest,
  type ResourceDefinitionInput,
  type ResourceRefusal,
  resourceProposalNotices,
  resourceRuntimeRefusal,
  type WorktreeChoice,
} from "@mend/domain/workbench";
import { Button } from "@mend/ui/components/ui/button";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";

import {
  approvalRequest,
  approveResource,
  awaitsApproval,
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
  type ResourcesPageView,
  type ResourceSettingView,
  reviewFields,
  sameAsSettings,
  withdrawResourceProposal,
} from "#/lib/resources";
import { useTRPC } from "#/lib/trpc";

/**
 * A project's resources in its setup (ADR 0019): definitions settings hold, members' proposals,
 * and a chosen worktree's `mend.toml` tables, each on the one status line the server sends. Every
 * control appears only where the page's flags allow the act; the server decides it again.
 */

/** What answered an act on one item: the server's lines, and whether a reload helps. */
export interface ItemNote {
  readonly refused: boolean;
  readonly lines: ReadonlyArray<string>;
  readonly reload: boolean;
}

export interface Confirming {
  readonly key: string;
  readonly spec: ResourceDefinitionInput;
  readonly digest: string;
  readonly request: ResourceApprovalRequest;
}

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

/** A refused write, in the server's words; a read that changed since is offered a reload. */
const refusedNote = (outcome: { readonly kind: string; readonly message: string }): ItemNote => ({
  refused: true,
  lines: [outcome.message],
  reload: outcome.kind === "stale",
});

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function ResourcesSection({ projectId }: { readonly projectId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [worktreeId, setWorktreeId] = useState<WorktreeId | null>(null);
  const worktrees = useQuery(trpc.worktrees.list.queryOptions({ projectId })).data?.worktrees ?? [];
  const listOptions = trpc.resources.list.queryOptions({
    projectId,
    timeZone: readerZone(),
    worktreeId,
  });
  const page = useQuery({ ...listOptions, placeholderData: keepPreviousData }).data;
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<ReadonlyMap<string, ItemNote>>(new Map());
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const [draft, setDraft] = useState<ProposalDraft | null>(null);
  const [formRefusals, setFormRefusals] = useState<ReadonlyArray<ResourceRefusal>>([]);

  const note = (key: string, value: ItemNote | null) =>
    setNotes((current) => {
      const next = new Map(current);
      if (value === null) next.delete(key);
      else next.set(key, value);
      return next;
    });
  const reload = () => {
    setNotes(new Map());
    setConfirming(null);
    return queryClient.invalidateQueries(trpc.resources.pathFilter());
  };
  /** One act on one item: its answer lands as that item's note. */
  const act = (key: string, run: () => Promise<ItemNote | null>) => {
    setBusy(key);
    note(key, null);
    void run()
      .then((answered) => note(key, answered))
      .catch((error: unknown) =>
        note(key, { refused: true, lines: [message(error)], reload: false }),
      )
      .finally(() => setBusy(null));
  };

  const handlers: ResourceHandlers = {
    withdraw: (entry) =>
      act(`p:${entry.id}`, async () => {
        const outcome = await withdrawResourceProposal(projectId, entry.id);
        if (!outcome.ok) {
          return {
            refused: true,
            lines: [`@${entry.spec.name} · this proposal is gone since you read it`],
            reload: true,
          };
        }
        await reload();
        return null;
      }),
    remove: (entry) =>
      act(`s:${entry.id}`, async () => {
        const outcome = await removeResourceDefinition(projectId, entry);
        if (!outcome.ok) return refusedNote(outcome);
        await reload();
        return null;
      }),
    confirm: setConfirming,
    approve: (pending) =>
      act(pending.key, async () => {
        const outcome = await approveResource(projectId, pending.request);
        setConfirming(null);
        if (!outcome.ok) return refusedNote(outcome);
        const { definition, image, resolvedBy } = outcome.result;
        await queryClient.invalidateQueries(trpc.resources.pathFilter());
        // A proposal or a file table approved is now the definition settings hold.
        note(`s:${definition.id}`, {
          refused: false,
          lines: [`image ${image}${resolvedBy === null ? "" : ` · digest from ${resolvedBy}`}`],
          reload: false,
        });
        return null;
      }),
    choose: (entry, mode) => {
      if (worktreeId === null) return;
      act(`s:${entry.id}`, async () => {
        const outcome = await chooseResource(projectId, worktreeId, entry.id, mode);
        if (!outcome.ok) return refusedNote(outcome);
        const { statusLine } = outcome.result;
        queryClient.setQueryData(listOptions.queryKey, (current) =>
          current === undefined
            ? current
            : {
                ...current,
                settings: current.settings.map((each) =>
                  each.id === entry.id
                    ? { ...each, choice: outcome.result.mode, statusLine }
                    : each,
                ),
              },
        );
        return null;
      });
    },
    reload: () => void reload(),
  };

  const propose = (current: ProposalDraft) => {
    const checked = proposalOf(current);
    if (!checked.ok) return setFormRefusals(checked.refusals);
    setBusy("propose");
    setFormRefusals([]);
    void proposeResource(projectId, checked.proposal)
      .then(async (outcome) => {
        if (!outcome.ok) {
          return setFormRefusals(
            outcome.kind === "rejected"
              ? outcome.refusals
              : [{ key: "proposal", message: outcome.message }],
          );
        }
        setDraft(null);
        await reload();
        return note(`p:${outcome.result.id}`, {
          refused: false,
          lines: ["Proposed. A manager approves it here."],
          reload: false,
        });
      })
      .catch((error: unknown) => setFormRefusals([{ key: "proposal", message: message(error) }]))
      .finally(() => setBusy(null));
  };

  const worktreeName = worktrees.find((each) => each.id === worktreeId)?.name ?? null;
  return (
    <section id="resources" className="project-setup-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2 className="font-sans text-sm font-semibold">Resources</h2>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          read for worktree
          <select
            value={worktreeId ?? ""}
            onChange={(event) => {
              const chosen = worktrees.find((each) => each.id === event.target.value);
              setWorktreeId(chosen?.id ?? null);
              setNotes(new Map());
              setConfirming(null);
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
      </div>
      <p className="mt-2.5 max-w-[64ch] text-xs leading-relaxed text-muted-foreground">
        Long-running services for the project or for one worktree, such as a database or a mail
        catcher. Any member proposes one, the project&apos;s creator or an organization owner
        approves it, and a worktree&apos;s change owner chooses how that worktree uses it. Approving
        pins the image; nothing starts until a runtime runs resources.
      </p>
      {page === undefined ? (
        <p className="mt-4 font-mono text-[11px] text-faint">reading resources…</p>
      ) : (
        <ResourcesView
          page={page}
          worktreeId={worktreeId}
          worktreeName={worktreeName}
          busy={busy}
          notes={notes}
          confirming={confirming}
          handlers={handlers}
        />
      )}
      {page?.canPropose !== true ? null : draft === null ? (
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
          busy={busy === "propose"}
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

export interface ResourceHandlers {
  readonly withdraw: (entry: ResourcesPageView["proposals"][number]) => void;
  readonly remove: (entry: ResourceSettingView) => void;
  readonly confirm: (pending: Confirming | null) => void;
  readonly approve: (pending: Confirming) => void;
  readonly choose: (entry: ResourceSettingView, mode: WorktreeChoice) => void;
  readonly reload: () => void;
}

export interface ResourcesViewProps {
  readonly page: ResourcesPageView;
  readonly worktreeId: WorktreeId | null;
  readonly worktreeName: string | null;
  readonly busy: string | null;
  readonly notes: ReadonlyMap<string, ItemNote>;
  readonly confirming: Confirming | null;
  readonly handlers: ResourceHandlers;
}

/** The lists, each item with its line, its image and the acts its flags allow. */
export function ResourcesView(props: ResourcesViewProps) {
  const { page, worktreeId, worktreeName, busy, handlers } = props;
  const forLabel = (spec: ResourceDefinitionInput) =>
    spec.scope === "worktree" && worktreeName !== null
      ? `for worktree ${worktreeName}`
      : "for the project";
  const approveAction = (
    key: string,
    spec: ResourceDefinitionInput,
    digest: string,
    request: ResourceApprovalRequest,
  ) => (
    <button
      type="button"
      disabled={busy !== null}
      onClick={() => handlers.confirm({ key, spec, digest, request })}
      className={quiet}
    >
      approve {forLabel(spec)}…
    </button>
  );
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
      {props.confirming?.key === key ? (
        <ApprovalReview
          pending={props.confirming}
          forLabel={forLabel(spec)}
          busy={busy === key}
          onCancel={() => handlers.confirm(null)}
          onApprove={handlers.approve}
        />
      ) : null}
    </ResourceItem>
  );
  const { file } = page;
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
            return item(
              key,
              entry.statusLine,
              entry.spec,
              entry.id,
              <>
                {awaitsApproval(entry, worktreeId)
                  ? approveAction(
                      key,
                      entry.spec,
                      entry.digest,
                      approvalRequest(page, { kind: "settings", entry }, worktreeId),
                    )
                  : null}
                {entry.canRemove ? (
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => handlers.remove(entry)}
                    className={`${quiet} hover:text-danger`}
                  >
                    {busy === key ? "working…" : "remove"}
                  </button>
                ) : null}
              </>,
              <>
                {worktreeId === null ? null : (
                  <ChoiceLine
                    entry={entry}
                    worktreeName={worktreeName ?? ""}
                    busy={busy !== null}
                    onChoose={(mode) => handlers.choose(entry, mode)}
                  />
                )}
                {entry.approval === null ? null : (
                  <p className="mt-1.5 font-mono text-[11px] text-muted-foreground">
                    <span className="text-label">start</span>{" "}
                    {resourceRuntimeRefusal(entry.spec.name)}
                  </p>
                )}
              </>,
            );
          })}
        </Group>
      )}
      {page.proposals.length === 0 ? null : (
        <Group label="proposals · not approved">
          {page.proposals.map((entry) => {
            const key = `p:${entry.id}`;
            return item(
              key,
              entry.statusLine,
              entry.spec,
              entry.id,
              <>
                {entry.canApprove && !sameAsSettings(page, entry)
                  ? approveAction(
                      key,
                      entry.spec,
                      entry.digest,
                      approvalRequest(page, { kind: "proposal", entry }, worktreeId),
                    )
                  : null}
                {entry.canRemove ? (
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => handlers.withdraw(entry)}
                    className={`${quiet} hover:text-danger`}
                  >
                    {busy === key ? "working…" : "withdraw"}
                  </button>
                ) : null}
              </>,
            );
          })}
        </Group>
      )}
      {file.kind === "not-selected" ? null : (
        <Group label={`mend.toml in ${worktreeName ?? "this worktree"} · not approved`}>
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
                  entry.canApprove && !sameAsSettings(page, entry)
                    ? approveAction(
                        key,
                        entry.spec,
                        entry.digest,
                        approvalRequest(
                          page,
                          { kind: "file", entry, worktreeId: file.worktreeId },
                          worktreeId,
                        ),
                      )
                    : null,
                );
              })}
              {resourceProposalNotices(file).map((notice) => (
                <p key={notice} className="px-4 py-2 font-mono text-[11px] text-ink-2">
                  {notice}
                </p>
              ))}
              {file.proposals.length === 0 && resourceProposalNotices(file).length === 0 ? (
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
        <div className="flex items-center gap-3">{props.actions}</div>
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

/** The exact definition an approval approves, by its digest, before it is sent. */
export function ApprovalReview(props: {
  readonly pending: Confirming;
  readonly forLabel: string;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onApprove: (pending: Confirming) => void;
}) {
  return (
    <div className="mt-3 rounded-xl bg-sunken p-3">
      <p className="text-xs text-ink-2">
        Approve exactly this definition {props.forLabel}. Mend asks the registry for the
        image&apos;s digest and pins it; nothing starts.
      </p>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-[11px]">
        {reviewFields(props.pending.spec).map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-label">{label}</dt>
            <dd className="break-all text-foreground">{value}</dd>
          </div>
        ))}
        <dt className="text-label">digest</dt>
        <dd className="break-all text-foreground">sha256:{props.pending.digest}</dd>
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
