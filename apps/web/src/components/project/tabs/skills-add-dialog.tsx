import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { SKILL_ENTRY_FILE, validateSkillName } from "@mend/domain/workbench";
import { cn } from "@mend/ui/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { Button } from "#/components/kit/button";
import { Field, GroupField, TextInput } from "#/components/kit/field";
import { Icon } from "#/components/kit/icons";
import { ModalDialog } from "#/components/kit/modal";
import { Segment } from "#/components/kit/segment";
import { blankSkillFile, skillShape } from "#/components/skill-editor/model";
import { createSkill, type ProjectDto, type SkillDto } from "#/lib/api";
import { failureWords } from "#/lib/refusal";
import { useTRPC } from "#/lib/trpc";

type StartFrom = "blank" | "copy";

/** Why a project skill cannot take this name, or null when it can. */
export const projectSkillNameIssue = (
  name: string,
  projectSkills: ReadonlyArray<Pick<SkillDto, "name">>,
  projectName: string,
): string | null =>
  validateSkillName(name) ??
  (projectSkills.some((skill) => skill.name === name)
    ? `${projectName} already has a skill named ${name}`
    : null);

/**
 * Add a skill to a project (screen K7): start blank, or copy one from your library with all its
 * files. The copy is the project's own from then on: editing it never changes your library. Add
 * and edit opens the new skill in the editor (K8).
 */
export function AddSkillDialog({
  project,
  projectSkills,
}: {
  readonly project: ProjectDto;
  readonly projectSkills: ReadonlyArray<SkillDto>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <ModalDialog
      open={open}
      onOpenChange={setOpen}
      trigger={<Button size="sm">Add a skill</Button>}
      title={`Add a skill to ${project.name}`}
      description={`Project skills are shared with everyone who can see ${project.name}. Sessions in this project load them next to your library.`}
    >
      {open ? (
        <AddSkillForm
          project={project}
          projectSkills={projectSkills}
          onCancel={() => setOpen(false)}
        />
      ) : null}
    </ModalDialog>
  );
}

function AddSkillForm({
  project,
  projectSkills,
  onCancel,
}: {
  readonly project: ProjectDto;
  readonly projectSkills: ReadonlyArray<SkillDto>;
  readonly onCancel: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const library = useQuery(trpc.skills.list.queryOptions());
  const [from, setFrom] = useState<StartFrom>("copy");
  const [pickedId, setPickedId] = useState<SkillDto["id"] | null>(null);
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [tried, setTried] = useState(false);
  const projectNames = new Set(projectSkills.map((skill) => skill.name));
  const picked = library.data?.find((skill) => skill.id === pickedId);

  const add = useMutation({
    mutationFn: async () => {
      if (from === "blank")
        return createSkill({
          scope: "project",
          projectId: project.id,
          name,
          description: "",
          files: [{ path: SKILL_ENTRY_FILE, contents: blankSkillFile(name) }],
        });
      if (picked === undefined) throw new Error("Pick a skill from your library to copy.");
      const source = await queryClient.fetchQuery(
        trpc.skills.detail.queryOptions({ skillId: picked.id }),
      );
      return createSkill({
        scope: "project",
        projectId: project.id,
        name,
        description: source.skill.description,
        files: source.files.map((file) => ({ path: file.path, contents: file.contents })),
      });
    },
    onSuccess: async (created) => {
      await queryClient.invalidateQueries(trpc.skills.forProject.queryFilter({ id: project.id }));
      await navigate({
        to: "/projects/$projectId/skills/$skillId",
        params: { projectId: project.id, skillId: created.skill.id },
        search: { edit: true },
      });
    },
  });

  const nameIssue = projectSkillNameIssue(name, projectSkills, project.name);
  const pickIssue = from === "copy" && picked === undefined ? "Pick a skill to copy." : null;
  const showNameIssue = tried || (nameTouched && name !== "") ? nameIssue : null;

  const pick = (skill: SkillDto) => {
    setPickedId(skill.id);
    if (!nameTouched) setName(skill.name);
  };

  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        setTried(true);
        if (nameIssue === null && pickIssue === null) add.mutate();
      }}
    >
      <GroupField label="Start from">
        <Segment
          label="Start from"
          value={from}
          disabled={add.isPending}
          onChange={setFrom}
          options={[
            { value: "blank", label: "Blank" },
            { value: "copy", label: "Copy from your library" },
          ]}
        />
      </GroupField>
      {from === "copy" ? (
        <GroupField label="Skill">
          {library.isPending ? (
            <p role="status" className="font-mono text-[12px] text-faint">
              Reading your library…
            </p>
          ) : library.isError ? (
            <p role="alert" className="font-mono text-[12px] text-danger">
              Your library did not load: {library.error.message}
            </p>
          ) : library.data.length === 0 ? (
            <p className="font-mono text-[12px] text-faint">
              Your library is empty. Start blank instead.
            </p>
          ) : (
            <RadioGroup
              aria-label="Skill to copy"
              value={pickedId}
              disabled={add.isPending}
              onValueChange={(value) => {
                const skill = library.data.find((entry) => entry.id === value);
                if (skill !== undefined) pick(skill);
              }}
              className="grid max-h-[240px] overflow-y-auto rounded-[14px] border border-rule p-1.5"
            >
              {library.data.map((skill) => (
                <Radio.Root
                  key={skill.id}
                  value={skill.id}
                  className={cn(
                    "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 rounded-[10px] px-3 py-[9px] text-left outline-none [&+&]:mt-px focus-visible:bg-wash data-checked:bg-wash/60",
                  )}
                >
                  <span className="min-w-0 truncate font-mono text-[13px] font-medium text-foreground">
                    {skill.name}
                  </span>
                  <span className="row-span-2 text-info">
                    <Radio.Indicator keepMounted={false}>
                      <Icon name="check" size={15} />
                    </Radio.Indicator>
                  </span>
                  <span className="font-mono text-[11.5px] text-muted-foreground">
                    {skillShape(skill)}
                    {projectNames.has(skill.name) ? ` · already in ${project.name}` : ""}
                  </span>
                </Radio.Root>
              ))}
            </RadioGroup>
          )}
          {tried && pickIssue !== null ? (
            <p role="alert" className="font-mono text-[11.5px] text-danger">
              {pickIssue}
            </p>
          ) : null}
        </GroupField>
      ) : null}
      <Field label={`Name in ${project.name}`}>
        {(id) => (
          <>
            <TextInput
              id={id}
              value={name}
              disabled={add.isPending}
              placeholder="figma-handoff"
              aria-invalid={showNameIssue !== null ? true : undefined}
              aria-describedby={`${id}-issue`}
              onChange={(event) => {
                setName(event.target.value.toLowerCase());
                setNameTouched(true);
              }}
            />
            <p
              id={`${id}-issue`}
              role="alert"
              className="font-mono text-[11.5px] text-danger empty:hidden"
            >
              {showNameIssue ?? ""}
            </p>
          </>
        )}
      </Field>
      <p role="alert" className="font-mono text-[12px] text-danger empty:hidden">
        {add.isError ? `Not added: ${failureWords(add.error, "the server refused the skill")}` : ""}
      </p>
      <div className="flex items-center justify-end gap-2.5">
        <Button variant="ghost" onClick={onCancel} disabled={add.isPending}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={add.isPending}>
          {add.isPending ? (from === "copy" ? "Copying…" : "Adding…") : "Add and edit"}
        </Button>
      </div>
    </form>
  );
}
