import { teamInviteState, teamNameIssue } from "@mend/domain/workbench";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { formatDay } from "#/components/pairing-qr";
import {
  addTeamMember,
  createTeamInvite,
  removeTeam,
  removeTeamMember,
  renameTeam,
  revokeTeamInvite,
  setTeamRole,
  type TeamDetailDto,
  type TeamInviteCreatedDto,
  type TeamInviteDto,
  type TeamMemberDto,
  type TeamRoleDto,
} from "#/lib/api";
import { useTRPC } from "#/lib/trpc";

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/**
 * One team, opened: the roster, the invite links, the projects scoped to it. Owners see the
 * controls; members see the facts and their own way out. Every destructive action confirms in
 * place — never a dialog — the way Settings → Devices does.
 */
export function TeamHeader({
  detail,
  currentUserId,
}: {
  readonly detail: TeamDetailDto;
  readonly currentUserId: string | null;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const isOwner = detail.role === "owner";
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(detail.team.name);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<"idle" | "armed" | "working">("idle");

  const invalidate = () => queryClient.invalidateQueries(trpc.teams.pathFilter());

  const saveName = async () => {
    const issue = teamNameIssue(name);
    if (issue !== null) {
      setError(issue);
      return;
    }
    try {
      await renameTeam(detail.team.id, name.trim());
      await invalidate();
      setEditing(false);
      setError(null);
    } catch (cause) {
      setError(describe(cause));
    }
  };

  const remove = () => {
    if (removing === "idle") {
      setRemoving("armed");
      return;
    }
    if (removing !== "armed") return;
    setRemoving("working");
    void removeTeam(detail.team.id)
      .then(async () => {
        await queryClient.invalidateQueries();
        return navigate({ to: "/teams" });
      })
      .catch((cause: unknown) => {
        setError(describe(cause));
        setRemoving("idle");
      });
  };

  const seat = detail.members.find((member) => member.userId === currentUserId);

  return (
    <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
      <div className="min-w-0">
        <p className="ev-eyebrow">team</p>
        {editing ? (
          <form
            className="mt-2 flex flex-wrap items-center gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void saveName();
            }}
          >
            <input
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setError(null);
              }}
              aria-label="Team name"
              className="w-72 max-w-full rounded-lg border border-input bg-background px-3 py-2 font-display text-xl font-medium tracking-tight text-foreground"
            />
            <button
              type="submit"
              className="rounded-xl bg-primary px-3.5 py-1.5 font-sans text-xs font-medium text-primary-foreground shadow-[var(--shadow-cobalt)]"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setName(detail.team.name);
                setError(null);
              }}
              className="font-sans text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
          </form>
        ) : (
          <h1 className="mt-2 font-display text-3xl font-medium tracking-tight text-foreground">
            {detail.team.name}
          </h1>
        )}
        <p className="mt-2 font-mono text-[11.5px] text-faint">
          {detail.members.length} member{detail.members.length === 1 ? "" : "s"} ·{" "}
          {detail.projects.length} project{detail.projects.length === 1 ? "" : "s"} · you are{" "}
          {seat?.role ?? detail.role}
        </p>
        {error !== null && (
          <p role="alert" className="mt-2 font-mono text-[12.5px] text-warning">
            {error}
          </p>
        )}
      </div>
      {isOwner && !editing && (
        <div className="mt-1 flex shrink-0 items-center gap-4">
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="font-sans text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            Rename
          </button>
          <button
            type="button"
            disabled={removing === "working"}
            onClick={remove}
            onBlur={() => setRemoving((current) => (current === "armed" ? "idle" : current))}
            className={`font-sans text-xs font-medium transition-colors disabled:opacity-50 ${
              removing === "armed" ? "text-danger" : "text-muted-foreground hover:text-danger"
            }`}
          >
            {removing === "working"
              ? "Deleting…"
              : removing === "armed"
                ? "Really delete this team?"
                : "Delete team…"}
          </button>
        </div>
      )}
    </div>
  );
}

const ROLE_COPY: Record<TeamRoleDto, string> = {
  owner: "manages members, invites, and the team's projects",
  member: "works in the team's projects",
};

