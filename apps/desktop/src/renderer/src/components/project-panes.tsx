import { Button } from "@mend/ui/components/ui/button";
import { cn } from "@mend/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { StatusDot, toneText } from "#/components/status-dot";
import type {
  ProjectDto,
  ProjectPullRequestsDto,
  PullRequestViewDto,
  ServiceViewDto,
  SessionDto,
} from "#/lib/api";
import { buildFileTree, type FileNode } from "#/lib/files";
import { projectFilesQuery, projectPullRequestsQuery } from "#/lib/queries";
import { serviceGlance } from "#/lib/services";
import { ago, sessionTitle, type Tone } from "#/lib/words";

/**
 * The project sub-views behind the inbox's switcher (BRIEF.md §sidebar):
 * Services, PRs, Files. Each is a list of facts in the rail's own idiom —
 * dot + word, mono values, hairline rows — and each says plainly when it has
 * nothing to show and why. Nothing here is a verdict: a PR is a reference
 * attached to work (plan §5), a file is a path, a Service is what was observed.
 */

function PaneNote({ children }: { readonly children: React.ReactNode }) {
  return <p className="px-4 py-3 font-sans text-[12.5px] leading-relaxed text-label">{children}</p>;
}

function PaneEyebrow({ children, meta }: { readonly children: string; readonly meta?: string }) {
  return (
    <div className="flex items-center gap-2 px-4 pt-2.5 pb-1">
      <span
        className="min-w-0 truncate font-mono text-[10.5px] font-medium tracking-[0.8px] text-label uppercase"
        title={children}
      >
        {children}
      </span>
      <span className="h-px min-w-3 flex-1 bg-[var(--sw-faint-rule)]" />
      {meta !== undefined && <span className="font-mono text-[10.5px] text-faint">{meta}</span>}
    </div>
  );
}

// ─── Services ───────────────────────────────────────────────────────────────

