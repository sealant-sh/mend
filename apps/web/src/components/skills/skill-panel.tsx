import { Alert, AlertDescription } from "@mend/ui/components/ui/alert";
import { Button, buttonVariants } from "@mend/ui/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@mend/ui/components/ui/sheet";
import { Skeleton } from "@mend/ui/components/ui/skeleton";
import { cn } from "@mend/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { CircleAlertIcon, EllipsisIcon, PencilIcon, Trash2Icon, XIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import type { SkillDetailDto } from "#/lib/api";
import {
  canChangeSkills,
  projectPanelWhen,
  projectSavedUseWords,
  projectUsedWords,
  revisionWhen,
  skillAt,
  type SkillOwner,
  skillsHome,
  whoCanChangeWords,
} from "#/lib/project-skills";
import { failureWords, refusalTagOf } from "#/lib/refusal";
import {
  fileSearch,
  justSaved,
  orderedFiles,
  panelWhen,
  savedUseWords,
  shownFile,
  usedInWords,
  whenWords,
} from "#/lib/skills";
import { useTRPC } from "#/lib/trpc";
import { useSkillTwins, useYourSkillNamed } from "#/lib/use-skill-twins";

import { PhoneHeader } from "../workspace/phone-header.tsx";
import { RemoveSkill } from "./remove-skill.tsx";

/**
 * A skill open to read (Doop "Skills · a skill open", "Phone · Skill", "Project · Skills tab · a
 * skill open" and "read only"): its name, when it last changed and where it is used, then its
 * files. On a desk it is the panel beside the list; on a phone its own screen. Edit skill opens the
 * editor in its place; the "…" also holds Remove skill…. A project's skill says who may change it,
 * and offers neither to anyone else.
 */
export function SkillPanel({
  skillId,
  file,
  owner,
}: {
  readonly skillId: string;
  readonly file: string | undefined;
  readonly owner: SkillOwner;
}) {
  const trpc = useTRPC();
  const detail = useQuery(trpc.skills.detail.queryOptions({ skillId }));
  switch (detail.status) {
    case "pending":
      return (
        <div aria-busy className="flex flex-col gap-3 px-8 pt-7 max-lg:px-4">
          <span className="sr-only">Loading the skill…</span>
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-3 w-2/3" />
          <Skeleton className="mt-6 h-3 w-3/4" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      );
    case "error":
      return (
        <PanelProblem
          owner={owner}
          gone={refusalTagOf(detail.error) === "NotFound"}
          words={failureWords(detail.error, "Check your connection, then try again.")}
          retrying={detail.isFetching}
          onRetry={() => void detail.refetch()}
        />
      );
    case "success":
      return <SkillReader detail={detail.data} file={file} owner={owner} />;
  }
}

/** "Back to your skills", "Back to checkout-api's skills". */
const backWords = (owner: SkillOwner): string =>
  owner.kind === "you" ? "Back to your skills" : `Back to ${owner.projectName}'s skills`;

function PanelProblem({
  owner,
  gone,
  words,
  retrying,
  onRetry,
}: {
  readonly owner: SkillOwner;
  readonly gone: boolean;
  readonly words: string;
  readonly retrying: boolean;
  readonly onRetry: () => void;
}) {
  return (
    <div className="px-8 pt-7 max-lg:px-4 max-lg:pt-4">
      <Alert tone="error">
        <CircleAlertIcon aria-hidden />
        <AlertDescription className="text-row text-muted-foreground">
          <p>
            <strong className="font-semibold text-foreground">
              {gone ? "This skill isn't here." : "Couldn't load this skill."}
            </strong>{" "}
            {gone
              ? owner.kind === "you"
                ? "It was removed, from another browser or with mend skills push --prune."
                : `It was removed from ${owner.projectName}, from another browser or with mend skills push --project --prune.`
              : words}
          </p>
          <div className="mt-2.5 flex gap-2">
            {gone ? null : (
              <Button
                variant="outline"
                size="sm"
                className="max-lg:h-11 max-lg:px-4"
                disabled={retrying}
                onClick={onRetry}
              >
                {retrying ? "Trying again…" : "Try again"}
              </Button>
            )}
            <Link
              {...skillsHome(owner)}
              className={cn(
                buttonVariants({ variant: "outline", size: "sm" }),
                "max-lg:h-11 max-lg:px-4",
              )}
            >
              {backWords(owner)}
            </Link>
          </div>
        </AlertDescription>
      </Alert>
    </div>
  );
}

