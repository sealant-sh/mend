import { ComposerCard, PromptInput, PromptInputModel } from "@mend/ui/components/prompt-input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@mend/ui/components/ui/dropdown-menu";
import { Skeleton } from "@mend/ui/components/ui/skeleton";
import { Suspense } from "react";

import { agentOf } from "#/lib/new-session";

import { Hint, sendBlocked } from "../new-session/new-session-page.tsx";
import { AgentMenuItems, agentPickWords } from "../new-session/pickers.tsx";
import { type ComposerPlace, useComposer } from "../new-session/use-composer.ts";

/** What the tab says about where the session works, by how many sessions already work there. */
const whereWords = (others: number): string =>
  others === 0
    ? "on its branch."
    : others === 1
      ? "on the same branch as the other session here. Each sees the other's changes."
      : `on the same branch as the ${others} other sessions here. It sees their changes and they see its changes.`;

function Composer({ place, tabId }: { readonly place: ComposerPlace; readonly tabId: string }) {
  const composer = useComposer(place);
  return (
    <div className="flex flex-col gap-2">
      <ComposerCard className="mx-0 w-full">
        <PromptInput
          id={`${tabId}-task`}
          autoFocus
          placeholder={`What should ${agentOf(composer.agent).label} do?`}
          label="Task"
          value={composer.prompt}
          onValueChange={composer.setPrompt}
          onSubmit={composer.start}
          blocked={sendBlocked(composer)}
          submitLabel={composer.starting ? "Starting…" : "Start session"}
          model={
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <PromptInputModel aria-label={`Agent and model: ${agentPickWords(composer)}`}>
                    <span className="truncate">{agentPickWords(composer)}</span>
                  </PromptInputModel>
                }
              />
              <DropdownMenuContent
                width="lg"
                className="max-h-[min(var(--available-height),32rem)]"
              >
                <AgentMenuItems composer={composer} />
              </DropdownMenuContent>
            </DropdownMenu>
          }
        />
      </ComposerCard>
      <div className="px-0.5">
        <Hint composer={composer} />
      </div>
    </div>
  );
}

/**
 * A New session tab (Doop T22): a session in this workspace, not started yet. Its first message
 * starts it in the workspace's worktree, on the branch the other sessions there share, and the tab
 * becomes that session's (`place.onStarted`).
 */
export function NewSessionTab({
  tabId,
  worktreeName,
  others,
  place,
}: {
  readonly tabId: string;
  readonly worktreeName: string;
  /** How many sessions already work in the workspace. */
  readonly others: number;
  readonly place: ComposerPlace;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col justify-end overflow-y-auto px-4 pt-6 pb-4.5 lg:px-7">
      <div className="mx-auto flex w-full max-w-conversation flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <h2 className="text-title font-semibold">New session</h2>
          <p className="text-row text-muted-foreground">
            It works in the <span className="font-mono text-meta">{worktreeName}</span> worktree,{" "}
            {whereWords(others)}
          </p>
        </div>
        {/* The agents, their logins and the person's last picks are read as the tab opens. */}
        <Suspense fallback={<Skeleton className="h-28 w-full rounded-xl" />}>
          <Composer place={place} tabId={tabId} />
        </Suspense>
      </div>
    </div>
  );
}