export function ServicesPane({
  project,
  sessions,
  views,
  onOpen,
}: {
  readonly project: ProjectDto;
  readonly sessions: ReadonlyArray<SessionDto>;
  readonly views: ReadonlyArray<ServiceViewDto>;
  /** Focus the owning session and open its Services sheet. */
  readonly onOpen: (sessionId: string) => void;
}) {
  const groups = sessions
    .map((session) => ({
      session,
      glances: views
        .filter((view) => view.service.sessionId === session.id)
        .map((view) => ({ view, glance: serviceGlance(view) })),
    }))
    .filter((group) => group.glances.length > 0);
  const total = groups.reduce((sum, group) => sum + group.glances.length, 0);
  if (total === 0) {
    return (
      <PaneNote>
        no Services in {project.name} — a session declares one in its{" "}
        <span className="font-mono text-[12px] text-foreground">mend.services</span> file or adopts
        a listening port with{" "}
        <span className="font-mono text-[12px] text-foreground">mend service</span>
      </PaneNote>
    );
  }
  return (
    <div className="pb-2">
      {groups.map(({ session, glances }) => (
        <section key={session.id}>
          <PaneEyebrow meta={String(glances.length)}>{sessionTitle(session)}</PaneEyebrow>
          <ul>
            {glances.map(({ view, glance }) => (
              <li key={view.service.id}>
                <button
                  type="button"
                  onClick={() => onOpen(session.id)}
                  className="flex w-full items-center gap-2 py-[5px] pr-3 pl-[26px] text-left transition-colors hover:bg-[var(--sw-sunken)]"
                >
                  <StatusDot
                    tone={glance.tone}
                    size={6}
                    pulse={glance.tone === "accent" && !glance.attention}
                  />
                  <span className="min-w-0 flex-1 truncate font-sans text-[13px] text-ink-2">
                    {glance.name}
                  </span>
                  <span className="shrink-0 font-mono text-[10.5px] text-faint">
                    :{view.service.workspacePort}
                    {view.service.transport === "udp" ? "/udp" : ""}
                  </span>
                  <span
                    className={cn(
                      "shrink-0 truncate font-mono text-[10.5px]",
                      glance.attention ? toneText(glance.tone) : "text-faint",
                    )}
                  >
                    {glance.word}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

// ─── Pull requests ──────────────────────────────────────────────────────────

const prTone = (pr: PullRequestViewDto): Tone =>
  pr.state === "merged"
    ? "green"
    : pr.state === "closed"
      ? "hollow"
      : pr.isDraft
        ? "hollow"
        : "accent";

const prWord = (pr: PullRequestViewDto): string =>
  pr.state === "merged"
    ? "merged"
    : pr.state === "closed"
      ? "closed"
      : pr.isDraft
        ? "draft"
        : "open";

/** GitHub's review word, lower-cased into the rail's voice. */
const reviewWord = (decision: string | null): string | null =>
  decision === "APPROVED"
    ? "approved"
    : decision === "CHANGES_REQUESTED"
      ? "changes requested"
      : decision === "REVIEW_REQUIRED"
        ? "review required"
        : null;

const availabilityNote = (answer: ProjectPullRequestsDto, project: ProjectDto): string => {
  switch (answer.availability) {
    case "ok":
      return answer.pullRequests.length === 0
        ? `no pull requests on ${answer.repo ?? "the repository"}`
        : "";
    case "no-origin":
      return `${project.name} has no origin — it was adopted from a local path or created bare, so there is nowhere to read pull requests from`;
    case "not-github":
      return `${project.name}'s origin is not on GitHub (${project.originUrl ?? ""}); Mend only reads pull requests through gh`;
    case "gh-missing":
      return "gh was not found on this machine — install the GitHub CLI and sign in to read pull requests";
    case "gh-signed-out":
      return "gh is signed out — run gh auth login on this machine";
    case "no-identity":
      return answer.detail ?? "your account has no GitHub identity on this machine yet";
    case "rate-limited":
      return "GitHub rate-limited gh — the list resumes when the window resets";
    case "error":
      return "gh could not answer";
    default:
      return "";
  }
};

export function PullRequestsPane({
  project,
  now,
  branchesBySession,
}: {
  readonly project: ProjectDto;
  readonly now: number;
  /** session branch → session, so a PR whose head is a Mend branch links to its session. */
  readonly branchesBySession: ReadonlyMap<string, SessionDto>;
}) {
  const query = useQuery(projectPullRequestsQuery(project.id));
  if (query.isPending) return <PaneNote>reading pull requests…</PaneNote>;
  if (query.isError) {
    return (
      <PaneNote>
        could not read pull requests — {query.error instanceof Error ? query.error.message : ""}
      </PaneNote>
    );
  }
  const answer = query.data;
  const note = availabilityNote(answer, project);
  const open = answer.pullRequests.filter((pr) => pr.state === "open");
  const settled = answer.pullRequests.filter((pr) => pr.state !== "open");
  return (
    <div className="pb-2">
      {note !== "" && (
        <>
          <PaneNote>{note}</PaneNote>
          {answer.detail !== null && (
            <p className="px-4 pb-2 font-mono text-[10.5px] leading-relaxed break-words text-faint">
              {answer.detail}
            </p>
          )}
        </>
      )}
      {open.length > 0 && (
        <section>
          <PaneEyebrow meta={String(open.length)}>open</PaneEyebrow>
          <ul>
            {open.map((pr) => (
              <PullRequestRow
                key={pr.number}
                pr={pr}
                now={now}
                session={branchesBySession.get(pr.headRefName) ?? null}
              />
            ))}
          </ul>
        </section>
      )}
      {settled.length > 0 && (
        <section>
          <PaneEyebrow meta={String(settled.length)}>merged · closed</PaneEyebrow>
          <ul>
            {settled.map((pr) => (
              <PullRequestRow
                key={pr.number}
                pr={pr}
                now={now}
                session={branchesBySession.get(pr.headRefName) ?? null}
              />
            ))}
          </ul>
        </section>
      )}
      {answer.fetchedAt !== null && (
        <p className="px-4 pt-2 font-mono text-[10px] text-faint">
          {answer.repo} · read {ago(answer.fetchedAt, now) ?? "now"} ago via gh
        </p>
      )}
    </div>
  );
}

function PullRequestRow({
  pr,
  now,
  session,
}: {
  readonly pr: PullRequestViewDto;
  readonly now: number;
  readonly session: SessionDto | null;
}) {
  const review = reviewWord(pr.reviewDecision);
  const settled = pr.state !== "open";
  return (
    <li>
      <a
        href={pr.url}
        target="_blank"
        rel="noreferrer"
        title={pr.url}
        className={cn(
          "flex w-full flex-col gap-[2px] py-[5px] pr-3 pl-[26px] text-left transition-colors hover:bg-[var(--sw-sunken)]",
          settled && "opacity-65 hover:opacity-100",
        )}
      >
        <span className="flex items-center gap-2">
          <StatusDot tone={prTone(pr)} size={6} />
          <span className="min-w-0 flex-1 truncate font-sans text-[13px] text-ink-2">
            {pr.title}
          </span>
          <span className={cn("shrink-0 font-mono text-[10.5px]", toneText(prTone(pr)))}>
            {prWord(pr)}
          </span>
        </span>
        <span className="flex items-center gap-2 pl-[14px] font-mono text-[10.5px] text-faint">
          <span className="truncate">
            #{pr.number} · {pr.headRefName} → {pr.baseRefName}
          </span>
          <span className="flex-1" />
          {review !== null && <span className="shrink-0">{review}</span>}
          <span className="shrink-0">
            +{pr.additions} −{pr.deletions}
          </span>
          <span className="shrink-0">{ago(pr.mergedAt ?? pr.updatedAt, now)}</span>
        </span>
        {session !== null && (
          <span className="pl-[14px] font-mono text-[10.5px] text-muted-foreground">
            session · {session.label ?? session.harness}
          </span>
        )}
      </a>
    </li>
  );
}

// ─── Files ──────────────────────────────────────────────────────────────────

/**
 * Rooted at the focused session's worktree when the focused session belongs
 * to this project — the files the agent is actually editing, untracked ones
 * included — and at the default branch's committed tree otherwise (the bare
 * store has no checkout to read). The eyebrow says which.
 */
export function FilesPane({
  project,
  session,
}: {
  readonly project: ProjectDto;
  readonly session: SessionDto | null;
}) {
  const query = useQuery(projectFilesQuery(project.id, session?.id ?? null));
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [copied, setCopied] = useState<string | null>(null);
  if (query.isPending) return <PaneNote>reading files…</PaneNote>;
  if (query.isError) {
    return (
      <PaneNote>
        could not list files — {query.error instanceof Error ? query.error.message : ""}
      </PaneNote>
    );
  }
  const listing = query.data;
  const tree = buildFileTree(listing.files);
  const toggle = (path: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const copy = (path: string) => {
    const absolute = listing.rootPath === null ? path : `${listing.rootPath}/${path}`;
    void navigator.clipboard.writeText(absolute);
    setCopied(path);
    window.setTimeout(() => setCopied((current) => (current === path ? null : current)), 900);
  };
  return (
    <div className="pb-2">
      <PaneEyebrow meta={`${tree.fileCount}${listing.truncated ? "+" : ""}`}>
        {listing.source === "worktree"
          ? `worktree · ${session?.label ?? listing.label}`
          : `branch · ${listing.label}`}
      </PaneEyebrow>
      {listing.truncated && (
        <PaneNote>the first {listing.files.length} paths — the listing is capped</PaneNote>
      )}
      {tree.children.length === 0 && <PaneNote>no files</PaneNote>}
      <ul>
        {tree.children.map((node) => (
          <FileRow
            key={node.path}
            node={node}
            depth={0}
            open={open}
            copied={copied}
            onToggle={toggle}
            onCopy={copy}
          />
        ))}
      </ul>
    </div>
  );
}

function FileRow({
  node,
  depth,
  open,
  copied,
  onToggle,
  onCopy,
}: {
  readonly node: FileNode;
  readonly depth: number;
  readonly open: ReadonlySet<string>;
  readonly copied: string | null;
  readonly onToggle: (path: string) => void;
  readonly onCopy: (path: string) => void;
}) {
  const expanded = node.kind === "dir" && open.has(node.path);
  return (
    <li>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        onClick={() => (node.kind === "dir" ? onToggle(node.path) : onCopy(node.path))}
        title={node.kind === "dir" ? node.path : `Copy path · ${node.path}`}
        aria-expanded={node.kind === "dir" ? expanded : undefined}
        style={{ paddingLeft: `${14 + depth * 12}px` }}
        className="flex h-auto w-full items-center justify-start gap-1.5 rounded-none py-[3px] pr-3 text-left font-normal hover:bg-[var(--sw-sunken)]"
      >
        <span
          aria-hidden="true"
          className={cn(
            "w-3 shrink-0 font-mono text-[11px] text-faint transition-transform",
            node.kind === "file" && "invisible",
            expanded && "rotate-90",
          )}
        >
          ›
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate font-mono text-[12px]",
            node.kind === "dir" ? "text-foreground" : "text-ink-2",
          )}
        >
          {node.name}
        </span>
        <span className="shrink-0 font-mono text-[10px] text-faint">
          {copied === node.path ? "copied" : node.kind === "dir" ? node.fileCount : ""}
        </span>
      </Button>
      {expanded && (
        <ul>
          {node.children.map((child) => (
            <FileRow
              key={child.path}
              node={child}
              depth={depth + 1}
              open={open}
              copied={copied}
              onToggle={onToggle}
              onCopy={onCopy}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
