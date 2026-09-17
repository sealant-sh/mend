import { invitationState } from "@mend/domain/workbench";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

import { formatDay } from "#/components/pairing-qr";
import {
  createFolder,
  createInvitation,
  deleteFolderFile,
  removeFolder,
  removeMember,
  revokeInvitation,
  setMemberRole,
  takeOverProject,
  uploadFolderFiles,
  type AuditEntryDto,
  type FolderDto,
  type InvitationCreatedDto,
  type InvitationDto,
  type OrganizationMemberDto,
  type OrganizationRoleDto,
  type OrganizationViewDto,
  type ProjectDto,
} from "#/lib/api";
import {
  describeAudit,
  formatBytes,
  planUpload,
  stagedPath,
  toBase64,
  type StagedFile,
} from "#/lib/organization";
import { trpcClient, useTRPC } from "#/lib/trpc";

/**
 * The organization in Settings (docs/adr/0003-organizations-and-tenancy.md): who belongs, how
 * people join, the folders sessions mount, projects a departed member left behind, and the audit
 * log. Members read; owners act. Nothing renders for an account in no organization.
 */
export function OrganizationSettings() {
  const trpc = useTRPC();
  const current = useQuery(trpc.organization.current.queryOptions(undefined, { retry: false }));
  if (current.data === undefined) return null;
  const view = current.data;
  const owner = view.role === "owner";
  return (
    <>
      <MembersPanel view={view} />
      {owner ? <InvitationsPanel /> : null}
      <FoldersPanel view={view} />
      {owner ? <OrphanedProjectsPanel /> : null}
      {owner ? <AuditPanel /> : null}
    </>
  );
}

const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

function Panel({
  id,
  title,
  description,
  action,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly description: ReactNode;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section id={id} className="rounded-2xl bg-panel p-6 shadow-[var(--shadow-sm)]">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-sans text-sm font-semibold">{title}</h2>
          <p className="mt-1 max-w-[62ch] text-[13px] leading-relaxed text-muted-foreground">
            {description}
          </p>
        </div>
        {action === undefined ? null : <div className="shrink-0">{action}</div>}
      </div>
      <div className="mt-5 space-y-4 border-t border-[var(--sw-faint-rule)] pt-5">{children}</div>
    </section>
  );
}

