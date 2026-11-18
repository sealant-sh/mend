import { sharedControlConfirm, sharedControlLine } from "@mend/domain/workbench";
import { Button } from "@mend/ui/components/ui/button";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";

import { Overlay } from "#/components/projects/overlay";
import { usePhone } from "#/lib/phone";
import { failureWords } from "#/lib/refusal";
import { controlRow, sharedControlWords } from "#/lib/session-details";
import { useTRPC } from "#/lib/trpc";

import type { SessionFacts } from "../session/session-facts.ts";

/**
 * Shared control of the page's own session, in its line under "Sessions in this workspace"
 * (docs/adr/0003; `share-on-web`, `share-off-web`, `org-owner-off`, `viewer-lines`, `who-pays`).
 * Today's shared control is on or off for everyone who can see the project: the owner turns it on,
 * asked first in words true to whose login a steered turn spends, and off at once; an
 * organization owner may turn it off; everyone else reads who steers.
 *
 * Route PR 34 replaces this row with asking for shared control and granting it to one person.
 */
export function SharedControlRow({ facts }: { readonly facts: SessionFacts }) {
  const { session, detail } = facts;
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const touch = usePhone() ? "touch" : "sm";
  const [confirming, setConfirming] = useState(false);
  const turnOnRef = useRef<HTMLButtonElement>(null);
  const toggle = useMutation(
    trpc.sessions.setSharedControl.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries(trpc.sessions.pathFilter()),
    }),
  );
  const row = controlRow(session, detail.control, { id: facts.viewerId, nameOf: facts.nameOf });
  const failure = toggle.isError
    ? failureWords(toggle.error, "Shared control didn't change. Try again.")
    : null;
  const set = (enabled: boolean) => {
    toggle.reset();
    toggle.mutate({ id: session.id, enabled }, { onSuccess: () => setConfirming(false) });
  };
  const confirm = sharedControlConfirm(detail.control.turnsOnSendersLogin);

  if (row.kind === "line") return <p className="text-meta text-muted-foreground">{row.line}</p>;

  return (
    <>
      <p className="flex flex-wrap items-baseline gap-x-3 text-meta text-muted-foreground">
        <span>
          {row.kind === "owner"
            ? sharedControlWords(session, facts.viewerId, facts.nameOf)
            : row.line}
        </span>
        {row.kind === "owner" && !row.on ? (
          <Button
            ref={turnOnRef}
            type="button"
            variant="link"
            size="sm"
            className="font-medium"
            disabled={toggle.isPending}
            onClick={() => {
              toggle.reset();
              setConfirming(true);
            }}
          >
            {/* With someone granted it one by one, On is for everyone. */}
            {session.sharedControlUserIds.length > 0 ? "Turn on for everyone…" : "Turn on…"}
          </Button>
        ) : (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="font-medium"
            disabled={toggle.isPending}
            onClick={() => set(false)}
          >
            {toggle.isPending ? "Turning off…" : "Turn off"}
          </Button>
        )}
      </p>
      {/* Whose login a steered turn spends, beside the switch (`who-pays`). */}
      {row.kind === "owner" ? (
        <p className="text-meta text-muted-foreground">
          {sharedControlLine(detail.control.turnsOnSendersLogin)}
        </p>
      ) : null}
      {failure !== null && !confirming ? (
        <p role="alert" className="text-meta text-destructive">
          {failure}
        </p>
      ) : null}
      <Overlay
        open={confirming}
        onOpenChange={(open) => {
          if (!toggle.isPending) setConfirming(open);
        }}
        size="sm"
        finalFocus={turnOnRef}
        title={confirm.title}
        description={confirm.body}
        footer={
          <>
            <Button
              type="button"
              variant="secondary"
              size={touch}
              disabled={toggle.isPending}
              onClick={() => setConfirming(false)}
            >
              {confirm.cancel}
            </Button>
            <Button
              type="button"
              size={touch}
              disabled={toggle.isPending}
              onClick={() => set(true)}
            >
              {toggle.isPending ? "Turning on…" : confirm.confirm}
            </Button>
          </>
        }
      >
        {failure === null ? null : (
          <p role="alert" className="text-meta text-destructive">
            {failure}
          </p>
        )}
      </Overlay>
    </>
  );
}