export function MembersPanel({
  detail,
  currentUserId,
}: {
  readonly detail: TeamDetailDto;
  readonly currentUserId: string | null;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const isOwner = detail.role === "owner";
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<TeamRoleDto>("member");
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const invalidate = () => queryClient.invalidateQueries(trpc.teams.pathFilter());

  const add = async () => {
    if (email.trim() === "" || pending) return;
    setPending(true);
    setError(null);
    try {
      await addTeamMember(detail.team.id, email.trim(), role);
      await invalidate();
      setEmail("");
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setPending(false);
    }
  };

  const changeRole = (member: TeamMemberDto, next: TeamRoleDto) => {
    setError(null);
    void setTeamRole(detail.team.id, member.userId, next)
      .then(invalidate)
      .catch((cause: unknown) => setError(describe(cause)));
  };

  const remove = (member: TeamMemberDto) => {
    setError(null);
    const leaving = member.userId === currentUserId;
    void removeTeamMember(detail.team.id, member.userId)
      .then(async () => {
        setConfirming(null);
        await queryClient.invalidateQueries();
        return leaving ? navigate({ to: "/teams" }) : null;
      })
      .catch((cause: unknown) => setError(describe(cause)));
  };

  return (
    <section id="members" className="rounded-2xl bg-panel p-6 shadow-[var(--shadow-sm)]">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-sans text-sm font-semibold">Members</h2>
          <p className="mt-1 max-w-[58ch] text-[13px] leading-relaxed text-muted-foreground">
            Everyone here sees the team&apos;s projects and works in them. Owners also manage the
            roster and where the projects are visible. A team keeps at least one owner.
          </p>
        </div>
      </div>

      {isOwner && (
        <form
          className="mt-5 flex flex-wrap items-center gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <input
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
              setError(null);
            }}
            aria-label="Email of an account on this Mend"
            placeholder="email of an account on this Mend"
            className="w-full min-w-0 flex-1 basis-64 rounded-lg border border-input bg-background px-3 py-2 font-mono text-xs text-foreground placeholder:text-faint"
          />
          <RolePicker value={role} onChange={setRole} />
          <button
            type="submit"
            disabled={pending || email.trim() === ""}
            className="rounded-xl bg-primary px-3.5 py-1.5 font-sans text-xs font-medium text-primary-foreground shadow-[var(--shadow-cobalt)] transition-transform hover:-translate-y-0.5 disabled:opacity-50"
          >
            {pending ? "Adding…" : "Add"}
          </button>
        </form>
      )}

      <div className="mt-5 space-y-4 border-t border-[var(--sw-faint-rule)] pt-5">
        {detail.members.map((member) => {
          const isSelf = member.userId === currentUserId;
          const canRemove = isOwner || isSelf;
          return (
            <div key={member.userId} className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="font-sans text-sm font-medium text-foreground">
                  {member.name}
                  {isSelf && <span className="ml-2 font-mono text-[11px] text-faint">you</span>}
                </p>
                <p className="mt-1 font-mono text-[12px] text-label">
                  {member.email} · {member.role} · joined {formatDay(member.joinedAt.toISOString())}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                {isOwner && (
                  <button
                    type="button"
                    title={ROLE_COPY[member.role === "owner" ? "member" : "owner"]}
                    onClick={() => changeRole(member, member.role === "owner" ? "member" : "owner")}
                    className="font-sans text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {member.role === "owner" ? "Make member" : "Make owner"}
                  </button>
                )}
                {canRemove &&
                  (confirming === member.userId ? (
                    <>
                      <button
                        type="button"
                        onClick={() => remove(member)}
                        className="font-sans text-xs font-medium text-danger transition-opacity hover:opacity-80"
                      >
                        {isSelf ? "Confirm leave" : "Confirm remove"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirming(null)}
                        className="font-sans text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirming(member.userId)}
                      className="font-sans text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                    >
                      {isSelf ? "Leave" : "Remove"}
                    </button>
                  ))}
              </div>
            </div>
          );
        })}
        {error !== null && (
          <p className="font-mono text-[12.5px] text-warning" role="alert">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}

function RolePicker({
  value,
  onChange,
}: {
  readonly value: TeamRoleDto;
  readonly onChange: (role: TeamRoleDto) => void;
}) {
  return (
    <div className="flex items-center gap-2" role="group" aria-label="Role">
      {(["member", "owner"] as const).map((role) => (
        <button
          key={role}
          type="button"
          aria-pressed={value === role}
          title={ROLE_COPY[role]}
          onClick={() => onChange(role)}
          className={`rounded-lg border px-2 py-1 font-mono text-[11px] transition-colors ${
            value === role
              ? "border-[color-mix(in_oklab,var(--sw-accent)_45%,transparent)] bg-wash text-foreground"
              : "border-border bg-card text-muted-foreground hover:text-foreground"
          }`}
        >
          {role}
        </button>
      ))}
    </div>
  );
}

/** Owners only: the roster's front door for people who are not on this Mend yet. */
export function InvitesPanel({ detail }: { readonly detail: TeamDetailDto }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [role, setRole] = useState<TeamRoleDto>("member");
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [minted, setMinted] = useState<TeamInviteCreatedDto | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = new Date();

  const invalidate = () => queryClient.invalidateQueries(trpc.teams.pathFilter());

  const mint = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const created = await createTeamInvite(detail.team.id, {
        role,
        ...(email.trim() === "" ? {} : { email: email.trim() }),
      });
      setMinted(created);
      setCopied(false);
      setEmail("");
      await invalidate();
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setPending(false);
    }
  };

  const revoke = (invite: TeamInviteDto) => {
    setError(null);
    void revokeTeamInvite(detail.team.id, invite.id)
      .then(invalidate)
      .catch((cause: unknown) => setError(describe(cause)));
  };

  const link = minted === null ? null : `${window.location.origin}${minted.path}`;
  const copy = () => {
    if (link === null) return;
    void navigator.clipboard.writeText(link).then(() => setCopied(true));
  };

  const open = detail.invites.filter((invite) => teamInviteState(invite, now) === "open");
  const spent = detail.invites.filter((invite) => teamInviteState(invite, now) !== "open");

  return (
    <section id="invites" className="rounded-2xl bg-panel p-6 shadow-[var(--shadow-sm)]">
      <div>
        <h2 className="font-sans text-sm font-semibold">Invite links</h2>
        <p className="mt-1 max-w-[58ch] text-[13px] leading-relaxed text-muted-foreground">
          A link works once and expires after seven days. Whoever opens it signs in or registers,
          then takes the seat. Bind it to an email when it must not be forwarded.
        </p>
      </div>

      <form
        className="mt-5 flex flex-wrap items-center gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void mint();
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
        <button
          type="submit"
          disabled={pending}
          className="rounded-xl bg-primary px-3.5 py-1.5 font-sans text-xs font-medium text-primary-foreground shadow-[var(--shadow-cobalt)] transition-transform hover:-translate-y-0.5 disabled:opacity-50"
        >
          {pending ? "Minting…" : "New link"}
        </button>
      </form>

      {minted !== null && link !== null && (
        <div className="mt-4 rounded-xl bg-sunken p-4">
          <p className="text-xs font-medium text-label">
            Copy it now — the link is not shown again.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <code className="min-w-0 flex-1 basis-64 truncate font-mono text-[12px] text-foreground">
              {link}
            </code>
            <button
              type="button"
              onClick={copy}
              className="font-sans text-xs font-medium text-info underline-offset-2 hover:underline"
            >
              {copied ? "Copied" : "Copy"}
            </button>
            <button
              type="button"
              onClick={() => setMinted(null)}
              className="font-sans text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              Done
            </button>
          </div>
        </div>
      )}

      <div className="mt-5 space-y-4 border-t border-[var(--sw-faint-rule)] pt-5">
        {open.length === 0 ? (
          <p className="font-mono text-[12px] text-label">no open invites</p>
        ) : (
          open.map((invite) => (
            <div key={invite.id} className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="font-sans text-sm font-medium text-foreground">
                  {invite.email ?? "anyone with the link"}
                </p>
                <p className="mt-1 font-mono text-[12px] text-label">
                  {invite.role} · minted {formatDay(invite.createdAt.toISOString())} · expires{" "}
                  {formatDay(invite.expiresAt.toISOString())}
                </p>
              </div>
              <button
                type="button"
                onClick={() => revoke(invite)}
                className="shrink-0 font-sans text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                Revoke
              </button>
            </div>
          ))
        )}
        {spent.length > 0 && (
          <details className="pt-1">
            <summary className="cursor-pointer font-mono text-[12px] text-label">
              {spent.length} spent
            </summary>
            <div className="mt-3 space-y-3">
              {spent.map((invite) => (
                <p key={invite.id} className="font-mono text-[12px] text-faint">
                  {invite.email ?? "anyone"} · {invite.role} · {teamInviteState(invite, now)}
                  {invite.acceptedAt !== null
                    ? ` ${formatDay(invite.acceptedAt.toISOString())}`
                    : ""}
                </p>
              ))}
            </div>
          </details>
        )}
        {error !== null && (
          <p className="font-mono text-[12.5px] text-warning" role="alert">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}

export function TeamProjectsPanel({ detail }: { readonly detail: TeamDetailDto }) {
  return (
    <section id="projects" className="rounded-2xl bg-panel p-6 shadow-[var(--shadow-sm)]">
      <div>
        <h2 className="font-sans text-sm font-semibold">Projects</h2>
        <p className="mt-1 max-w-[58ch] text-[13px] leading-relaxed text-muted-foreground">
          Repositories scoped to this team. Adopt into it from Projects, or move an existing project
          here from its Setup page.
        </p>
      </div>
      <div className="mt-5 space-y-3 border-t border-[var(--sw-faint-rule)] pt-5">
        {detail.projects.length === 0 ? (
          <p className="font-mono text-[12px] text-label">no projects yet</p>
        ) : (
          detail.projects.map((project) => (
            <Link
              key={project.id}
              to="/projects/$projectId"
              params={{ projectId: project.id }}
              className="flex items-baseline justify-between gap-4 no-underline"
            >
              <span className="font-sans text-sm font-medium text-foreground">{project.name}</span>
              <span className="truncate font-mono text-[11.5px] text-faint">
                {project.originUrl ?? project.storePath}
              </span>
            </Link>
          ))
        )}
      </div>
    </section>
  );
}
