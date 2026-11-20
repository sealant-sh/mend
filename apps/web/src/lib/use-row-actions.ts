import { toast } from "@mend/ui/components/ui/toast";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { copyTextChecked } from "./clipboard.ts";
import type { InboxRow } from "./inbox.ts";
import {
  doneWords,
  labelOf,
  labelsWriter,
  type MarkChange,
  markBefore,
  marksWriter,
  refusedWords,
  sessionUrl,
} from "./row-actions.ts";
import { stopTargetOfRow } from "./session-stop.ts";
import { useOpenStop } from "./stop-session.ts";
import { useTRPC, useTRPCClient } from "./trpc.ts";

/** How long a toast with Undo stays: long enough to reach its button. */
const UNDO_MS = 8_000;

/**
 * A toast that says what happened, with Undo when it can be taken back. Read out politely: a
 * high-priority toast is hidden from screen readers until focused, which would hide its Undo.
 */
const say = (description: string, undo?: () => void) =>
  toast.add({
    description,
    priority: "low",
    ...(undo === undefined
      ? {}
      : { timeout: UNDO_MS, actionProps: { children: "Undo", onClick: undo } }),
  });

/** A toast that says the server refused a change, which is back as it was on screen: read out at once. */
const refused = (verb: string, title: string) => (error: unknown) => {
  toast.add({ description: refusedWords(verb, title, error), priority: "high" });
};

/**
 * A row's actions, wired to the server. Each change shows at once (`marksWriter`,
 * `labelsWriter`), and a toast says what happened, with Undo. A refused change goes back on screen
 * and a toast says why. The toasts come from the write's own promise, so they still show once the
 * row has moved to another group.
 */
export const useRowActions = () => {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  const openStop = useOpenStop();
  const marksKey = trpc.sessions.inboxMarks.queryKey();
  const marks = useMutation(
    marksWriter.options({
      queryClient,
      documentKey: marksKey,
      mutationKey: trpc.sessions.setInboxMark.mutationKey(),
      send: ({ id, mark }) => client.sessions.setInboxMark.mutate({ id, mark }),
    }),
  );
  const labels = useMutation(
    labelsWriter.options({
      queryClient,
      documentKey: trpc.sessions.inbox.queryKey(),
      mutationKey: trpc.sessions.setLabel.mutationKey(),
      send: ({ id, label }) => client.sessions.setLabel.mutate({ id, label }),
    }),
  );

  /** Writes one mark; false when the server refused it, which a toast has said. */
  const writeMark = async (row: InboxRow, change: MarkChange, verb: string) => {
    try {
      await marks.mutateAsync({ id: row.session.id, mark: change, at: new Date() });
      return true;
    } catch (error) {
      refused(verb, row.title)(error);
      return false;
    }
  };

  /** Writes a mark; on success says `done` and offers to put back the mark it replaced. */
  const mark = async (row: InboxRow, change: MarkChange, verb: string, done: string) => {
    const before = markBefore(queryClient.getQueryData(marksKey) ?? [], row.session.id, new Date());
    if (await writeMark(row, change, verb))
      say(done, () => void writeMark(row, before, "put back"));
  };

  /** Writes a label; false when the server refused it, which a toast has said. */
  const writeLabel = async (row: InboxRow, label: string | null) => {
    try {
      await labels.mutateAsync({ id: row.session.id, label });
      return true;
    } catch (error) {
      refused("rename", row.title)(error);
      return false;
    }
  };

  const rename = async (row: InboxRow, text: string) => {
    const label = labelOf(text);
    const before = row.session.label;
    if (label === before) return;
    if (await writeLabel(row, label))
      say(doneWords.renamed(label ?? row.worktreeName ?? row.title), () => {
        void writeLabel(row, before);
      });
  };

  // Each action runs on its own: what it did, or why it didn't, shows in a toast.
  return {
    snooze: (row: InboxRow, until: Date) => {
      void mark(
        row,
        { _tag: "Snoozed", until },
        "snooze",
        doneWords.snoozed(row.title, until, new Date()),
      );
    },
    unsnooze: (row: InboxRow) => {
      void mark(row, { _tag: "Inbox" }, "move", doneWords.unsnoozed(row.title));
    },
    markDone: (row: InboxRow) => {
      void mark(row, { _tag: "Settled" }, "mark done", doneWords.markedDone(row.title));
    },
    markNotDone: (row: InboxRow) => {
      void mark(row, { _tag: "Inbox" }, "move", doneWords.markedNotDone(row.title));
    },
    /**
     * Opens Stop session? for the row's session, the same dialog as its tab's; null outside the
     * inbox layout, where rows offer no Stop.
     */
    stop:
      openStop === null
        ? null
        : (row: InboxRow) => {
            openStop(stopTargetOfRow(row));
          },
    /** Renames the session; an empty name clears its label, and its worktree's name shows. */
    rename: (row: InboxRow, text: string) => {
      void rename(row, text);
    },
    /** Copies the session's address; a tab whose row the inbox doesn't hold copies it too. */
    copyLink: (row: { readonly session: { readonly id: string }; readonly title: string }) => {
      void copyTextChecked(sessionUrl(window.location.origin, row.session.id)).then((copied) =>
        copied
          ? say(doneWords.copied(row.title))
          : toast.add({
              description: `Couldn't copy the link to "${row.title}". This browser doesn't allow it here.`,
              priority: "high",
            }),
      );
    },
  };
};

export type RowActionHandlers = ReturnType<typeof useRowActions>;
