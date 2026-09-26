import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { autoLandFact } from "#/lib/landing";
import { useTRPC } from "#/lib/trpc";
import { useInheritedSettings } from "#/lib/viewer";
import { OS_LABELS } from "#/lib/workspace-environment";

/**
 * One source for the project's setup facts as terse mono values (image,
 * variables, secrets, references, mounts, services, dotfiles, git, review).
 * Two consumers render them: the rail card on the project page and the
 * anchored index on the setup page — the same values in both places, so the
 * glance and the index never disagree.
 */
export function useSetupFactValues(projectId: string) {
  const trpc = useTRPC();
  const detail = useQuery(trpc.projects.detail.queryOptions({ id: projectId })).data;
  const settings = useInheritedSettings();
  const environment = useQuery(trpc.environment.environment.queryOptions({ projectId })).data;
  const secrets = useQuery(trpc.environment.secrets.queryOptions({ projectId })).data;
  const references = useQuery(trpc.projects.references.queryOptions({ id: projectId })).data;
  const mounts = useQuery(trpc.projects.mounts.queryOptions({ id: projectId })).data;
  const recipes = useQuery(trpc.projects.recipes.queryOptions({ id: projectId })).data;
  const hotSessions = useQuery(
    trpc.projects.hotSessionsStatus.queryOptions({ id: projectId }, { refetchInterval: 5_000 }),
  ).data;
  if (detail === undefined) return null;
  const { project } = detail;

  const effective = project.workspaceImage ?? settings?.workspaceImage ?? null;
  return {
    image:
      effective === null
        ? "inherited default"
        : effective.mode === "custom"
          ? effective.baseImage
          : `${OS_LABELS[effective.os].toLowerCase()} · ${effective.packages.length} pkgs`,
    variables: count(environment?.variables.length),
    secrets: count(secrets?.secrets.length),
    references: count(references?.length),
    mounts: count(mounts?.length),
    services:
      recipes === undefined
        ? "…"
        : recipes.length === 0
          ? "none"
          : `${recipes.length} ${recipes.length === 1 ? "recipe" : "recipes"}`,
    dotfiles: project.applyDotfiles ? "on" : "off",
    hot:
      project.hotSessions === 0
        ? "off"
        : `${hotSessions?.ready ?? 0} of ${project.hotSessions} ready`,
    git: project.gitAuthMode === "mend-key" ? "mend key" : project.gitAuthMode,
    review: `tour ${project.autoTour} · suggest ${project.autoSuggest} · name ${project.autoName}`,
    landing: autoLandFact(project.autoLand, settings?.autoLand),
  };
}

type FactKey = keyof NonNullable<ReturnType<typeof useSetupFactValues>>;

const FACT_ROWS: ReadonlyArray<{
  readonly anchor: string;
  readonly label: string;
  readonly key: FactKey;
}> = [
  { anchor: "environment", label: "Workspace image", key: "image" },
  { anchor: "variables", label: "Variables", key: "variables" },
  { anchor: "secrets", label: "Secrets", key: "secrets" },
  { anchor: "references", label: "References", key: "references" },
  { anchor: "mounts", label: "Mounted folders", key: "mounts" },
  { anchor: "services", label: "Services", key: "services" },
  { anchor: "dotfiles", label: "Dotfiles", key: "dotfiles" },
  { anchor: "hot-sessions", label: "Hot sessions", key: "hot" },
  { anchor: "git", label: "Git access", key: "git" },
  { anchor: "review", label: "Review automation", key: "review" },
  { anchor: "landing", label: "Land on turn", key: "landing" },
];

/**
 * What each fact is, in one testable sentence — the row's native tooltip.
 * Plain description of the knob, never advice about how to set it.
 */
