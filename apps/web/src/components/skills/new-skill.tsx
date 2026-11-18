import { SKILL_ENTRY_FILE } from "@mend/domain/workbench";
import { Alert, AlertDescription } from "@mend/ui/components/ui/alert";
import { Button } from "@mend/ui/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@mend/ui/components/ui/field";
import { Input } from "@mend/ui/components/ui/input";
import { Textarea } from "@mend/ui/components/ui/textarea";
import { toast } from "@mend/ui/components/ui/toast";
import { cn } from "@mend/ui/lib/utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { CircleAlertIcon } from "lucide-react";
import { useId, useRef, useState } from "react";

import { usePhone } from "#/lib/phone";
import { failureWords, refusalTagOf } from "#/lib/refusal";
import {
  BLANK_SKILL_FILE,
  descriptionIssue,
  fileIssue,
  nameIssue,
  withFrontMatter,
} from "#/lib/skills";
import { useTRPC } from "#/lib/trpc";

import { Overlay } from "../projects/overlay.tsx";

/**
 * New skill… (Doop "Skills · new skill", "fields need fixing"): a name, when to use it, and the
 * first SKILL.md, whose front matter Mend fills in from the two fields. Each field's rule shows
 * under it once Create skill was pressed, and from then on as the person types; a refusal the
 * browser can't foresee is the server's own words above the buttons. Creating opens the skill.
 */
export function NewSkill({
  open,
  onOpenChange,
  taken,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The names already in the list, so a taken name is said before the server is asked. */
  readonly taken: ReadonlyArray<string>;
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
    />
  );
}

function NewSkillForm({
  open,
  onOpenChange,
  taken,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly taken: ReadonlyArray<string>;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const phone = usePhone();
  const id = useId();
  const nameField = useRef<HTMLInputElement>(null);
  const descriptionField = useRef<HTMLInputElement>(null);
  const contentsField = useRef<HTMLTextAreaElement>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [contents, setContents] = useState(BLANK_SKILL_FILE);
  const [tried, setTried] = useState(false);
  // A name the server said is taken that the list didn't hold yet (made elsewhere meanwhile).
  const [takenElsewhere, setTakenElsewhere] = useState<string | null>(null);

  const create = useMutation(
    trpc.skills.create.mutationOptions({
      onSuccess: async (created) => {
        queryClient.setQueryData(
          trpc.skills.detail.queryKey({ skillId: created.skill.id }),
          created,
        );
        void queryClient.invalidateQueries(trpc.skills.list.queryFilter());
        onOpenChange(false);
        await navigate({ to: "/skills/$skillId", params: { skillId: created.skill.id } });
        toast.add({ description: `Created ${created.skill.name}` });
      },
      onError: (error) => {
        if (refusalTagOf(error) === "SkillRejected" && error.message.includes("already exists")) {
          setTakenElsewhere(name);
          nameField.current?.focus();
        }
      },
    }),
  );

  const issues = {
    name: nameIssue(name, takenElsewhere === null ? taken : [...taken, takenElsewhere]),
    description: descriptionIssue(description),
    contents: fileIssue({ path: SKILL_ENTRY_FILE, contents }),
  };
  const shown = (issue: string | null) => (tried ? issue : null);
  // A refusal already said beside a field isn't said again above the buttons.
  const refusal =
    create.isError && !(takenElsewhere !== null && takenElsewhere === name)
      ? failureWords(create.error, "Mend couldn't create the skill. Try again.")
      : null;

  const submit = () => {
    setTried(true);
    if (issues.name !== null) return nameField.current?.focus();
    if (issues.description !== null) return descriptionField.current?.focus();
    if (issues.contents !== null) return contentsField.current?.focus();
    create.mutate({
      scope: "user",
      projectId: null,
      name,
      description,
      files: [{ path: SKILL_ENTRY_FILE, contents }],
    });
  };

  const size = phone ? "touch" : "default";
  return (
    <Overlay
      open={open}
      onOpenChange={(next) => {
        if (!create.isPending) onOpenChange(next);
      }}
      title="New skill"
      description="A skill starts as one file, SKILL.md. You can add more files to it once it exists."
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
        <Field data-invalid={shown(issues.name) !== null || undefined}>
          <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
          <Input
            ref={nameField}
            id={`${id}-name`}
            value={name}
            autoFocus
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
          <FieldNote
            id={`${id}-name-note`}
            issue={shown(issues.name)}
            hint="Lowercase letters, digits, dots, dashes and underscores. It becomes the skill's folder name."
          />
        </Field>
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
