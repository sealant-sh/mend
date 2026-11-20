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
import { Skeleton } from "@mend/ui/components/ui/skeleton";
import { cn } from "@mend/ui/lib/utils";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { Link, Outlet, useMatch } from "@tanstack/react-router";
import { CircleAlertIcon, SparklesIcon } from "lucide-react";
import { useState } from "react";

import type { SkillDto } from "#/lib/api";
import { usePhone } from "#/lib/phone";
import { canChangeSkills, projectRowSide, skillAt, type SkillOwner } from "#/lib/project-skills";
import { failureWords } from "#/lib/refusal";
import { useTRPC } from "#/lib/trpc";
import { useProjectSkillOwner } from "#/lib/use-project-skill-owner";

import { NewSkill } from "../skills/new-skill.tsx";
import { SkillRow } from "../skills/skills-page.tsx";

type ProjectOwner = Extract<SkillOwner, { kind: "project" }>;

/**
 * A project's Skills tab (Doop "Project · Skills tab" and its states): the project's own skills,
 * which every new session in it gets, each saying when it changed or that it is used instead of
 * yours. The open skill (`/projects/<id>/skills/<skillId>`) is its outlet: the panel on the right
 * on a desk, its own screen on a phone. Someone who may change the project's skills gets New
 * skill…; anyone else reads, and the tab says who can change them.
 */
export function SkillsTab({ projectId }: { readonly projectId: string }) {
  const trpc = useTRPC();
  const phone = usePhone();
  const owner = useProjectSkillOwner(projectId);
  const skills = useQuery(trpc.skills.forProject.queryOptions({ id: projectId }));
  const yours = useQuery(trpc.skills.list.queryOptions());
  const open = useMatch({
    from: "/_inbox/projects/$projectId/skills/$skillId",
    shouldThrow: false,
  });
  const [creating, setCreating] = useState(false);
  if (owner.kind === "you") return null;
  // Editing replaces the whole page; the project layout has stepped aside too.
  if (open?.search.edit === 1 && canChangeSkills(owner)) return <Outlet />;

  const openId = open?.params.skillId;
  const changeable = canChangeSkills(owner);
  // Your own skills by name: a project skill with one of their names is used instead of yours.
  const yourNames = new Set(
    yours.status === "success" ? yours.data.map((skill) => skill.name) : [],
  );
  const none = skills.status === "success" && skills.data.length === 0;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 max-lg:flex-col">
      <section
        aria-label={`Skills in ${owner.projectName}`}
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto pb-12 lg:px-8 lg:pt-6",
          openId !== undefined && "max-lg:hidden",
        )}
      >
        <div className={cn("w-full", openId === undefined && "lg:max-w-[1000px]")}>
          <header className="flex items-start gap-4 border-b pb-3 max-lg:px-4 max-lg:pt-4">
            <div className="min-w-0 flex-1">
              <h2 className="text-prose font-semibold max-lg:text-lead">
                Skills in {owner.projectName}
              </h2>
              <p className="mt-1 text-prose text-muted-foreground">{introWords(owner)}</p>
            </div>
            {changeable && !none ? (
              <Button
                variant="outline"
                className="mt-3 max-lg:hidden"
                onClick={() => setCreating(true)}
              >
                New skill…
              </Button>
            ) : null}
          </header>
          {none ? null : (
            <SkillsList owner={owner} skills={skills} openId={openId} yourNames={yourNames} />
          )}
          {none ? null : (
            <p className="max-w-2xl px-3.5 pt-4 text-row text-muted-foreground max-lg:px-4 max-lg:text-prose">
              Your own skills also go into the sessions you start here. When one of yours has the
              same name as a skill here, this project's skill is used.{" "}
              <Link to="/skills" className="text-info hover:underline max-lg:hidden">
                Your skills
              </Link>
            </p>
          )}
          {changeable && !none ? (
            <div className="px-4 pt-5 lg:hidden">
              <Button
                variant="outline"
                size="touch"
                className="w-full"
                onClick={() => setCreating(true)}
              >
                New skill…
              </Button>
            </div>
          ) : null}
        </div>
        {/* Outside the column, so it sits in the middle of the space under the header. */}
        {none ? <NoSkills owner={owner} phone={phone} onCreate={() => setCreating(true)} /> : null}
      </section>
      {openId === undefined ? null : (
        <div className="flex min-h-0 min-w-0 flex-col max-lg:flex-1 lg:w-[43%] lg:shrink-0 lg:border-l">
          <Outlet />
        </div>
      )}
      {changeable ? (
        <NewSkill
          open={creating}
          onOpenChange={setCreating}
          taken={skills.status === "success" ? skills.data.map((skill) => skill.name) : []}
          owner={owner}
        />
      ) : null}
    </div>
  );
}

