import { Alert, AlertDescription } from "@mend/ui/components/ui/alert";
import { Button } from "@mend/ui/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@mend/ui/components/ui/empty";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@mend/ui/components/ui/input-group";
import { Skeleton } from "@mend/ui/components/ui/skeleton";
import { cn } from "@mend/ui/lib/utils";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { Link, Outlet, useMatch } from "@tanstack/react-router";
import {
  ChevronRightIcon,
  CircleAlertIcon,
  PlusIcon,
  SearchIcon,
  SparklesIcon,
  XIcon,
} from "lucide-react";
import { Fragment, useState } from "react";

import type { SkillDto } from "#/lib/api";
import { laterPage } from "#/lib/later-pages";
import { usePhone } from "#/lib/phone";
import { failureWords } from "#/lib/refusal";
import {
  highlighted,
  listCountWords,
  matchesSearch,
  type ProjectTwin,
  rowWhen,
  twinRowWords,
} from "#/lib/skills";
import { useTRPC } from "#/lib/trpc";
import { useInbox } from "#/lib/use-inbox";
import { useSkillTwins } from "#/lib/use-skill-twins";

import { SidebarToggle } from "../app-sidebar.tsx";
import { PhoneTabBar } from "../phone-inbox.tsx";
import { NewSkill } from "./new-skill.tsx";

/** The words under the page's title, on a desktop and on a phone. */
const INTRO =
  "Skills are instructions an agent reads when a task needs them. Your skills go into every session you start, in every project. Only you can see them.";
const PHONE_INTRO =
  "Your skills go into every session you start, in every project. Only you can see them.";

/**
 * Skills (Doop "Skills · a skill open", "Phone · Skills"): the person's own skills, to search,
 * open, create, edit and remove. It holds the list; the open skill (`/skills/<id>`) is its outlet,
 * the panel on the right on a desk and its own screen on a phone. Editing a skill (`?edit=1`)
 * replaces the whole page with the editor.
 */
export function SkillsPage() {
  const trpc = useTRPC();
  const phone = usePhone();
  const skills = useQuery(trpc.skills.list.queryOptions());
  const open = useMatch({ from: "/_inbox/skills/$skillId", shouldThrow: false });
  const twins = useSkillTwins(skills.status === "success" ? skills.data : undefined);
  const inbox = useInbox();
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);

  if (open?.search.edit === 1) return <Outlet />;

  const openId = open?.params.skillId;
  const none = skills.status === "success" && skills.data.length === 0;
  const waiting = inbox.status === "success" ? inbox.view.groups.waiting.length : 0;

  return (
    <div
      className={cn(
        "flex min-w-0 flex-col max-lg:min-h-dvh lg:h-[calc(100dvh-2*var(--spacing-sheet-inset))] lg:flex-none",
        // Room for the tab bar, which only the list has.
        openId === undefined && "max-lg:pb-14",
      )}
    >
      <header
        className={cn(
          "flex h-header shrink-0 items-center gap-3 border-b bg-background pr-2.5 pl-3 max-lg:h-auto max-lg:border-0 max-lg:pt-3 max-lg:pr-1 max-lg:pb-1 max-lg:pl-4",
          openId !== undefined && "max-lg:hidden",
        )}
      >
        <span className="flex items-center gap-3 max-lg:hidden">
          <SidebarToggle />
          <span aria-hidden className="h-4 w-px shrink-0 bg-border" />
        </span>
        <h1 className="flex-1 text-prose font-semibold max-lg:text-2xl max-lg:tracking-tight">
          Skills
        </h1>
        {none ? null : (
          <>
            <Button className="max-lg:hidden" onClick={() => setCreating(true)}>
              New skill…
            </Button>
            <Button
              variant="ghost"
              size="icon-touch"
              aria-label="New skill"
              className="lg:hidden"
              onClick={() => setCreating(true)}
            >
              <PlusIcon aria-hidden className="size-6" />
            </Button>
          </>
        )}
      </header>
      <div className="flex min-h-0 flex-1">
        <section
          aria-label="Your skills"
          className={cn(
            "flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto lg:px-8 lg:pt-6 lg:pb-12",
            openId !== undefined && "max-lg:hidden",
          )}
        >
          {none ? (
            <NoSkills phone={phone} onCreate={() => setCreating(true)} />
          ) : (
            <div className={cn("w-full", openId === undefined && "lg:max-w-[880px]")}>
              <p className="mb-4 max-w-xl text-prose text-muted-foreground max-lg:hidden">
                {INTRO}
              </p>
              <SearchField
                query={query}
                onChange={setQuery}
                disabled={skills.status !== "success"}
              />
              <p className="px-4 pt-3 text-prose text-muted-foreground lg:hidden">{PHONE_INTRO}</p>
              <SkillsList
                skills={skills}
                query={query}
                openId={openId}
                twins={twins}
                onClearSearch={() => setQuery("")}
              />
            </div>
          )}
        </section>
        {openId === undefined ? null : (
          <div className="flex min-h-0 min-w-0 flex-col max-lg:flex-1 lg:w-[43%] lg:shrink-0 lg:border-l">
            <Outlet />
          </div>
        )}
      </div>
      {openId === undefined ? (
        <div className="lg:hidden">
          <PhoneTabBar active="skills" badge={waiting} />
        </div>
      ) : null}
      <NewSkill
        open={creating}
        onOpenChange={setCreating}
        taken={skills.status === "success" ? skills.data.map((skill) => skill.name) : []}
      />
    </div>
  );
}

