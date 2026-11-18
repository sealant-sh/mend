import { Alert, AlertDescription } from "@mend/ui/components/ui/alert";
import { Button, buttonVariants } from "@mend/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@mend/ui/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@mend/ui/components/ui/sheet";
import { Skeleton } from "@mend/ui/components/ui/skeleton";
import { cn } from "@mend/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { CircleAlertIcon, EllipsisIcon, PencilIcon, Trash2Icon, XIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import type { SkillDetailDto } from "#/lib/api";
import { laterPage } from "#/lib/later-pages";
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
import { useSkillTwins } from "#/lib/use-skill-twins";

import { PhoneHeader } from "../workspace/phone-header.tsx";
import { RemoveSkill } from "./remove-skill.tsx";

/**
 * A skill open to read (Doop "Skills · a skill open", "Phone · Skill"): its name, when it last
 * changed and where it is used, then its files. On a desk it is the panel beside the list; on a
 * phone its own screen. Edit skill opens the editor in its place; the "…" also holds Remove skill….
 */
export function SkillPanel({
  skillId,
  file,
}: {
  readonly skillId: string;
  readonly file: string | undefined;
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
          gone={refusalTagOf(detail.error) === "NotFound"}
          words={failureWords(detail.error, "Check your connection, then try again.")}
          retrying={detail.isFetching}
          onRetry={() => void detail.refetch()}
        />
      );
    case "success":
      return <SkillReader detail={detail.data} file={file} />;
  }
}

function PanelProblem({
  gone,
  words,
  retrying,
  onRetry,
}: {
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
              ? "It was removed, from another browser or with mend skills push --prune."
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
              to="/skills"
              className={cn(
                buttonVariants({ variant: "outline", size: "sm" }),
                "max-lg:h-11 max-lg:px-4",
              )}
            >
              Back to your skills
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
}: {
  readonly detail: SkillDetailDto;
  readonly file: string | undefined;
}) {
  const navigate = useNavigate();
  const { skill } = detail;
  const twins = useSkillTwins([skill]).get(skill.name) ?? [];
  const [removing, setRemoving] = useState(false);
  const files = orderedFiles(detail.files);
  const shown = shownFile(files, file);
  const now = new Date();
  const when = panelWhen(skill, now);
  const used = justSaved(skill, now)
    ? savedUseWords(skill.revision)
    : usedInWords(skill.name, twins);
  const twin = twins.length === 1 ? twins[0] : undefined;
  const edit = () =>
    void navigate({
      to: "/skills/$skillId",
      params: { skillId: skill.id },
      search: fileSearch(shown?.path, true),
    });
  const usedLine = (
    <>
      {used}
      {twin === undefined || justSaved(skill, now) ? null : (
        <>
          {" "}
          <Link
            {...laterPage(`projects/${twin.projectId}/skills/${twin.skillId}`)}
            className="text-info hover:underline"
          >
            Open {twin.projectName}'s skill
          </Link>
        </>
      )}
    </>
  );

  return (
    <article aria-label={skill.name} className="flex min-h-0 flex-1 flex-col">
      <PhoneHeader
        className="lg:hidden"
        title={skill.name}
        sub="Your skill"
        back={{ link: { to: "/skills" }, label: "Back to your skills" }}
        actions={
          <PhoneActions name={skill.name} onEdit={edit} onRemove={() => setRemoving(true)} />
        }
      />
      <header className="border-b px-8 pt-5 pb-4 max-lg:hidden">
        <div className="flex items-center gap-2">
          <h2 className="min-w-0 flex-1 truncate font-mono text-lead font-medium">{skill.name}</h2>
          <Button variant="outline" size="sm" onClick={edit}>
            Edit skill
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={`More for ${skill.name}`}
              className={buttonVariants({ variant: "ghost", size: "icon-sm" })}
            >
              <EllipsisIcon aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-48">
              <DropdownMenuItem onClick={edit}>
                <PencilIcon aria-hidden />
                Edit skill
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => setRemoving(true)}>
                <Trash2Icon aria-hidden />
                Remove skill…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Link
            to="/skills"
            aria-label={`Close ${skill.name}`}
            className={buttonVariants({ variant: "ghost", size: "icon-sm" })}
          >
            <XIcon aria-hidden />
          </Link>
        </div>
        <p className="mt-2.5 text-row text-muted-foreground">{when}</p>
        <p className="mt-1.5 text-row text-muted-foreground">{usedLine}</p>
      </header>
      <p className="border-b bg-muted/40 px-4 py-3 text-prose text-muted-foreground lg:hidden">
        {whenWords(skill, now)} {usedLine}
      </p>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {files.length > 1 ? (
          <nav aria-label="Files" className="flex flex-wrap gap-1.5 px-8 pt-4 max-lg:px-4">
            {files.map((entry) => (
              <Link
                key={entry.path}
                to="/skills/$skillId"
                params={{ skillId: skill.id }}
                search={fileSearch(entry.path, false)}
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
      <RemoveSkill skill={detail} open={removing} onOpenChange={setRemoving} />
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