function SkillReader({
  detail,
  file,
  owner,
}: {
  readonly detail: SkillDetailDto;
  readonly file: string | undefined;
  readonly owner: SkillOwner;
}) {
  const navigate = useNavigate();
  const { skill } = detail;
  const twins = useSkillTwins(owner.kind === "you" ? [skill] : undefined).get(skill.name) ?? [];
  // On a project's skill: your own of the same name, which this one is used instead of.
  const yours = useYourSkillNamed(owner.kind === "project" ? skill.name : undefined);
  const [removing, setRemoving] = useState(false);
  const files = orderedFiles(detail.files);
  const shown = shownFile(files, file);
  const now = new Date();
  const saved = justSaved(skill, now);
  const changeable = canChangeSkills(owner);
  const when =
    owner.kind === "you" ? panelWhen(skill, now) : projectPanelWhen(owner.projectName, skill, now);
  const used =
    owner.kind === "you"
      ? saved
        ? savedUseWords(skill.revision)
        : usedInWords(skill.name, twins)
      : saved
        ? projectSavedUseWords(owner.projectName, skill.revision)
        : projectUsedWords(owner.projectName, yours !== undefined);
  const who = owner.kind === "project" && !saved ? whoCanChangeWords(owner) : null;
  const twin = twins.length === 1 ? twins[0] : undefined;
  const edit = () => void navigate(skillAt(owner, skill.id, fileSearch(shown?.path, true)));
  const other = saved ? null : twin !== undefined ? (
    <Link
      to="/projects/$projectId/skills/$skillId"
      params={{ projectId: twin.projectId, skillId: twin.skillId }}
      className="text-info hover:underline"
    >
      Open {twin.projectName}'s skill
    </Link>
  ) : yours !== undefined ? (
    <Link
      to="/skills/$skillId"
      params={{ skillId: yours.id }}
      className="text-info hover:underline"
    >
      Open your skill
    </Link>
  ) : null;
  const usedLine = (
    <>
      {used}
      {other === null ? null : <> {other}</>}
    </>
  );
  const sub = owner.kind === "you" ? "Your skill" : `${owner.projectName}'s skill`;
  const phoneWhen = owner.kind === "you" ? whenWords(skill, now) : revisionWhen(skill, now);

  return (
    <article aria-label={skill.name} className="flex min-h-0 flex-1 flex-col">
      <PhoneHeader
        className="lg:hidden"
        title={skill.name}
        sub={sub}
        back={{ link: skillsHome(owner), label: backWords(owner) }}
        actions={
          changeable ? (
            <PhoneActions name={skill.name} onEdit={edit} onRemove={() => setRemoving(true)} />
          ) : undefined
        }
      />
      <header className="border-b px-8 pt-5 pb-4 max-lg:hidden">
        <div className="flex items-center gap-2">
          <h2 className="min-w-0 flex-1 truncate font-mono text-lead font-medium">{skill.name}</h2>
          {changeable ? (
            <>
              <Button variant="outline" size="sm" onClick={edit}>
                Edit skill
              </Button>
              {/* Its own button, not a "…" that held Edit skill again and this (SLNT-1229). */}
              <Button
                variant="destructive"
                size="icon-sm"
                aria-label="Remove skill"
                onClick={() => setRemoving(true)}
              >
                <Trash2Icon aria-hidden />
              </Button>
            </>
          ) : null}
          <Link
            {...skillsHome(owner)}
            aria-label={`Close ${skill.name}`}
            className={buttonVariants({ variant: "ghost", size: "icon-sm" })}
          >
            <XIcon aria-hidden />
          </Link>
        </div>
        <p className="mt-2.5 text-row text-muted-foreground">{when}</p>
        <p className="mt-1.5 text-row text-muted-foreground">{usedLine}</p>
        {who === null ? null : <p className="mt-1.5 text-row text-muted-foreground">{who}</p>}
      </header>
      <div className="border-b bg-muted/40 px-4 py-3 text-prose text-muted-foreground lg:hidden">
        <p>
          {phoneWhen} {usedLine}
        </p>
        {who === null ? null : <p className="mt-1.5">{who}</p>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {files.length > 1 ? (
          <nav aria-label="Files" className="flex flex-wrap gap-1.5 px-8 pt-4 max-lg:px-4">
            {files.map((entry) => (
              <Link
                key={entry.path}
                {...skillAt(owner, skill.id, fileSearch(entry.path, false))}
                aria-current={entry.path === shown?.path ? "page" : undefined}
                className="rounded-md px-2 py-1 font-mono text-meta text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 aria-[current=page]:bg-muted aria-[current=page]:text-foreground max-lg:py-2.5"
              >
                {entry.path}
              </Link>
            ))}
          </nav>
        ) : null}
        {shown === undefined ? null : (
          <pre
            aria-label={shown.path}
            className="px-8 py-5 font-mono text-meta leading-[1.8] break-words whitespace-pre-wrap text-foreground max-lg:px-4 max-lg:text-row"
          >
            {shown.contents === "" ? (
              <span className="font-sans text-muted-foreground">This file is empty.</span>
            ) : (
              shown.contents
            )}
          </pre>
        )}
      </div>
      {changeable ? (
        <RemoveSkill skill={detail} owner={owner} open={removing} onOpenChange={setRemoving} />
      ) : null}
    </article>
  );
}

/** On a phone the "…" opens the skill's actions from the bottom (Doop "Phone · Skills · actions"). */
function PhoneActions({
  name,
  onEdit,
  onRemove,
}: {
  readonly name: string;
  readonly onEdit: () => void;
  readonly onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const item = (icon: ReactNode, label: string, run: () => void, danger = false) => (
    <button
      type="button"
      onClick={() => {
        setOpen(false);
        run();
      }}
      className={cn(
        "flex h-13 w-full items-center gap-4 px-5 text-left text-lead outline-none focus-visible:bg-muted [&_svg]:size-5.5",
        danger ? "text-destructive" : "text-foreground [&_svg]:text-muted-foreground",
      )}
    >
      {icon}
      {label}
    </button>
  );
  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Actions for ${name}`}
        onClick={() => setOpen(true)}
        className={buttonVariants({ variant: "ghost", size: "icon-touch" })}
      >
        <EllipsisIcon aria-hidden className="size-5.5" />
      </button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="bottom"
          showCloseButton={false}
          className="max-h-[85dvh] gap-0 rounded-t-xl pb-[env(safe-area-inset-bottom)]"
        >
          <span
            aria-hidden
            className="mx-auto mt-1.5 mb-0.5 block h-1.25 w-9 rounded-full bg-muted-foreground/35"
          />
          <SheetHeader className="border-b px-5 py-3">
            <SheetTitle className="truncate text-title font-semibold">{name}</SheetTitle>
          </SheetHeader>
          <div className="py-1.5">
            {item(<PencilIcon aria-hidden />, "Edit skill", onEdit)}
            {item(<Trash2Icon aria-hidden />, "Remove skill…", onRemove, true)}
          </div>
          <div className="border-t py-1.5">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="flex h-13 w-full items-center justify-center text-lead outline-none focus-visible:bg-muted"
            >
              Cancel
            </button>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
