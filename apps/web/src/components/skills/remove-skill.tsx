import { Alert, AlertDescription } from "@mend/ui/components/ui/alert";
import { Button } from "@mend/ui/components/ui/button";
import { toast } from "@mend/ui/components/ui/toast";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { CircleAlertIcon } from "lucide-react";

import type { SkillDetailDto } from "#/lib/api";
import { usePhone } from "#/lib/phone";
import { failureWords, refusalTagOf } from "#/lib/refusal";
import { dropRemovedSkill, settleRemovedSkill } from "#/lib/skill-removal";
import { skillFilesLine } from "#/lib/skills";
import { useTRPC } from "#/lib/trpc";
import { useSkillTwins } from "#/lib/use-skill-twins";

import { Overlay } from "../projects/overlay.tsx";

/**
 * Remove skill… (Doop "Skills · remove skill confirmation", "can't remove"): what removing does to
 * sessions, what goes, and Keep skill or Remove skill. A skill already removed elsewhere says so
 * and offers only Close; any other refusal is the server's own words, with both buttons kept.
 */
export function RemoveSkill({
  skill: detail,
  open,
  onOpenChange,
}: {
  readonly skill: SkillDetailDto;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const phone = usePhone();
  const { skill } = detail;
  const twins = useSkillTwins([skill]).get(skill.name) ?? [];
  const leave = async () => {
    await dropRemovedSkill(queryClient, trpc, skill);
    await navigate({ to: "/skills" });
    void settleRemovedSkill(queryClient, trpc, skill);
  };
  const remove = useMutation(
    trpc.skills.remove.mutationOptions({
      onSuccess: async () => {
        onOpenChange(false);
        await leave();
        toast.add({ description: `Removed ${skill.name}` });
      },
    }),
  );
  const gone = remove.isError && refusalTagOf(remove.error) === "NotFound";
  const size = phone ? "touch" : "default";
  const close = (next: boolean) => {
    if (remove.isPending) return;
    onOpenChange(next);
    if (!next) {
      if (gone) void leave();
      remove.reset();
    }
  };

  return (
    <Overlay
      open={open}
      onOpenChange={close}
      title={`Remove ${skill.name}?`}
      description="New sessions stop getting this skill. Sessions that already started keep the copy they loaded. You can't undo this."
      size="sm"
      footer={
        gone ? (
          <Button variant="outline" size={size} onClick={() => close(false)}>
            Close
          </Button>
        ) : (
          <>
            <Button
              variant="outline"
              size={size}
              disabled={remove.isPending}
              onClick={() => close(false)}
            >
              Keep skill
            </Button>
            <Button
              variant="destructive"
              size={size}
              disabled={remove.isPending}
              onClick={() => remove.mutate({ skillId: skill.id })}
            >
              {remove.isPending ? "Removing…" : "Remove skill"}
            </Button>
          </>
        )
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
              {gone ? (
                <>
                  {skill.name} was removed somewhere else, from another browser or by{" "}
                  <code className="font-mono text-meta">mend skills push --prune</code>. There is
                  nothing left to remove.
                </>
              ) : (
                failureWords(remove.error, "Mend couldn't remove it. Try again.")
              )}
            </p>
          </AlertDescription>
        </Alert>
      ) : (
        <dl className="grid grid-cols-[auto_1fr] border-t text-row [&>*]:border-b [&>*]:py-3">
          <dt className="pr-6">Files</dt>
          <dd className="text-right text-muted-foreground">{skillFilesLine(skill)}</dd>
          <dt className="pr-6">Used in</dt>
          <dd className="text-right text-muted-foreground">
            {twins.length === 0
              ? "Every session you start, in every project"
              : `Every session you start, except in ${twins.map((twin) => twin.projectName).join(", ")}`}
          </dd>
        </dl>
      )}
    </Overlay>
  );
}