function QuietButton({
  children,
  onClick,
  danger = false,
  disabled = false,
}: {
  readonly children: ReactNode;
  readonly onClick: () => void;
  readonly danger?: boolean;
  readonly disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`shrink-0 font-sans text-xs font-medium transition-colors disabled:opacity-50 ${
        danger ? "text-danger hover:opacity-80" : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

const PRIMARY =
  "rounded-xl bg-primary px-3.5 py-1.5 font-sans text-xs font-medium text-primary-foreground shadow-[var(--shadow-cobalt)] transition-transform hover:-translate-y-0.5 disabled:opacity-50";

function ErrorLine({ error }: { readonly error: string | null }) {
  return error === null ? null : (
    <p
      role="alert"
      className="border-l-2 border-[var(--sw-red)] pl-3 text-[13px] leading-relaxed text-danger"
    >
      {error}
    </p>
  );
}

function Empty({ children }: { readonly children: string }) {
  return <p className="font-mono text-[12px] text-label">{children}</p>;
}

// ─── Members ────────────────────────────────────────────────────────────────

/** What removing someone does, stated before it happens. */
export const REMOVAL_FACTS = [
  "Their live sessions are checkpointed, then stopped.",
  "Their private projects stay in the organization, hidden. An owner can take one over below.",
  "The account is deactivated and its devices signed out. Links already handed out keep their remaining lifetime.",
] as const;

export function RemovalConfirmation({
  member,
  organizationName,
  self,
  pending,
  onConfirm,
  onCancel,
}: {
  readonly member: Pick<OrganizationMemberDto, "userId" | "name">;
  readonly organizationName: string;
  readonly self: boolean;
  readonly pending: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  const headingId = `remove-${member.userId}`;
  return (
    <div
      role="group"
      aria-labelledby={headingId}
      className="mt-3 rounded-xl bg-sunken p-4 text-[13px] leading-relaxed"
    >
      <p id={headingId} className="font-medium text-foreground">
        {self ? `Leave ${organizationName}?` : `Remove ${member.name}?`}
      </p>
      <ul className="mt-2 space-y-1 text-muted-foreground">
        {REMOVAL_FACTS.map((fact) => (
          <li key={fact}>{fact}</li>
        ))}
      </ul>
      <div className="mt-3 flex items-center gap-4">
        <QuietButton danger disabled={pending} onClick={onConfirm}>
          {pending
            ? self
              ? "Leaving…"
              : "Removing…"
            : self
              ? `Leave ${organizationName}`
              : `Remove ${member.name}`}
        </QuietButton>
        <QuietButton onClick={onCancel}>Cancel</QuietButton>
      </div>
    </div>
  );
}

function MembersPanel({ view }: { readonly view: OrganizationViewDto }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const members = useQuery(trpc.organization.members.queryOptions()).data ?? [];
  const [confirming, setConfirming] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const owner = view.role === "owner";
  const refresh = () => queryClient.invalidateQueries(trpc.organization.pathFilter());

  const act = (userId: string, work: () => Promise<unknown>, after?: () => void) => {
    setPending(userId);
    setError(null);
    void work()
      .then(() => {
        setConfirming(null);
        after?.();
        return refresh();
      })
      .catch((cause: unknown) => setError(describe(cause)))
      .finally(() => setPending(null));
  };

  return (
    <Panel
      id="members"
      title="Members"
      description="Everyone here sees the organization's shared projects and their own private ones. Owners also invite and remove people, change roles, and manage folders and references. An organization keeps at least one owner."
    >
      {members.map((member) => {
        const self = member.userId === view.userId;
        return (
          <div key={member.userId}>
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="font-sans text-sm font-medium text-foreground">
                  {member.name}
                  {self ? <span className="ml-2 font-mono text-[12px] text-label">you</span> : null}
                </p>
                <p className="mt-1 font-mono text-[12px] text-label">
                  {member.email} · {member.role} · joined {formatDay(member.joinedAt.toISOString())}
                </p>
              </div>
              {owner && confirming !== member.userId ? (
                <div className="flex shrink-0 items-center gap-4">
                  <QuietButton
                    disabled={pending === member.userId}
                    onClick={() =>
                      act(member.userId, () =>
                        setMemberRole(member.userId, member.role === "owner" ? "member" : "owner"),
                      )
                    }
                  >
                    {member.role === "owner" ? "Make member" : "Make owner"}
                  </QuietButton>
                  <QuietButton onClick={() => setConfirming(member.userId)}>
                    {self ? "Leave…" : "Remove…"}
                  </QuietButton>
                </div>
              ) : null}
            </div>
            {confirming === member.userId ? (
              <RemovalConfirmation
                member={member}
                organizationName={view.organization.name}
                self={self}
                pending={pending === member.userId}
                onCancel={() => setConfirming(null)}
                onConfirm={() =>
                  act(
                    member.userId,
                    () => removeMember(member.userId),
                    self ? () => window.location.assign("/login?reason=access") : undefined,
                  )
                }
              />
            ) : null}
          </div>
        );
      })}
      <ErrorLine error={error} />
    </Panel>
  );
}

// ─── Invitations ────────────────────────────────────────────────────────────

function RolePicker({
  value,
  onChange,
}: {
  readonly value: OrganizationRoleDto;
  readonly onChange: (role: OrganizationRoleDto) => void;
}) {
  return (
    <div role="group" aria-label="Role" className="flex rounded-lg bg-wash p-0.5">
      {(["member", "owner"] as const).map((role) => (
        <button
          key={role}
          type="button"
          aria-pressed={value === role}
          onClick={() => onChange(role)}
          className={`rounded-md px-2.5 py-1 font-sans text-xs font-medium transition-colors ${
            value === role
              ? "bg-panel text-foreground shadow-[var(--shadow-xs)]"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {role}
        </button>
      ))}
    </div>
  );
}

function OneTimeLink({
  link,
  expiresAt,
  onDone,
}: {
  readonly link: string;
  readonly expiresAt: Date;
  readonly onDone: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-xl bg-sunken p-4">
      <p className="text-[13px] text-muted-foreground">
        Copy it now. The link is not shown again. It works once and expires{" "}
        {formatDay(expiresAt.toISOString())}.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <code className="min-w-0 flex-1 basis-64 truncate font-mono text-[12px] text-foreground">
          {link}
        </code>
        <QuietButton
          onClick={() => void navigator.clipboard.writeText(link).then(() => setCopied(true))}
        >
          Copy
        </QuietButton>
        <span aria-live="polite" className="font-mono text-[12px] text-label">
          {copied ? "Copied" : ""}
        </span>
        <QuietButton onClick={onDone}>Done</QuietButton>
      </div>
    </div>
  );
}

