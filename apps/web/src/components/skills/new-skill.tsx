import { SKILL_ENTRY_FILE } from "@mend/domain/workbench";
import { Segmented } from "@mend/ui/components/segmented";
import { Alert, AlertDescription } from "@mend/ui/components/ui/alert";
import { Button } from "@mend/ui/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@mend/ui/components/ui/field";
import { Input } from "@mend/ui/components/ui/input";
import { Skeleton } from "@mend/ui/components/ui/skeleton";
import { Textarea } from "@mend/ui/components/ui/textarea";
import { toast } from "@mend/ui/components/ui/toast";
import { cn } from "@mend/ui/lib/utils";
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { CheckIcon, CircleAlertIcon } from "lucide-react";
import { type ReactNode, type Ref, useId, useRef, useState } from "react";

import type { SkillDto } from "#/lib/api";
import { usePhone } from "#/lib/phone";
import {
  copiedFiles,
  copyLine,
  doneWords,
  sameNameAsYours,
  skillAt,
  type SkillOwner,
} from "#/lib/project-skills";
import { failureWords, refusalTagOf } from "#/lib/refusal";
import {
  BLANK_SKILL_FILE,
  descriptionIssue,
  fileIssue,
  nameIssue,
  withFrontMatter,
} from "#/lib/skills";
import { useTRPC, useTRPCClient } from "#/lib/trpc";

import { Overlay } from "../projects/overlay.tsx";

/**
 * New skill… (Doop "Skills · new skill", "fields need fixing", and the project's "new skill" and
 * "fields need fixing"): a name, when to use it, and the first SKILL.md, whose front matter Mend
 * fills in from the two fields. On a project it can instead start as a copy of one of your skills
 * with all its files, under a name in the project; a copy with your skill's name says the project's
 * copy is used there instead of yours. Each field's rule shows under it once Create skill was
 * pressed, and from then on as the person types; a refusal the browser can't foresee is the
 * server's own words above the buttons. Creating opens the skill.
 */
export function NewSkill({
  open,
  onOpenChange,
  taken,
  owner,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The names already in the list, so a taken name is said before the server is asked. */
  readonly taken: ReadonlyArray<string>;
  readonly owner: SkillOwner;
}) {
  // A fresh form each time it opens.
  const [generation, setGeneration] = useState(0);
  return (
    <NewSkillForm
      key={generation}
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setGeneration((value) => value + 1);
      }}
      taken={taken}
      owner={owner}
    />
  );
}

/** What Create skill sends: a skill typed here, or a copy of one of yours by its id. */
interface Draft {
  readonly name: string;
  readonly description: string;
  readonly contents: string;
  readonly copyOf: string | null;
}