const EXPLANATIONS: Record<FactKey, string> = {
  image:
    "The workspace image sessions launch in — an OS family plus extra packages, or a custom base. Inherited from the organization's defaults in Settings unless this project overrides it.",
  variables:
    "Environment variables every process in this project's workspaces starts with — plain configuration, readable back after saving.",
  secrets:
    "Sensitive values sessions receive at launch — encrypted here, never persisted by the platform, replaceable but not readable after saving.",
  references:
    "Read-only clones of dependency sources, mounted at /workspace/ref/<name> in the next sessions.",
  mounts:
    "Host folders the next sessions see at /workspace/home/<name>. Read-only unless chosen otherwise — the reviewed change stays the worktree.",
  services:
    "Commands sessions can run and expose — a dev server, a database — declared here or in the repo's mend.toml.",
  dotfiles:
    "Whether sessions in this project receive your dotfiles (repo plus synced home files, set up in Settings) at launch.",
  hot: "How many workspaces this project keeps ready for new sessions. A new session claims one and attaches immediately; each ready workspace is a live container on this machine.",
  git: "How Mend reaches this project's remote: ambient uses your login user's git and ssh setup; mend key is this machine's own deploy key; bridge signs through an ssh-agent shared from another machine.",
  landing:
    "Whether a session here pushes its change and opens or updates its pull request after each completed turn that asked for a change. Inherit follows Settings.",
  review:
    "What Mend runs when a session settles here — a description and tour of the change, and drafted fix suggestions. Draft comments, never verdicts; inherit follows Settings.",
};

const count = (n: number | undefined): string =>
  n === undefined ? "…" : n === 0 ? "none" : `${n}`;

/**
 * The project's setup in the rail: plain-word labels on the left, mono values
 * on the right, each row a link into its section on the setup page. The label
 * says what the row is — meaning is read, not hovered.
 */
export function ProjectSetupFacts({ projectId }: { readonly projectId: string }) {
  const facts = useSetupFactValues(projectId);
  if (facts === null) return null;

  return (
    <section className="rounded-2xl bg-panel shadow-[var(--shadow-sm)]">
      <div className="flex items-center justify-between border-b border-rule-faint px-5 pt-4 pb-3">
        <p className="font-sans text-sm font-medium text-foreground">Setup</p>
        <Link
          to="/projects/$projectId/setup"
          params={{ projectId }}
          className="font-sans text-xs font-medium text-muted-foreground no-underline transition-colors hover:text-foreground"
        >
          Open →
        </Link>
      </div>
      <ul className="px-2 py-1.5">
        {FACT_ROWS.map((row) => (
          <li key={row.key}>
            <Link
              to="/projects/$projectId/setup"
              params={{ projectId }}
              hash={row.anchor}
              title={EXPLANATIONS[row.key]}
              className="flex items-baseline justify-between gap-3 rounded-lg px-3 py-[7px] no-underline transition-colors hover:bg-secondary"
            >
              <span className="shrink-0 font-sans text-xs text-muted-foreground">{row.label}</span>
              <span className="truncate text-right font-mono text-xs text-ink-2">
                {facts[row.key]}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

const INDEX_GROUPS: ReadonlyArray<{
  readonly label: string;
  readonly rows: ReadonlyArray<(typeof FACT_ROWS)[number]>;
}> = [
  { label: "environment", rows: FACT_ROWS.slice(0, 3) },
  { label: "sources", rows: FACT_ROWS.slice(3, 7) },
  { label: "policy", rows: FACT_ROWS.slice(7, 11) },
];

/**
 * The setup page's local index: every section with its current value, grouped
 * the way the page is. The values make the index the summary — often you read
 * it and never scroll.
 */
export function SetupIndex({ projectId }: { readonly projectId: string }) {
  const facts = useSetupFactValues(projectId);
  if (facts === null) return null;

  return (
    <nav aria-label="Setup sections" className="flex flex-col gap-5">
      {INDEX_GROUPS.map((group) => (
        <div key={group.label}>
          <p className="ev-eyebrow">{group.label}</p>
          <ul className="mt-1.5 flex flex-col">
            {group.rows.map((row) => (
              <li key={row.key}>
                <Link
                  to="/projects/$projectId/setup"
                  params={{ projectId }}
                  hash={row.anchor}
                  className="-mx-2 block rounded-lg px-2 py-1.5 no-underline transition-colors hover:bg-secondary"
                >
                  <span className="block font-sans text-[13px] font-medium text-ink-2">
                    {row.label}
                  </span>
                  <span className="mt-0.5 block truncate font-mono text-[11px] text-faint">
                    {facts[row.key]}
                  </span>
                </Link>
              </li>
            ))}
            {group.label === "policy" && (
              <li>
                <Link
                  to="/projects/$projectId/setup"
                  params={{ projectId }}
                  hash="remove"
                  className="-mx-2 block rounded-lg px-2 py-1.5 no-underline transition-colors hover:bg-secondary"
                >
                  <span className="block font-sans text-[13px] font-medium text-danger">
                    Remove project
                  </span>
                </Link>
              </li>
            )}
          </ul>
        </div>
      ))}
    </nav>
  );
}