function InvitationsPanel() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const invitations = useQuery(trpc.organization.invitations.queryOptions()).data ?? [];
  const [role, setRole] = useState<OrganizationRoleDto>("member");
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [minted, setMinted] = useState<InvitationCreatedDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = new Date();
  const refresh = () => queryClient.invalidateQueries(trpc.organization.invitations.pathFilter());

  const mint = () => {
    setPending(true);
    setError(null);
    void createInvitation({ role, ...(email.trim() === "" ? {} : { email: email.trim() }) })
      .then((created) => {
        setMinted(created);
        setEmail("");
        return refresh();
      })
      .catch((cause: unknown) => setError(describe(cause)))
      .finally(() => setPending(false));
  };

  const revoke = (invitation: InvitationDto) => {
    setError(null);
    void revokeInvitation(invitation.id)
      .then(refresh)
      .catch((cause: unknown) => setError(describe(cause)));
  };

  const open = invitations.filter((invitation) => invitationState(invitation, now) === "open");
  const spent = invitations.filter((invitation) => invitationState(invitation, now) !== "open");

  return (
    <Panel
      id="invitations"
      title="Invitations"
      description="A link works once and expires after seven days. Whoever opens it creates an account and joins with the role you pick. Bind it to an email when it must not be forwarded. Mend sends no email; you share the link."
    >
      <form
        className="flex flex-wrap items-center gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          mint();
        }}
      >
        <input
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
            setError(null);
          }}
          aria-label="Bind the link to an email (optional)"
          placeholder="email (optional)"
          className="w-full min-w-0 flex-1 basis-64 rounded-lg border border-input bg-background px-3 py-2 font-mono text-xs text-foreground placeholder:text-faint"
        />
        <RolePicker value={role} onChange={setRole} />
        <button type="submit" disabled={pending} className={PRIMARY}>
          {pending ? "Creating…" : "New link"}
        </button>
      </form>
      {minted === null ? null : (
        <OneTimeLink
          link={`${window.location.origin}${minted.path}`}
          expiresAt={minted.invitation.expiresAt}
          onDone={() => setMinted(null)}
        />
      )}
      {open.length === 0 ? (
        <Empty>no open invitations</Empty>
      ) : (
        open.map((invitation) => (
          <div key={invitation.id} className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="font-sans text-sm font-medium text-foreground">
                {invitation.email ?? "anyone with the link"}
              </p>
              <p className="mt-1 font-mono text-[12px] text-label">
                {invitation.role} · created {formatDay(invitation.createdAt.toISOString())} ·
                expires {formatDay(invitation.expiresAt.toISOString())}
              </p>
            </div>
            <QuietButton onClick={() => revoke(invitation)}>Revoke</QuietButton>
          </div>
        ))
      )}
      {spent.length === 0 ? null : (
        <details>
          <summary className="cursor-pointer font-mono text-[12px] text-label">
            {spent.length} spent
          </summary>
          <div className="mt-3 space-y-2">
            {spent.map((invitation) => (
              <p key={invitation.id} className="font-mono text-[12px] text-faint">
                {invitation.email ?? "anyone"} · {invitation.role} ·{" "}
                {invitationState(invitation, now)}
              </p>
            ))}
          </div>
        </details>
      )}
      <ErrorLine error={error} />
    </Panel>
  );
}

// ─── Folders ────────────────────────────────────────────────────────────────

function FoldersPanel({ view }: { readonly view: OrganizationViewDto }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const folders = useQuery(trpc.folders.list.queryOptions()).data ?? [];
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const owner = view.role === "owner";

  const create = () => {
    setPending(true);
    setError(null);
    void createFolder(name.trim())
      .then(() => {
        setName("");
        return queryClient.invalidateQueries(trpc.folders.pathFilter());
      })
      .catch((cause: unknown) => setError(describe(cause)))
      .finally(() => setPending(false));
  };

  return (
    <Panel
      id="folders"
      title="Folders"
      description={
        <>
          Directories Mend keeps for this organization: reading material, fixtures, anything an
          agent should see beside the worktree. A project mounts a folder at{" "}
          <span className="font-mono text-[12px]">/workspace/home/&lt;name&gt;</span> for its next
          sessions, read-only unless chosen otherwise.
          {view.mountDelivery === "none"
            ? " This deployment records folder selections but does not mount them into captured workspaces yet."
            : ""}
        </>
      }
    >
      {owner ? (
        <form
          className="flex flex-wrap items-center gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            create();
          }}
        >
          <input
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setError(null);
            }}
            aria-label="Folder name"
            placeholder="name"
            className="w-full min-w-0 flex-1 basis-48 rounded-lg border border-input bg-background px-3 py-2 font-mono text-xs text-foreground placeholder:text-faint"
          />
          <button type="submit" disabled={pending || name.trim() === ""} className={PRIMARY}>
            {pending ? "Creating…" : "New folder"}
          </button>
        </form>
      ) : null}
      {folders.length === 0 ? (
        <Empty>no folders yet</Empty>
      ) : (
        folders.map((folder) => <FolderRow key={folder.id} folder={folder} owner={owner} />)
      )}
      <ErrorLine error={error} />
    </Panel>
  );
}

