import { SKILL_ENTRY_FILE, validateSkillName } from "@mend/domain/workbench";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { Button } from "#/components/kit/button";
import { Field, TextInput } from "#/components/kit/field";
import { ModalDialog } from "#/components/kit/modal";
import { ErrorNote, errorText } from "#/components/kit/status";
import { useTRPC } from "#/lib/trpc";

const SKILL_MD_TEMPLATE = `---
name: my-skill
description: One line saying when an agent should reach for this.
---

Instructions the agent loads when the skill applies.
`;

/**
 * New skill: a name, a line saying when to use it, and the first SKILL.md. Creating opens the
 * skill's page, where more files are added. The dialog keeps its draft while it is open and
 * starts clean the next time.
 */
export function NewSkillDialog() {
  const [open, setOpen] = useState(false);
  return (
    <ModalDialog
      open={open}
      onOpenChange={setOpen}
      trigger={<Button variant="primary">New skill</Button>}
      title="New skill"
      description="A skill is a folder of instructions every new session's agent can load. It starts as one SKILL.md."
      width={560}
    >
      {open ? <NewSkillForm onCancel={() => setOpen(false)} /> : null}
    </ModalDialog>
  );
}

function NewSkillForm({ onCancel }: { readonly onCancel: () => void }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [contents, setContents] = useState(SKILL_MD_TEMPLATE);
  const nameProblem = name === "" ? null : validateSkillName(name);
  const create = useMutation(
    trpc.skills.create.mutationOptions({
      onSuccess: async (created) => {
        queryClient.setQueryData(
          trpc.skills.detail.queryKey({ skillId: created.skill.id }),
          created,
        );
        await queryClient.invalidateQueries(trpc.skills.list.queryFilter());
        await navigate({ to: "/skills/$skillId", params: { skillId: created.skill.id } });
      },
    }),
  );
  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (name === "" || nameProblem !== null) return;
        create.mutate({
          scope: "user",
          projectId: null,
          name,
          description,
          files: [{ path: SKILL_ENTRY_FILE, contents }],
        });
      }}
    >
      <Field label="Name" source={<span>lowercase, becomes the folder name</span>}>
        {(id) => (
          <>
            <TextInput
              id={id}
              value={name}
              autoFocus
              required
              spellCheck={false}
              placeholder="review-pr"
              aria-invalid={nameProblem !== null}
              aria-describedby={nameProblem === null ? undefined : `${id}-problem`}
              onChange={(event) => setName(event.target.value.toLowerCase())}
            />
            {nameProblem === null ? null : (
              <p id={`${id}-problem`} role="alert" className="text-[12.5px] text-danger">
                {nameProblem}
              </p>
            )}
          </>
        )}
      </Field>
      <Field label="Description">
        {(id) => (
          <TextInput
            id={id}
            sans
            value={description}
            placeholder="When should an agent reach for this?"
            onChange={(event) => setDescription(event.target.value)}
          />
        )}
      </Field>
      <Field label={SKILL_ENTRY_FILE}>
        {(id) => (
          <textarea
            id={id}
            value={contents}
            rows={9}
            spellCheck={false}
            onChange={(event) => setContents(event.target.value)}
            className="w-full resize-y rounded-[10px] border border-input bg-panel px-3 py-[9px] font-mono text-[12.5px] leading-relaxed text-foreground outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring/30"
          />
        )}
      </Field>
      {create.error === null ? null : <ErrorNote>{errorText(create.error)}</ErrorNote>}
      <div className="flex items-center justify-end gap-2.5">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={create.isPending || name === "" || nameProblem !== null}
        >
          {create.isPending ? "Creating…" : "Create skill"}
        </Button>
      </div>
    </form>
  );
}