function NewSkillForm({
  open,
  onOpenChange,
  taken,
  owner,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly taken: ReadonlyArray<string>;
  readonly owner: SkillOwner;
}) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const phone = usePhone();
  const id = useId();
  const nameField = useRef<HTMLInputElement>(null);
  const descriptionField = useRef<HTMLInputElement>(null);
  const contentsField = useRef<HTMLTextAreaElement>(null);
  const pickField = useRef<HTMLDivElement>(null);
  const project = owner.kind === "project" ? owner : null;
  const yours = useQuery({ ...trpc.skills.list.queryOptions(), enabled: project !== null });
  const [from, setFrom] = useState<"empty" | "copy">("empty");
  const [picked, setPicked] = useState<SkillDto | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [contents, setContents] = useState(BLANK_SKILL_FILE);
  const [tried, setTried] = useState(false);
  // A name the server said is taken that the list didn't hold yet (made elsewhere meanwhile).
  const [takenElsewhere, setTakenElsewhere] = useState<string | null>(null);
  const copying = project !== null && from === "copy";

  const create = useMutation({
    mutationFn: async (draft: Draft) => {
      if (project === null)
        return client.skills.create.mutate({
          scope: "user",
          projectId: null,
          name: draft.name,
          description: draft.description,
          files: [{ path: SKILL_ENTRY_FILE, contents: draft.contents }],
        });
      if (draft.copyOf === null)
        return client.skills.create.mutate({
          scope: "project",
          projectId: project.projectId,
          name: draft.name,
          description: draft.description,
          files: [{ path: SKILL_ENTRY_FILE, contents: draft.contents }],
        });
      // The copy takes every file of yours as it is now, not as the list last read it.
      const source = await queryClient.fetchQuery({
        ...trpc.skills.detail.queryOptions({ skillId: draft.copyOf }),
        staleTime: 0,
      });
      return client.skills.create.mutate({
        scope: "project",
        projectId: project.projectId,
        name: draft.name,
        description: source.skill.description,
        files: [...copiedFiles(source, draft.name)],
      });
    },
    onSuccess: async (created, draft) => {
      queryClient.setQueryData(trpc.skills.detail.queryKey({ skillId: created.skill.id }), created);
      void queryClient.invalidateQueries(trpc.skills.list.queryFilter());
      void queryClient.invalidateQueries(trpc.skills.forProject.pathFilter());
      onOpenChange(false);
      await navigate(skillAt(owner, created.skill.id));
      toast.add({
        description: doneWords(
          owner,
          draft.copyOf === null ? "Created" : "Added",
          created.skill.name,
        ),
      });
    },
    onError: (error, draft) => {
      if (refusalTagOf(error) === "SkillRejected" && error.message.includes("already exists")) {
        setTakenElsewhere(draft.name);
        nameField.current?.focus();
      }
    },
  });

  const yourNames = yours.status === "success" ? yours.data.map((skill) => skill.name) : [];
  const issues = {
    name: nameIssue(
      name,
      takenElsewhere === null ? taken : [...taken, takenElsewhere],
      project?.projectName ?? null,
    ),
    description: copying ? null : descriptionIssue(description),
    contents: copying ? null : fileIssue({ path: SKILL_ENTRY_FILE, contents }),
    pick: copying && picked === null ? "Pick one of your skills to copy." : null,
  };
  const shown = (issue: string | null) => (tried ? issue : null);
  // A refusal already said beside a field isn't said again above the buttons.
  const refusal =
    create.isError && !(takenElsewhere !== null && takenElsewhere === name)
      ? failureWords(create.error, "Mend couldn't create the skill. Try again.")
      : null;

  const submit = () => {
    setTried(true);
    if (issues.pick !== null) return pickField.current?.focus();
    if (issues.name !== null) return nameField.current?.focus();
    if (issues.description !== null) return descriptionField.current?.focus();
    if (issues.contents !== null) return contentsField.current?.focus();
    create.mutate({ name, description, contents, copyOf: copying ? (picked?.id ?? null) : null });
  };
  const pick = (skill: SkillDto) => {
    // The name follows the pick until the person types one of their own.
    if (name === "" || name === picked?.name) setName(skill.name);
    setPicked(skill);
  };

  const size = phone ? "touch" : "default";
  const nameHint =
    project !== null && yourNames.includes(name)
      ? sameNameAsYours(project.projectName)
      : "Lowercase letters, digits, dots, dashes and underscores. It becomes the skill's folder name.";
  return (
    <Overlay
      open={open}
      onOpenChange={(next) => {
        if (!create.isPending) onOpenChange(next);
      }}
      title={project === null ? "New skill" : `New skill in ${project.projectName}`}
      description={
        project === null
          ? "A skill starts as one file, SKILL.md. You can add more files to it once it exists."
          : `Everyone who can open ${project.projectName} gets this skill in their new sessions there.${phone ? "" : " Start from an empty SKILL.md, or copy one of your skills with all its files."}`
      }
      size="md"
      footer={
        <>
          <Button
            variant="outline"
            size={size}
            disabled={create.isPending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button size={size} disabled={create.isPending} onClick={submit}>
            {create.isPending ? "Creating…" : "Create skill"}
          </Button>
        </>
      }
    >
      <form
        id={`${id}-form`}
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {project === null ? null : (
          <Field>
            <FieldLabel id={`${id}-from`}>Start from</FieldLabel>
            <Segmented
              aria-label="Start from"
              size={size}
              className={cn(phone && "w-full")}
              value={from}
              disabled={create.isPending}
              onValueChange={setFrom}
              options={[
                { value: "empty", label: "Empty skill" },
                { value: "copy", label: phone ? "Copy one of yours" : "Copy one of your skills" },
              ]}
            />
          </Field>
        )}
        {copying ? (
          <CopyPicker
            id={id}
            ref={pickField}
            projectName={project.projectName}
            yours={yours}
            taken={taken}
            picked={picked}
            onPick={pick}
            issue={shown(issues.pick)}
            phone={phone}
          />
        ) : null}
        <Field data-invalid={shown(issues.name) !== null || undefined}>
          <FieldLabel htmlFor={`${id}-name`}>
            {copying ? `Name in ${project.projectName}` : "Name"}
          </FieldLabel>
          <Input
            ref={nameField}
            id={`${id}-name`}
            value={name}
            autoFocus={project === null}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={shown(issues.name) !== null || undefined}
            aria-describedby={`${id}-name-note`}
            onChange={(event) => {
              const next = event.target.value.toLowerCase();
              setName(next);
              setContents((current) => withFrontMatter(current, next, description));
            }}
            className="h-9 font-mono max-lg:h-11"
          />
          <FieldNote id={`${id}-name-note`} issue={shown(issues.name)} hint={nameHint} />
        </Field>
        {copying ? null : (
          <>
            <Field data-invalid={shown(issues.description) !== null || undefined}>
              <FieldLabel htmlFor={`${id}-description`}>Description</FieldLabel>
              <Input
                ref={descriptionField}
                id={`${id}-description`}
                value={description}
                autoComplete="off"
                aria-invalid={shown(issues.description) !== null || undefined}
                aria-describedby={`${id}-description-note`}
                onChange={(event) => {
                  const next = event.target.value;
                  setDescription(next);
                  setContents((current) => withFrontMatter(current, name, next));
                }}
                className="h-9 max-lg:h-11 max-lg:text-base"
              />
              <FieldNote
                id={`${id}-description-note`}
                issue={shown(issues.description)}
                hint="Agents read this to decide when to use the skill."
              />
            </Field>
            <Field data-invalid={shown(issues.contents) !== null || undefined}>
              <FieldLabel htmlFor={`${id}-contents`} className="font-mono">
                {SKILL_ENTRY_FILE}
              </FieldLabel>
              <Textarea
                ref={contentsField}
                id={`${id}-contents`}
                value={contents}
                rows={phone ? 7 : 9}
                spellCheck={false}
                aria-invalid={shown(issues.contents) !== null || undefined}
                aria-describedby={`${id}-contents-note`}
                onChange={(event) => setContents(event.target.value)}
                className="max-h-[40dvh] resize-y font-mono text-meta leading-relaxed"
              />
              <FieldNote
                id={`${id}-contents-note`}
                issue={shown(issues.contents)}
                hint="Mend fills in the name and description at the top from the fields above."
              />
            </Field>
          </>
        )}
        {refusal === null ? null : (
          <Alert tone="error">
            <CircleAlertIcon aria-hidden />
            <AlertDescription className="text-row text-muted-foreground">
              <p>
                <strong className="font-semibold text-foreground">Not created.</strong> {refusal}
              </p>
            </AlertDescription>
          </Alert>
        )}
        {/* Enter in a field creates the skill, as the button does. */}
        <button type="submit" hidden aria-hidden tabIndex={-1} />
      </form>
    </Overlay>
  );
}

