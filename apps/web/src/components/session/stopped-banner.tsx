import { canRelaunchIn, terminalOwnerOnlyLine } from "@mend/domain/workbench";
import { Banner } from "@mend/ui/components/banner";
import { ConversationItem } from "@mend/ui/components/conversation";
import { Button } from "@mend/ui/components/ui/button";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { failureWords } from "#/lib/refusal";
import { SESSION_STALE_MS } from "#/lib/session-queries";
import { actorOf, resumeOf, stoppedLine, stoppedWords } from "#/lib/session-stop";
import { useTRPC, useTRPCClient } from "#/lib/trpc";

import { Said } from "./session-actions.tsx";
import type { SessionFacts } from "./session-facts.ts";

/**
 * What the workspace does now, read for a stopped session: still running for another session, or
 * stopped. Until it answers, or if it can't, the banner and the line say only what they know.
 */
const useWorkspaceNow = (facts: SessionFacts) => {
  const trpc = useTRPC();
  const read = useQuery({
    ...trpc.sessions.stopPreview.queryOptions({ id: facts.session.id }),
    staleTime: SESSION_STALE_MS,
    enabled: facts.session.status === "stopped",
  });
  return read.isPending || read.isError ? null : read.data;
};

/**
 * A stopped session's band over its conversation (Doop "Session · stopped", "stopped, other session
 * still running", "Phone · Session · stopped, workspace stopped too"): that it is stopped, what is
 * kept and where the workspace stands, and Resume session (Resume as a shell for a `mend run`
 * command, which has nothing of its own to resume). A resume that opens a terminal is the owner's
 * alone (docs/adr/0013); anyone else who steers reads why.
 */
export function StoppedBanner({ facts }: { readonly facts: SessionFacts }) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  const { session, detail } = facts;
  const preview = useWorkspaceNow(facts);
  const [failure, setFailure] = useState<string | null>(null);
  const how = resumeOf(session.harness);
  const resume = useMutation({
    mutationFn: () =>
      client.sessions.resume.mutate({ id: session.id, request: { harness: how.harness } }),
    onMutate: () => setFailure(null),
    onError: (cause) =>
      setFailure(`The session didn't resume. ${failureWords(cause, "Try again.")}`),
    onSettled: () => queryClient.invalidateQueries(trpc.sessions.pathFilter()),
  });
  if (session.status !== "stopped") return null;
  const resumes = canRelaunchIn(detail.control, session.mode, how.harness !== null);
  const ownerOnly =
    !resumes && detail.control.steer && !detail.control.own
      ? terminalOwnerOnlyLine(
          (session.ownerUserId === null ? null : facts.nameOf(session.ownerUserId)) ?? "its owner",
          "resume",
        )
      : null;
  const words = stoppedWords(preview, actorOf(session.harness), facts.worktreeName, facts.viewerId);
  const button = (size: "sm" | "touch", className?: string) =>
    resumes ? (
      <Button
        type="button"
        variant="outline"
        size={size}
        className={className}
        disabled={resume.isPending}
        onClick={() => resume.mutate()}
      >
        {resume.isPending ? "Resuming…" : how.label}
      </Button>
    ) : undefined;
  const body = (
    <>
      <Said sentence={words} />
      {ownerOnly === null ? null : <> {ownerOnly}</>}
      {failure === null ? null : (
        <span role="alert" className="mt-1 block text-destructive">
          {failure}
        </span>
      )}
    </>
  );
  return (
    <>
      <Banner title="This session is stopped." className="max-lg:hidden" actions={button("sm")}>
        {body}
      </Banner>
      <Banner
        title="This session is stopped."
        layout="stacked"
        className="lg:hidden"
        actions={button("touch", "w-full")}
      >
        {body}
      </Banner>
    </>
  );
}

/**
 * The line at the end of a stopped session's conversation: who stopped it and when, and what its
 * workspace does now ("Ada Lovelace stopped the session at 11:20. The workspace keeps running for
 * Write tests for retry."). Nothing while it is read, or when no stop is recorded.
 */
export function StoppedLine({ facts }: { readonly facts: SessionFacts }) {
  const trpc = useTRPC();
  const stopped = facts.session.status === "stopped";
  const events = useQuery({
    ...trpc.sessions.controlEvents.queryOptions({ id: facts.session.id }),
    staleTime: SESSION_STALE_MS,
    enabled: stopped,
  });
  const preview = useWorkspaceNow(facts);
  if (!stopped || events.isPending || events.isError) return null;
  const line = stoppedLine(events.data, facts.viewerId, facts.nameOf, preview);
  if (line === null) return null;
  return (
    <ConversationItem messageId="stopped">
      <p className="text-row text-muted-foreground">{line}</p>
    </ConversationItem>
  );
}