function SearchField({
  query,
  onChange,
  disabled,
}: {
  readonly query: string;
  readonly onChange: (query: string) => void;
  readonly disabled: boolean;
}) {
  return (
    <div className="max-lg:px-4 max-lg:pt-1">
      <InputGroup className="h-9 max-lg:h-11 max-lg:border-0 max-lg:bg-muted">
        <InputGroupAddon>
          <SearchIcon aria-hidden className="size-4 max-lg:size-5" />
        </InputGroupAddon>
        <InputGroupInput
          type="search"
          aria-label="Search your skills"
          placeholder="Search your skills"
          value={query}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && query !== "") {
              event.preventDefault();
              onChange("");
            }
          }}
          className="max-lg:text-lead [&::-webkit-search-cancel-button]:hidden"
        />
        {query === "" ? null : (
          <InputGroupAddon align="inline-end">
            <InputGroupButton size="icon-xs" aria-label="Clear search" onClick={() => onChange("")}>
              <XIcon aria-hidden />
            </InputGroupButton>
          </InputGroupAddon>
        )}
      </InputGroup>
    </div>
  );
}

/** The "Your skills" heading and what follows it: the rows, or loading, failure or no matches. */
function SkillsList({
  skills,
  query,
  openId,
  twins,
  onClearSearch,
}: {
  readonly skills: UseQueryResult<ReadonlyArray<SkillDto>, unknown>;
  readonly query: string;
  readonly openId: string | undefined;
  readonly twins: ReadonlyMap<string, ReadonlyArray<ProjectTwin>>;
  readonly onClearSearch: () => void;
}) {
  switch (skills.status) {
    case "pending":
      return (
        <div aria-busy>
          {listHeading("Loading…")}
          {[40, 34, 38, 30].map((width) => (
            <div key={width} className="grid gap-2.5 border-b px-3.5 py-4 max-lg:px-4">
              <Skeleton className="h-3 w-[14%]" />
              <Skeleton className="h-3" style={{ width: `${width}%` }} />
            </div>
          ))}
        </div>
      );
    case "error":
      return (
        <>
          {listHeading("")}
          <div className="pt-4 max-lg:px-4">
            <Alert tone="error">
              <CircleAlertIcon aria-hidden />
              <AlertDescription className="text-row text-muted-foreground">
                <p>
                  <strong className="font-semibold text-foreground">
                    Couldn't load your skills.
                  </strong>{" "}
                  {failureWords(skills.error, "Check your connection, then try again.")}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2.5 max-lg:h-11 max-lg:px-4"
                  disabled={skills.isFetching}
                  onClick={() => void skills.refetch()}
                >
                  {skills.isFetching ? "Trying again…" : "Try again"}
                </Button>
              </AlertDescription>
            </Alert>
          </div>
        </>
      );
    case "success": {
      const shown = skills.data.filter((skill) => matchesSearch(skill, query));
      const searching = query.trim() !== "";
      return (
        <>
          {listHeading(listCountWords(shown.length, skills.data.length, query))}
          {shown.length === 0 ? (
            <div className="px-3.5 py-5 max-lg:px-4">
              <p className="text-lead text-foreground">No skills match "{query.trim()}".</p>
              <p className="mt-2 text-row text-muted-foreground">
                Search looks at each skill's name and description. A project's skills are on the
                project's Skills tab.
              </p>
              <Button
                variant="outline"
                size="sm"
                className="mt-3 max-lg:h-11 max-lg:px-4"
                onClick={onClearSearch}
              >
                Clear search
              </Button>
            </div>
          ) : (
            <ul className="flex flex-col">
              {shown.map((skill) => (
                <li key={skill.id} className="border-b">
                  <SkillRow
                    skill={skill}
                    query={query}
                    open={skill.id === openId}
                    twins={twins.get(skill.name) ?? []}
                  />
                </li>
              ))}
            </ul>
          )}
          {searching ? (
            shown.length === 0 ? null : (
              <p className="px-3.5 pt-4 text-row text-muted-foreground max-lg:px-4">
                Search looks at each skill's name and description.
              </p>
            )
          ) : (
            <ProjectNote twins={[...twins.values()].flat()} />
          )}
        </>
      );
    }
  }
}

