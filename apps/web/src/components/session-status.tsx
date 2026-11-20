import { Lump, type LumpPr, type LumpStatus } from "@mend/ui/components/lump";
import { Status, type StatusTone } from "@mend/ui/components/status";
import { cn } from "@mend/ui/lib/utils";

/**
 * A session's status in a list that isn't the sidebar (the project page's Sessions and Worktrees
 * tabs): the session glyph, then its word, both from `lib/inbox.ts` so they say what the sidebar
 * row says. The glyph is decorative: the word carries the state.
 */
export function SessionStatus({
  status,
  className,
}: {
  readonly status: {
    readonly word: string;
    readonly tone: StatusTone;
    readonly lump: LumpStatus;
    readonly pr: LumpPr;
  };
  readonly className?: string;
}) {
  return (
    <Status tone={status.tone} className={cn("items-center", className)}>
      <Lump status={status.lump} pr={status.pr} className="size-3.5" />
      {status.word}
    </Status>
  );
}
