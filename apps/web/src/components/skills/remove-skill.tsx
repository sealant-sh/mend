import { Alert, AlertDescription } from "@mend/ui/components/ui/alert";
import { Button } from "@mend/ui/components/ui/button";
import { toast } from "@mend/ui/components/ui/toast";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { CircleAlertIcon } from "lucide-react";
import type { ReactNode } from "react";

import type { SkillDetailDto } from "#/lib/api";
import { usePhone } from "#/lib/phone";
import { afterRemovalWords, doneWords, type SkillOwner, skillsHome } from "#/lib/project-skills";
import { failureWords, refusalTagOf } from "#/lib/refusal";
import { dropRemovedSkill, settleRemovedSkill } from "#/lib/skill-removal";
import { skillFilesLine } from "#/lib/skills";
import { useTRPC } from "#/lib/trpc";
import { useSkillTwins, useYourSkillNamed } from "#/lib/use-skill-twins";

import { Overlay } from "../projects/overlay.tsx";

/**
 * Remove skill… (Doop "Skills · remove skill confirmation", "can't remove", and the project's
 * "remove" and "can't remove"): what removing does to sessions, what goes, and Keep skill or Remove
 * skill. On a project's skill it says your own of the same name is used there again. A skill already
 * removed elsewhere, or a project being removed, says so and offers only Close; any other refusal is
 * the server's own words, with both buttons kept.
 */
export function RemoveSkill({
  skill: detail,
  owner,
  open,
  onOpenChange,
}: {
  readonly skill: SkillDetailDto;
  readonly owner: SkillOwner;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { skill } = detail;
  const twins = useSkillTwins(owner.kind === "you" ? [skill] : undefined).get(skill.name) ?? [];
  const yours = useYourSkillNamed(owner.kind === "project" ? skill.name : undefined);
  const leave = async () => {
    await dropRemovedSkill(queryClient, trpc, skill);
    await navigate(skillsHome(owner));
    void settleRemovedSkill(queryClient, trpc, skill);
  };
  const remove = useMutation(
    trpc.skills.remove.mutationOptions({
      onSuccess: async () => {
        onOpenChange(false);
        await leave();
        toast.add({ description: doneWords(owner, "Removed", skill.name) });
      },
    }),
  );
  const tag = remove.isError ? refusalTagOf(remove.error) : null;
  const gone = tag === "NotFound";
  // The project is being removed: nothing in it can change until it is restored.
  const frozen = tag === "RemovalInProgress";
  const close = (next: boolean) => {
    if (remove.isPending) return;
    onOpenChange(next);
    if (!next) {
      if (gone) void leave();
      remove.reset();
    }
  };

  const title =
    owner.kind === "you"
      ? `Remove ${skill.name}?`
      : `Remove ${skill.name} from ${owner.projectName}?`;
  const description =
    owner.kind === "you"
      ? "New sessions stop getting this skill. Sessions that already started keep the copy they loaded. You can't undo this."
      : `New sessions in ${owner.projectName} stop getting it, for everyone who works there. Sessions that already started keep the copy they loaded. You can't undo this.`;
  const rows: ReadonlyArray<readonly [string, string]> =
    owner.kind === "you"
      ? [
          ["Files", skillFilesLine(skill)],
          [
            "Used in",
            twins.length === 0
              ? "Every session you start, in every project"
              : `Every session you start, except in ${twins.map((twin) => twin.projectName).join(", ")}`,
          ],
        ]
      : [
          ["Files", skillFilesLine(skill)],
          ["Used by", `Everyone's new sessions in ${owner.projectName}`],
          ...(yours === undefined ? [] : [["Afterwards", afterRemovalWords(skill.name)] as const]),
        ];

  return (
    <Overlay
      open={open}
      onOpenChange={close}
      title={title}
      description={description}
      size="sm"
      footer={
        <RemoveButtons
          ended={gone || frozen}
          pending={remove.isPending}
          onClose={() => close(false)}
          onRemove={() => remove.mutate({ skillId: skill.id })}
        />
      }
    >
      {remove.isError ? (
        <Alert tone="error">
          <CircleAlertIcon aria-hidden />
          <AlertDescription className="text-row text-muted-foreground">
            <p>
              <strong className="font-semibold text-foreground">
                {gone ? "Already removed." : "Not removed."}
              </strong>{" "}
              {refusalWords(owner, skill.name, tag, remove.error)}
            </p>
          </AlertDescription>
        </Alert>
      ) : (
        <dl className="grid grid-cols-[auto_1fr] border-t text-row [&>*]:border-b [&>*]:py-3">
          {rows.map(([term, value]) => (
            <div key={term} className="contents">
              <dt className="pr-6">{term}</dt>
              <dd className="text-right text-muted-foreground">{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </Overlay>
  );
}

/** Keep skill and Remove skill; once nothing can be removed, only Close. */
function RemoveButtons({
  ended,
  pending,
  onClose,
  onRemove,
}: {
  readonly ended: boolean;
  readonly pending: boolean;
  readonly onClose: () => void;
  readonly onRemove: () => void;
}) {
  const size = usePhone() ? "touch" : "default";
  if (ended)
    return (
      <Button variant="outline" size={size} onClick={onClose}>
        Close
      </Button>
    );
  return (
    <>
      <Button variant="outline" size={size} disabled={pending} onClick={onClose}>
        Keep skill
      </Button>
      <Button variant="destructive" size={size} disabled={pending} onClick={onRemove}>
        {pending ? "Removing…" : "Remove skill"}
      </Button>
    </>
  );
}

/** Why the skill wasn't removed, in a person's words. */
function refusalWords(
  owner: SkillOwner,
  name: string,
  tag: string | null,
  error: unknown,
): ReactNode {
  if (tag === "NotFound")
    return owner.kind === "you" ? (
      <>
        {name} was removed somewhere else, from another browser or by{" "}
        <code className="font-mono text-meta">mend skills push --prune</code>. There is nothing left
        to remove.
      </>
    ) : (
      `${name} was removed from ${owner.projectName} somewhere else, or you can no longer change its skills. There is nothing left to remove here.`
    );
  if (tag === "RemovalInProgress" && owner.kind === "project")
    return `${owner.projectName} is being removed, so its skills can't change. If ${owner.projectName} is restored, try again.`;
  return failureWords(error, "Mend couldn't remove it. Try again.");
}
