import { InlineAlert } from "@mend/ui/components/banner";
import { Button } from "@mend/ui/components/ui/button";
import { Label } from "@mend/ui/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@mend/ui/components/ui/native-select";
import { toast } from "@mend/ui/components/ui/toast";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Overlay } from "#/components/projects/overlay";
import { restoreCheckpoint } from "#/lib/api";
import { wentBackWords } from "#/lib/checkpoint-restores";
import { usePhone } from "#/lib/phone";
import { failureWords } from "#/lib/refusal";
import { useTRPC } from "#/lib/trpc";

/** A checkpoint the dialog can go back to. */
export interface GoBackChoice {
  readonly id: string;
  readonly ordinal: number;
  /** What it was: "Turn ended", "Marked by hand". */
  readonly words: string;
  readonly createdAt: Date | string;
}

const timeOf = (at: Date | string): string =>
  new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/**
 * Go back to a checkpoint (SLNT-1259): the one confirmation, from the checkpoint line in the
 * conversation or from the Change view's range picker. It says what changes before anything
 * does: the worktree's files go back, every session in the worktree sees it, and Mend saves the
 * files as they are first so going back can be undone. The server does the restore and refuses
 * while an agent works; the refusal shows here in its own words. With several choices, the
 * person picks the checkpoint here.
 */
export function GoBackDialog({
  sessionId,
  choices,
  initial,
  open,
  onOpenChange,
}: {
  readonly sessionId: string;
  /** Newest first. One choice: the dialog names it and asks no more. */
  readonly choices: ReadonlyArray<GoBackChoice>;
  readonly initial: string | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const phone = usePhone();
  const size = phone ? "touch" : "default";
  const [picked, setPicked] = useState(initial ?? choices[0]?.id ?? "");
  const goBack = useMutation({
    mutationFn: (checkpointId: string) => restoreCheckpoint(sessionId, checkpointId),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries(trpc.sessions.pathFilter()),
        queryClient.invalidateQueries(trpc.worktrees.pathFilter()),
        queryClient.invalidateQueries(trpc.changes.pathFilter()),
      ]),
  });
  const choice = choices.find((each) => each.id === picked) ?? choices[0];
  if (choice === undefined) return null;
  const close = () => {
    if (goBack.isPending) return;
    goBack.reset();
    onOpenChange(false);
  };
  return (
    <Overlay
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      size="sm"
      title={
        choices.length === 1
          ? `Go back to checkpoint ${choice.ordinal}?`
          : "Go back to a checkpoint?"
      }
      description={`The files in this worktree go back to how they were at checkpoint ${choice.ordinal}, ${timeOf(choice.createdAt)}. Mend saves the files as they are now as a new checkpoint first, so you can undo this.`}
      footer={
        <>
          <Button variant="secondary" size={size} disabled={goBack.isPending} onClick={close}>
            Cancel
          </Button>
          <Button
            size={size}
            disabled={goBack.isPending}
            onClick={() =>
              goBack.mutate(choice.id, {
                onSuccess: (restore) => {
                  toast.add({ description: wentBackWords(restore) });
                  goBack.reset();
                  onOpenChange(false);
                },
              })
            }
          >
            {goBack.isPending ? "Going back…" : "Go back"}
          </Button>
        </>
      }
    >
      {choices.length > 1 ? (
        <Label className="grid gap-1.5 text-meta font-normal text-muted-foreground">
          Checkpoint
          <NativeSelect
            size="field"
            className="w-full"
            value={choice.id}
            disabled={goBack.isPending}
            onChange={(event) => setPicked(event.target.value)}
          >
            {choices.map((each) => (
              <NativeSelectOption key={each.id} value={each.id}>
                {each.ordinal} · {each.words} · {timeOf(each.createdAt)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Label>
      ) : null}
      <ul className="flex list-disc flex-col gap-1.5 pl-5 text-muted-foreground">
        <li>
          Every session in this worktree uses these files. Each agent is told on its next message.
        </li>
        <li>
          The branch and its commits stay as they are. Ignored files, like node_modules, aren't
          touched.
        </li>
      </ul>
      {goBack.isError ? (
        <InlineAlert size={size}>
          {failureWords(goBack.error, "The files didn't go back. Nothing changed. Try again.")}
        </InlineAlert>
      ) : null}
    </Overlay>
  );
}