/** "Your skills" with the count, or what the list is doing, beside it. */
const listHeading = (words: string) => (
  <h2 className="flex items-baseline gap-2 border-b pt-5 pb-2.5 text-prose font-semibold max-lg:px-4 max-lg:text-lead">
    Your skills
    <span role="status" className="text-row font-normal text-muted-foreground">
      {words}
    </span>
  </h2>
);

function SkillRow({
  skill,
  query,
  open,
  twins,
}: {
  readonly skill: SkillDto;
  readonly query: string;
  readonly open: boolean;
  readonly twins: ReadonlyArray<ProjectTwin>;
}) {
  const side = twins.length > 0 ? twinRowWords(twins) : rowWhen(skill, new Date());
  return (
    <Link
      to="/skills/$skillId"
      params={{ skillId: skill.id }}
      aria-current={open ? "page" : undefined}
      className={cn(
        "flex items-center gap-4 px-3.5 py-3 outline-none hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50 max-lg:min-h-15 max-lg:px-4 lg:my-px lg:rounded-lg",
        open && "bg-muted hover:bg-muted",
      )}
    >
      <span className="grid min-w-0 flex-1 gap-1">
        <span className="truncate font-mono text-meta text-foreground max-lg:text-lead">
          <Marked text={skill.name} query={query} />
        </span>
        <span className="truncate text-row text-muted-foreground max-lg:text-prose">
          {/* On a phone the line under the name says where a project uses its own. */}
          <span className={cn(twins.length > 0 && "max-lg:hidden")}>
            {skill.description === "" ? (
              "No description"
            ) : (
              <Marked text={skill.description} query={query} />
            )}
          </span>
          {twins.length > 0 ? <span className="lg:hidden">{side}.</span> : null}
        </span>
      </span>
      <span className="shrink-0 text-row text-muted-foreground max-lg:hidden">{side}</span>
      <ChevronRightIcon aria-hidden className="size-5 shrink-0 text-muted-foreground lg:hidden" />
    </Link>
  );
}

/** A text with each place it matches the search marked. */
function Marked({ text, query }: { readonly text: string; readonly query: string }) {
  return highlighted(text, query).map((part) =>
    part.match ? (
      <mark key={part.start} className="rounded-xs bg-primary/12 text-inherit">
        {part.text}
      </mark>
    ) : (
      <Fragment key={part.start}>{part.text}</Fragment>
    ),
  );
}

/** Under the list: a project's own skills, and a link to each project that has one of the same name. */
function ProjectNote({ twins }: { readonly twins: ReadonlyArray<ProjectTwin> }) {
  const projects = [...new Map(twins.map((twin) => [twin.projectId, twin.projectName]))];
  return (
    <p className="max-w-xl px-3.5 pt-4 text-row text-muted-foreground max-lg:px-4 max-lg:text-prose">
      A project can have its own skills, on the project's Skills tab. When a project skill has the
      same name as one of yours, the project's skill is used in that project.
      {projects.map(([id, name], at) => (
        <Fragment key={id}>
          {at === 0 ? " " : " · "}
          <Link {...laterPage(`projects/${id}/skills`)} className="text-info hover:underline">
            Skills in {name}
          </Link>
        </Fragment>
      ))}
    </p>
  );
}

function NoSkills({ phone, onCreate }: { readonly phone: boolean; readonly onCreate: () => void }) {
  return (
    <Empty className="flex-1">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <SparklesIcon aria-hidden />
        </EmptyMedia>
        <EmptyTitle>
          <h2>No skills yet</h2>
        </EmptyTitle>
        <EmptyDescription>
          A skill is a set of instructions an agent reads when a task needs them. Your skills go
          into every session you start, in every project.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button size={phone ? "touch" : "default"} onClick={onCreate}>
          New skill…
        </Button>
        <p className="mt-6 text-row text-muted-foreground">
          Skills already on your computer? Run{" "}
          <code className="font-mono text-meta text-foreground">mend skills push</code> to add the
          folder.
        </p>
      </EmptyContent>
    </Empty>
  );
}