function FolderRow({ folder, owner }: { readonly folder: FolderDto; readonly owner: boolean }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries(trpc.folders.pathFilter());

  const remove = () => {
    setError(null);
    void removeFolder(folder.id)
      .then(refresh)
      .catch((cause: unknown) => {
        setConfirming(false);
        setError(describe(cause));
      });
  };

  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="min-w-0 text-left"
        >
          <p className="font-mono text-[13px] font-medium text-foreground">{folder.name}</p>
          <p className="mt-1 font-mono text-[12px] text-label">
            created {formatDay(folder.createdAt.toISOString())} · {open ? "hide files" : "files"}
          </p>
        </button>
        {owner ? (
          confirming ? (
            <div className="flex shrink-0 items-center gap-4">
              <QuietButton danger onClick={remove}>
                Remove {folder.name}
              </QuietButton>
              <QuietButton onClick={() => setConfirming(false)}>Cancel</QuietButton>
            </div>
          ) : (
            <QuietButton onClick={() => setConfirming(true)}>Remove…</QuietButton>
          )
        ) : null}
      </div>
      {open ? <FolderFiles folder={folder} owner={owner} /> : null}
      <ErrorLine error={error} />
    </div>
  );
}

/** Picked files by path and size; nothing is read until the plan accepts it. */
const stagePicked = (picked: FileList): ReadonlyArray<StagedFile & { readonly file: File }> =>
  [...picked].map((file) => ({ path: stagedPath(file), size: file.size, file }));

function FolderFiles({ folder, owner }: { readonly folder: FolderDto; readonly owner: boolean }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const listing = useQuery(trpc.folders.files.queryOptions({ id: folder.id }));
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => queryClient.invalidateQueries(trpc.folders.files.pathFilter());

  const upload = (picked: FileList | null) => {
    if (picked === null || picked.length === 0) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    void (async () => {
      const plan = planUpload(stagePicked(picked));
      let sent = 0;
      for (const batch of plan.batches) {
        const files = await Promise.all(
          batch.map(async (staged) => ({
            path: staged.path,
            contentsBase64: toBase64(new Uint8Array(await staged.file.arrayBuffer())),
          })),
        );
        await uploadFolderFiles(folder.id, files, true);
        sent += batch.length;
      }
      const skipped = plan.rejected.length;
      setStatus(
        `added ${sent} ${sent === 1 ? "file" : "files"}${skipped === 0 ? "" : ` · ${skipped} left out (${[...new Set(plan.rejected.map((entry) => entry.reason))].join(", ")})`}`,
      );
      await refresh();
    })()
      .catch((cause: unknown) => setError(describe(cause)))
      .finally(() => setBusy(false));
  };

  const remove = (path: string) => {
    setError(null);
    void deleteFolderFile(folder.id, path)
      .then(refresh)
      .catch((cause: unknown) => setError(describe(cause)));
  };

  const files = listing.data?.files ?? [];
  return (
    <div className="mt-3 space-y-2 rounded-xl bg-sunken p-4">
      {listing.isPending ? (
        <Empty>reading…</Empty>
      ) : files.length === 0 ? (
        <Empty>empty</Empty>
      ) : (
        files.map((file) => (
          <div key={file.path} className="flex items-baseline justify-between gap-4">
            <span className="min-w-0 break-all font-mono text-[12px] text-ink-2">
              {file.path} · {formatBytes(file.bytes)}
            </span>
            {owner ? <QuietButton onClick={() => remove(file.path)}>Delete</QuietButton> : null}
          </div>
        ))
      )}
      {listing.data?.truncated === true ? <Empty>listing truncated</Empty> : null}
      {owner ? (
        <div className="flex flex-wrap items-center gap-4 pt-2">
          <label className="cursor-pointer font-sans text-xs font-medium text-info hover:underline">
            {busy ? "Uploading…" : "Add files…"}
            <input
              type="file"
              multiple
              className="hidden"
              disabled={busy}
              onChange={(event) => upload(event.target.files)}
            />
          </label>
          <label className="cursor-pointer font-sans text-xs font-medium text-info hover:underline">
            Add a folder…
            <input
              type="file"
              multiple
              className="hidden"
              disabled={busy}
              ref={(node) => node?.setAttribute("webkitdirectory", "")}
              onChange={(event) => upload(event.target.files)}
            />
          </label>
          {status === null ? null : (
            <span className="font-mono text-[12px] text-label" aria-live="polite">
              {status}
            </span>
          )}
        </div>
      ) : null}
      <ErrorLine error={error} />
    </div>
  );
}

