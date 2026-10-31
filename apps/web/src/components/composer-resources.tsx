import type { WorktreeId } from "@mend/domain";
import { choicesFor, type WorktreeChoice } from "@mend/domain/workbench";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { choiceToggle } from "#/components/resources-section";
import {
  choiceInUse,
  choiceWords,
  chooseResource,
  readerZone,
  type ResourceSettingView,
} from "#/lib/resources";
import { settleChoice } from "#/lib/resources-card";
import { useTRPC } from "#/lib/trpc";

/** `@db own`: what the worktree uses of one project resource, in the card's words. */
const usedWords = (entry: ResourceSettingView): string | null => {
  const inUse = choiceInUse(entry);
  return inUse === null
    ? null
    : `@${entry.spec.name} ${choiceWords(entry.spec, inUse.choice).label}`;
};

/** The project resources a worktree chooses how to use: project scope, with a choice. */
const chosenHere = (settings: ReadonlyArray<ResourceSettingView>) =>
  settings.filter((entry) => choicesFor(entry.spec).length > 0);

/**
 * What the chosen worktree uses of each project resource, on one line, before a session starts in
 * it (ADR 0019, story 3): `Resources · @db own · @cache shared`. Its change owner gets **change**,
 * which opens the choices; a choice is the Resources card's own selection, and a switch restarts
 * the worktree's Services.
 */
export function ComposerResources(props: {
  readonly projectId: string;
  readonly worktreeId: WorktreeId;
  /** A menu has no room to choose in: it shows the line alone. */
  readonly readOnly?: boolean;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const listOptions = trpc.resources.list.queryOptions({
    projectId: props.projectId,
    timeZone: readerZone(),
    worktreeId: props.worktreeId,
  });
  const query = useQuery(listOptions);
  const entries = chosenHere(query.data?.settings ?? []);
  if (entries.length === 0) return null;
  const words = entries.flatMap((entry) => {
    const used = usedWords(entry);
    return used === null ? [] : [used];
  });
  const mayChange = props.readOnly !== true && entries.some((entry) => entry.canChoose);

  const choose = (entry: ResourceSettingView, mode: WorktreeChoice) => {
    if (busy) return;
    setBusy(true);
    setRefusal(null);
    const settle = async () => {
      const outcome = await chooseResource(props.projectId, props.worktreeId, entry.id, mode);
      if (outcome.ok) await settleChoice(queryClient, listOptions.queryKey, outcome.result);
      else setRefusal(outcome.message);
    };
    void settle()
      .catch((error: unknown) => setRefusal(error instanceof Error ? error.message : String(error)))
      .finally(() => setBusy(false));
  };

  return (
    <div
      className={`${props.readOnly === true ? "px-2 pb-2" : "px-5 pt-2"} text-[12.5px] leading-relaxed text-ink-2`}
    >
      <p>
        <span className="text-label">Resources</span>{" "}
        <span className="font-mono text-[11.5px] text-foreground">{words.join(" · ")}</span>
        {mayChange ? (
          <>
            {" "}
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpen((current) => !current)}
              className="text-info hover:underline"
            >
              change
            </button>
          </>
        ) : null}
      </p>
      {open && mayChange
        ? entries.map((entry) => (
            <div
              key={entry.id}
              role="group"
              aria-label={`How this worktree uses @${entry.spec.name}`}
              className="mt-1 flex flex-wrap items-center gap-1"
            >
              <span className="font-mono text-[11.5px] text-foreground">@{entry.spec.name}</span>
              {choicesFor(entry.spec).map((choice) => {
                const inUse = choiceInUse(entry)?.choice === choice;
                return (
                  <button
                    key={choice}
                    type="button"
                    disabled={busy || !entry.canChoose}
                    aria-pressed={inUse}
                    title={choiceWords(entry.spec, choice).meaning}
                    onClick={() => (inUse ? undefined : choose(entry, choice))}
                    className={choiceToggle(inUse)}
                  >
                    {choiceWords(entry.spec, choice).label}
                  </button>
                );
              })}
            </div>
          ))
        : null}
      {refusal === null ? null : (
        <p role="alert" className="mt-1 font-mono text-[11px] text-danger">
          {refusal}
        </p>
      )}
    </div>
  );
}