/** Under the tab's title: what the skills do, and, to someone who reads them, who changes them. */
const introWords = (owner: ProjectOwner): string =>
  owner.canChange
    ? `Every new session in ${owner.projectName} gets these skills. Running sessions keep the skills they started with.`
    : `Every new session in ${owner.projectName} gets these skills. ${owner.changers} add and change them. You can read them.`;

/** The rows, or what the list is doing instead: loading or failed. */
function SkillsList({
  owner,
  skills,
  openId,
  yourNames,
}: {
  readonly owner: ProjectOwner;
  readonly skills: UseQueryResult<ReadonlyArray<SkillDto>, unknown>;
  readonly openId: string | undefined;
  readonly yourNames: ReadonlySet<string>;
}) {
  switch (skills.status) {
    case "pending":
      return (
        <div aria-busy>
          <span className="sr-only">Loading {owner.projectName}'s skills…</span>
          {[40, 34, 38].map((width) => (
            <div key={width} className="grid gap-2.5 border-b px-3.5 py-4 max-lg:px-4">
              <Skeleton className="h-3 w-[14%]" />
              <Skeleton className="h-3" style={{ width: `${width}%` }} />
            </div>
          ))}
        </div>
      );
    case "error":
      return (
        <div className="pt-4 max-lg:px-4">
          <Alert tone="error">
            <CircleAlertIcon aria-hidden />
            <AlertDescription className="text-row text-muted-foreground">
              <p>
                <strong className="font-semibold text-foreground">
                  Couldn't load {owner.projectName}'s skills.
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
      );
    case "success": {
      const now = new Date();
      return (
        <ul className="flex flex-col">
          {skills.data.map((skill) => {
            const wins = yourNames.has(skill.name);
            return (
              <li key={skill.id} className="border-b">
                <SkillRow
                  skill={skill}
                  query=""
                  open={skill.id === openId}
                  link={skillAt(owner, skill.id)}
                  side={projectRowSide(skill, wins, now)}
                  phoneNote={wins ? { words: "Used instead of yours", replaces: false } : null}
                />
              </li>
            );
          })}
        </ul>
      );
    }
  }
}

function NoSkills({
  owner,
  phone,
  onCreate,
}: {
  readonly owner: ProjectOwner;
  readonly phone: boolean;
  readonly onCreate: () => void;
}) {
  return (
    <Empty className="flex-1">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <SparklesIcon aria-hidden />
        </EmptyMedia>
        <EmptyTitle>
          <h3>No skills in {owner.projectName} yet</h3>
        </EmptyTitle>
        <EmptyDescription>
          A project's skills go into every new session in it, for everyone who works there. When one
          has the same name as one of your own skills, the project's is used here.
        </EmptyDescription>
      </EmptyHeader>
      {owner.canChange ? (
        <EmptyContent>
          <Button size={phone ? "touch" : "default"} onClick={onCreate}>
            New skill…
          </Button>
          <p className="mt-6 text-row text-muted-foreground">
            Skills already in a folder? Run{" "}
            <code className="font-mono text-meta text-foreground">mend skills push --project</code>{" "}
            from the project's checkout.
          </p>
        </EmptyContent>
      ) : null}
    </Empty>
  );
}
