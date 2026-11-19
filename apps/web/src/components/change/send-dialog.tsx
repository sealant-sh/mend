import { Button } from "@mend/ui/components/ui/button";
import { Checkbox } from "@mend/ui/components/ui/checkbox";
import { Label } from "@mend/ui/components/ui/label";
import { Textarea } from "@mend/ui/components/ui/textarea";
import { useId, useState } from "react";

import { Overlay } from "#/components/projects/overlay";
import type { ReviewCommentDto } from "#/lib/api";
import { usePhone } from "#/lib/phone";
import { assembleInstruction, countWords, placeWords, plainLine } from "#/lib/review-comments";

/** What the dialog hands back to send: the comments picked and the words as edited. */
export interface ChosenSend {
  readonly comments: ReadonlyArray<ReviewCommentDto>;
  readonly instruction: string;
}

/**
 * Choose and edit before sending: every open comment that wasn't sent, checked, and the one
 * message the agent receives, assembled from the checked ones. Unchecking one assembles it again;
 * the words can be edited, and what is sent is what the agent reads. The dialog closes once the
 * send is under way; the band under the toolbar says how it went.
 */
export function SendDialog({
  open,
  onOpenChange,
  comments,
  branch,
  agent,
  onSend,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly comments: ReadonlyArray<ReviewCommentDto>;
  readonly branch: string;
  readonly agent: string;
  readonly onSend: (chosen: ChosenSend) => void;
}) {
  return (
    <Overlay
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={`Send to ${agent}`}
      description={`${agent} gets the comments you pick as one message, and keeps working on ${branch}.`}
      footer={null}
    >
      {/* A new body each time it opens: every comment checked, the message as assembled. */}
      {open ? (
        <SendBody
          comments={comments}
          branch={branch}
          agent={agent}
          onCancel={() => onOpenChange(false)}
          onSend={(chosen) => {
            onOpenChange(false);
            onSend(chosen);
          }}
        />
      ) : null}
    </Overlay>
  );
}

function SendBody({
  comments,
  branch,
  agent,
  onCancel,
  onSend,
}: {
  readonly comments: ReadonlyArray<ReviewCommentDto>;
  readonly branch: string;
  readonly agent: string;
  readonly onCancel: () => void;
  readonly onSend: (chosen: ChosenSend) => void;
}) {
  const phone = usePhone();
  const messageId = useId();
  const [picked, setPicked] = useState<ReadonlySet<string>>(
    () => new Set(comments.map((comment) => comment.id)),
  );
  const [instruction, setInstruction] = useState(() => assembleInstruction(branch, comments));
  const chosen = comments.filter((comment) => picked.has(comment.id));
  const pick = (id: string, on: boolean) => {
    const next = new Set(picked);
    if (on) next.add(id);
    else next.delete(id);
    setPicked(next);
    setInstruction(
      assembleInstruction(
        branch,
        comments.filter((comment) => next.has(comment.id)),
      ),
    );
  };
  const size = phone ? "touch" : "default";
  return (
    <div className="grid gap-5">
      <fieldset className="grid gap-1">
        <legend className="mb-1.5 text-control font-medium">
          Comments to send · {chosen.length} of {comments.length}
        </legend>
        {comments.map((comment) => (
          <Label
            key={comment.id}
            className="flex cursor-pointer items-start gap-3 rounded-md py-1.5 text-row font-normal max-lg:min-h-11"
          >
            <Checkbox
              className="mt-0.5"
              checked={picked.has(comment.id)}
              onCheckedChange={(on) => pick(comment.id, on)}
            />
            <span className="grid min-w-0">
              <span className="font-mono text-2xs text-muted-foreground">
                {placeWords(comment)}
              </span>
              <span className="line-clamp-2">{plainLine(comment.body)}</span>
            </span>
          </Label>
        ))}
      </fieldset>
      <div className="grid gap-1.5">
        <Label htmlFor={messageId} className="text-control font-medium">
          What {agent} receives
        </Label>
        <Textarea
          id={messageId}
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
          rows={phone ? 8 : 12}
          className="text-row leading-relaxed"
        />
        <p className="text-meta text-muted-foreground">
          Mend sends these words as they are. Unchecking a comment writes the message again.
        </p>
      </div>
      <div className="flex justify-end gap-2 max-lg:flex-col-reverse max-lg:*:w-full">
        <Button variant="ghost" size={size} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size={size}
          disabled={chosen.length === 0 || instruction.trim() === ""}
          onClick={() => onSend({ comments: chosen, instruction })}
        >
          Send {countWords(chosen.length, "comment", "comments")}
        </Button>
      </div>
    </div>
  );
}
