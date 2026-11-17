import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { Button, IconButton } from "#/components/kit/button";
import { Menu, MenuItem } from "#/components/kit/menu";
import { ModalDialog } from "#/components/kit/modal";
import { ErrorNote, errorText } from "#/components/kit/status";
import type { SkillDto } from "#/lib/api";
import { dropRemovedSkill, settleRemovedSkill } from "#/lib/skill-removal";
import { useTRPC } from "#/lib/trpc";

/**
 * The skill's other actions behind its More button: Remove, confirmed in a dialog that says what
 * removing does. Removing returns to the library the skill was in.
 */
export function SkillActions({ skill }: { readonly skill: SkillDto }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <Menu
        align="end"
        trigger={<IconButton icon="more" label={`More actions for ${skill.name}`} bordered />}
      >
        <MenuItem onClick={() => setConfirming(true)} className="text-danger">
          Remove skill…
        </MenuItem>
      </Menu>
      <ModalDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Remove ${skill.name}?`}
        description={
          skill.scope === "user"
            ? "New sessions in every project stop receiving it. Sessions that already started keep the copy they loaded."
            : "New sessions in this project stop receiving it. Sessions that already started keep the copy they loaded."
        }
        width={460}
      >
        {confirming ? <RemoveSkill skill={skill} onCancel={() => setConfirming(false)} /> : null}
      </ModalDialog>
    </>
  );
}

function RemoveSkill({
  skill,
  onCancel,
}: {
  readonly skill: SkillDto;
  readonly onCancel: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const remove = useMutation(
    trpc.skills.remove.mutationOptions({
      onSuccess: async () => {
        await dropRemovedSkill(queryClient, trpc, skill);
        await (skill.projectId === null
          ? navigate({ to: "/skills" })
          : navigate({
              to: "/projects/$projectId/configuration",
              params: { projectId: skill.projectId },
              hash: "skills",
            }));
        void settleRemovedSkill(queryClient, trpc, skill);
      },
    }),
  );
  return (
    <>
      {remove.error === null ? null : <ErrorNote>{errorText(remove.error)}</ErrorNote>}
      <div className="flex items-center justify-end gap-2.5">
        <Button variant="ghost" onClick={onCancel}>
          Keep it
        </Button>
        <Button
          variant="primary"
          disabled={remove.isPending}
          onClick={() => remove.mutate({ skillId: skill.id })}
          className="border-danger bg-danger hover:border-danger hover:bg-danger"
        >
          {remove.isPending ? "Removing…" : `Remove ${skill.name}`}
        </Button>
      </div>
    </>
  );
}