/**
 * "Skill to copy": your skills, one to pick, each with its files and size, and a note on one whose
 * name the project already has. Your skills are read when the choice opens.
 */
function CopyPicker({
  id,
  ref,
  projectName,
  yours,
  taken,
  picked,
  onPick,
  issue,
  phone,
}: {
  readonly id: string;
  readonly ref: Ref<HTMLDivElement>;
  readonly projectName: string;
  readonly yours: UseQueryResult<ReadonlyArray<SkillDto>, unknown>;
  readonly taken: ReadonlyArray<string>;
  readonly picked: SkillDto | null;
  readonly onPick: (skill: SkillDto) => void;
  readonly issue: string | null;
  readonly phone: boolean;
}) {
  const list = (): ReactNode => {
    switch (yours.status) {
      case "pending":
        return (
          <div aria-busy className="grid gap-2 p-3">
            <span className="sr-only">Reading your skills…</span>
            <Skeleton className="h-3 w-1/3" />
            <Skeleton className="h-3 w-1/4" />
            <Skeleton className="mt-2 h-3 w-2/5" />
          </div>
        );
      case "error":
        return (
          <div className="p-3 text-row text-muted-foreground">
            <p>
              <strong className="font-semibold text-foreground">Couldn't read your skills.</strong>{" "}
              {failureWords(yours.error, "Check your connection, then try again.")}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-2.5 max-lg:h-11 max-lg:px-4"
              disabled={yours.isFetching}
              onClick={() => void yours.refetch()}
            >
              {yours.isFetching ? "Trying again…" : "Try again"}
            </Button>
          </div>
        );
      case "success":
        return yours.data.length === 0 ? (
          <p className="p-3 text-row text-muted-foreground">
            You have no skills of your own to copy yet. Start from an empty skill instead.
          </p>
        ) : (
          <div
            ref={ref}
            role="radiogroup"
            aria-labelledby={`${id}-copy`}
            aria-describedby={`${id}-copy-note`}
            aria-invalid={issue !== null || undefined}
            tabIndex={-1}
            className="flex max-h-72 flex-col gap-0.5 overflow-y-auto p-1 outline-none"
          >
            {yours.data.map((skill) => {
              const chosen = picked?.id === skill.id;
              const there = taken.includes(skill.name);
              return (
                <button
                  key={skill.id}
                  type="button"
                  role="radio"
                  aria-checked={chosen}
                  onClick={() => onPick(skill)}
                  className={cn(
                    "flex items-center gap-3 rounded-md px-3 py-2 text-left outline-none hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50 max-lg:min-h-14",
                    chosen && "bg-muted hover:bg-muted",
                  )}
                >
                  <span className="grid min-w-0 flex-1 gap-0.5">
                    <span className="truncate font-mono text-meta text-foreground max-lg:text-row">
                      {skill.name}
                    </span>
                    <span className="text-row text-muted-foreground">
                      {there
                        ? phone
                          ? `${projectName} already has one`
                          : `${copyLine(skill)}. ${projectName} already has a skill with this name.`
                        : copyLine(skill)}
                    </span>
                  </span>
                  {chosen ? (
                    <CheckIcon aria-hidden className="size-4 shrink-0 text-primary" />
                  ) : null}
                </button>
              );
            })}
          </div>
        );
    }
  };
  return (
    <Field data-invalid={issue !== null || undefined}>
      <FieldLabel id={`${id}-copy`}>Skill to copy</FieldLabel>
      <div className={cn("rounded-lg border", issue !== null && "border-destructive")}>
        {list()}
      </div>
      <FieldNote
        id={`${id}-copy-note`}
        issue={issue}
        hint={`The copy belongs to ${projectName}. Changing it later doesn't change yours.`}
      />
    </Field>
  );
}

/** Under a field: its rule in red with an icon while it is broken, else a quiet hint. */
export function FieldNote({
  id,
  issue,
  hint,
  className,
}: {
  readonly id: string;
  readonly issue: string | null;
  readonly hint?: string;
  readonly className?: string;
}) {
  if (issue !== null)
    return (
      <FieldError id={id} className={cn("flex gap-1.5 text-row max-lg:text-sm", className)}>
        <CircleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        <span>{issue}</span>
      </FieldError>
    );
  return hint === undefined ? null : (
    <FieldDescription id={id} className={cn("text-row max-lg:text-sm", className)}>
      {hint}
    </FieldDescription>
  );
}