// ─── Projects a departed member left ────────────────────────────────────────

function OrphanedProjectsPanel() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const orphaned = useQuery(trpc.organization.orphanedProjects.queryOptions()).data ?? [];
  const [confirming, setConfirming] = useState<ProjectDto["id"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (orphaned.length === 0) return null;

  const take = (id: ProjectDto["id"]) => {
    setError(null);
    void takeOverProject(id)
      .then(() => {
        setConfirming(null);
        return Promise.all([
          queryClient.invalidateQueries(trpc.organization.pathFilter()),
          queryClient.invalidateQueries(trpc.projects.pathFilter()),
        ]);
      })
      .catch((cause: unknown) => setError(describe(cause)));
  };

  return (
    <Panel
      id="departed-projects"
      title="Projects without a creator"
      description="Projects whose creator is no longer a member. A private one stays hidden from everyone until an owner takes it over; taking over makes you its creator and is recorded in the audit log."
    >
      {orphaned.map((project) => (
        <div key={project.id} className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="font-sans text-sm font-medium text-foreground">{project.name}</p>
            <p className="mt-1 font-mono text-[12px] text-label">
              {project.visibility} · adopted {formatDay(project.createdAt.toISOString())}
            </p>
          </div>
          {confirming === project.id ? (
            <div className="flex shrink-0 items-center gap-4">
              <QuietButton onClick={() => take(project.id)}>Take over {project.name}</QuietButton>
              <QuietButton onClick={() => setConfirming(null)}>Cancel</QuietButton>
            </div>
          ) : (
            <QuietButton onClick={() => setConfirming(project.id)}>Take over…</QuietButton>
          )}
        </div>
      ))}
      <ErrorLine error={error} />
    </Panel>
  );
}

// ─── Audit log ──────────────────────────────────────────────────────────────

/** The server's default audit page size: a shorter page is the last one. */
const AUDIT_PAGE_SIZE = 50;

const formatMoment = (at: Date): string =>
  at.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

function AuditPanel() {
  const trpc = useTRPC();
  const first = useQuery(trpc.organization.audit.queryOptions({}));
  // Earlier pages continue from the first page they were loaded after; when that page refreshes
  // (a live event), they are dropped instead of leaving a gap between the two.
  const [earlier, setEarlier] = useState<{
    readonly after: number;
    readonly entries: ReadonlyArray<AuditEntryDto>;
    readonly exhausted: boolean;
  }>({ after: 0, entries: [], exhausted: false });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = earlier.after === first.dataUpdatedAt ? earlier : null;
  const entries = [...(first.data ?? []), ...(current?.entries ?? [])];
  const exhausted =
    current?.exhausted ?? (first.data !== undefined && first.data.length < AUDIT_PAGE_SIZE);

  const loadEarlier = () => {
    const last = entries.at(-1);
    if (last === undefined) return;
    setLoading(true);
    setError(null);
    void trpcClient.organization.audit
      .query({ before: last.event.id })
      .then((page) => {
        setEarlier({
          after: first.dataUpdatedAt,
          entries: [...(current?.entries ?? []), ...page],
          exhausted: page.length < AUDIT_PAGE_SIZE,
        });
        return page;
      })
      .catch((cause: unknown) => setError(describe(cause)))
      .finally(() => setLoading(false));
  };

  return (
    <Panel
      id="audit"
      title="Audit log"
      description="Changes to who belongs, who sees what, and what the organization shares, newest first. Kept indefinitely."
    >
      {entries.length === 0 ? (
        <Empty>{first.isPending ? "reading…" : "nothing recorded yet"}</Empty>
      ) : (
        <ol className="space-y-2">
          {entries.map((entry) => (
            <li key={entry.event.id} className="text-[13px] leading-relaxed">
              <span className="font-mono text-[12px] text-label">
                {formatMoment(entry.event.createdAt)}
              </span>{" "}
              <span className="font-medium text-foreground">{entry.actorName}</span>{" "}
              <span className="text-ink-2">{describeAudit(entry)}</span>
            </li>
          ))}
        </ol>
      )}
      {entries.length > 0 && !exhausted ? (
        <QuietButton disabled={loading} onClick={loadEarlier}>
          {loading ? "Loading…" : "Load earlier"}
        </QuietButton>
      ) : null}
      <ErrorLine error={error} />
    </Panel>
  );
}
