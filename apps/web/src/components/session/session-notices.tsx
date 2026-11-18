import { captureDiscardOffered, REPLACE_WORKSPACE_ACTION } from "@mend/domain/workbench";
import { Banner } from "@mend/ui/components/banner";
import { Button } from "@mend/ui/components/ui/button";
import { toast } from "@mend/ui/components/ui/toast";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";

import { sessionCaptureLine, sessionServicesHold } from "#/lib/api";
import { usePhone } from "#/lib/phone";
import { failureWords } from "#/lib/refusal";
import { savingTitle } from "#/lib/session-stop";
import { replaceRefusalWords, retirementView } from "#/lib/shared-workspace";
import { useTRPC, useTRPCClient } from "#/lib/trpc";

import { Overlay } from "../projects/overlay.tsx";
import type { SessionFacts } from "./session-facts.ts";

/**
 * What a session says about its workspace once its agent has stopped, as bands over its
 * conversation, each only when there is something to say (no frame draws them; they follow
 * "Session · stopped"):
 *
 * - what a stop is still saving, and what it couldn't save, with Discard… for the owner when the
 *   save is stuck (docs/adr/0002, `capture-stop-line`, `capture-not-saved`, `capture-discard`);
 * - the Services that keep the workspace up after the agent stopped while another session runs
 *   there, with Stop services (`service-hold`). A stop of the last running session takes the
 *   Services with it (docs/adr/0026), so this shows only when another session kept them;
 * - a workspace waiting to be replaced: what was checked, what would stop, and Replace this
 *   workspace now for the change's owner (ADR 0016, decision 14, `retire-*`, `replace-*`).
 *
 * The lines are the domain's words, the same on every surface.
 */
export function SessionNotices({ facts }: { readonly facts: SessionFacts }) {
  return (
    <>
      <SavingBand facts={facts} />
      <ServicesHoldBand facts={facts} />
      <RetirementBand facts={facts} />
    </>
  );
}

/** A band's one action: its words, and its words while it runs. */
interface BandAction {
  readonly label: string;
  readonly pending?: boolean;
  readonly pendingLabel?: string;
  readonly onClick: () => void;
}

/** A band over the conversation: inline on a desktop, stacked under 1024px. */
function Band({
  tone,
  title,
  action,
  children,
}: {
  readonly tone: "info" | "warning";
  readonly title?: string;
  readonly action?: BandAction;
  readonly children: ReactNode;
}) {
  const button = (size: "sm" | "touch", className?: string) =>
    action === undefined ? undefined : (
      <Button
        type="button"
        variant="outline"
        size={size}
        className={className}
        disabled={action.pending === true}
        onClick={action.onClick}
      >
        {action.pending === true ? (action.pendingLabel ?? action.label) : action.label}
      </Button>
    );
  const titled = title === undefined ? {} : { title };
  return (
    <>
      <Banner tone={tone} {...titled} className="max-lg:hidden" actions={button("sm")}>
        {children}
      </Banner>
      <Banner
        tone={tone}
        {...titled}
        layout="stacked"
        className="lg:hidden"
        actions={button("touch", "w-full")}
      >
        {children}
      </Banner>
    </>
  );
}

/** What a failed action said, under the band's words. */
function Failure({ words }: { readonly words: string | null }) {
  return words === null ? null : (
    <span role="alert" className="mt-1 block text-destructive">
      {words}
    </span>
  );
}

/** What a stop is still saving, or couldn't save, and the owner's Discard… once it is stuck. */
function SavingBand({ facts }: { readonly facts: SessionFacts }) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  const phone = usePhone();
  const { session, detail } = facts;
  const [asking, setAsking] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const discard = useMutation({
    mutationFn: () => client.sessions.discardUnsaved.mutate({ id: session.id }),
    onMutate: () => setFailure(null),
    onSuccess: () => setAsking(false),
    onError: (cause) => setFailure(`Mend didn't discard it. ${failureWords(cause, "Try again.")}`),
    onSettled: () => queryClient.invalidateQueries(trpc.sessions.pathFilter()),
  });
  const line = sessionCaptureLine(session);
  if (line === null) return null;
  const { title, settled } = savingTitle(line);
  const offered = detail.control.own && captureDiscardOffered(session);
  return (
    <>
      <Band
        tone={settled ? "info" : "warning"}
        title={title}
        {...(offered ? { action: { label: "Discard…", onClick: () => setAsking(true) } } : {})}
      >
        <span className="font-mono text-meta wrap-anywhere">{line}</span>
      </Band>
      <Overlay
        open={asking}
        onOpenChange={(open) => {
          if (!discard.isPending) setAsking(open);
        }}
        title="Discard what isn't saved?"
        description="The workspace stops now, with work still waiting to be saved. What it hasn't saved is gone once it stops."
        size="sm"
        footer={
          <>
            <Button
              type="button"
              variant="outline"
              size={phone ? "touch" : "default"}
              disabled={discard.isPending}
              onClick={() => setAsking(false)}
            >
              Keep saving
            </Button>
            <Button
              type="button"
              variant="destructive"
              size={phone ? "touch" : "default"}
              disabled={discard.isPending}
              onClick={() => discard.mutate()}
            >
              {discard.isPending ? "Discarding…" : "Discard and stop"}
            </Button>
          </>
        }
      >
        <p className="font-mono text-meta wrap-anywhere text-muted-foreground">{line}</p>
        <Failure words={failure} />
      </Overlay>
    </>
  );
}

/** The Services keeping the workspace up after the agent stopped, and Stop services. */
function ServicesHoldBand({ facts }: { readonly facts: SessionFacts }) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  const { session, detail } = facts;
  const [failure, setFailure] = useState<string | null>(null);
  const stop = useMutation({
    mutationFn: () => client.sessions.stopServices.mutate({ id: session.id }),
    onMutate: () => setFailure(null),
    onSuccess: ({ stopped }) =>
      toast.add({
        description:
          stopped === 0
            ? "No services were running."
            : `Stopped ${stopped} ${stopped === 1 ? "service" : "services"}.`,
        priority: "low",
      }),
    onError: (cause) =>
      setFailure(`The services didn't stop. ${failureWords(cause, "Try again.")}`),
    onSettled: () => queryClient.invalidateQueries(trpc.sessions.pathFilter()),
  });
  const line = sessionServicesHold(session, detail.currentAgent, detail.liveServices);
  if (line === null) return null;
  return (
    <Band
      tone="info"
      title="Services are still running."
      {...(detail.control.stop
        ? {
            action: {
              label: "Stop services",
              pending: stop.isPending,
              pendingLabel: "Stopping services…",
              onClick: () => stop.mutate(),
            },
          }
        : {})}
    >
      <span className="font-mono text-meta">{line}</span>
      <Failure words={failure} />
    </Band>
  );
}

/**
 * A workspace waiting to be replaced: whose it is, what was checked and what would stop, and
 * Replace this workspace now for the change's owner. A refusal is said in the server's words,
 * and the list is read again, since a refusal can mean it moved.
 */
function RetirementBand({ facts }: { readonly facts: SessionFacts }) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  const { session } = facts;
  const under = session.workspaceRetirement !== null;
  const read = useQuery({
    ...trpc.sessions.workspaceRetirement.queryOptions({ id: session.id }),
    enabled: under,
    retry: false,
  });
  const [refusal, setRefusal] = useState<string | null>(null);
  const replace = useMutation({
    mutationFn: (seen: string) => client.sessions.replaceWorkspace.mutate({ id: session.id, seen }),
    onMutate: () => setRefusal(null),
    onError: (cause) => {
      setRefusal(replaceRefusalWords(cause));
      void queryClient.invalidateQueries(
        trpc.sessions.workspaceRetirement.queryFilter({ id: session.id }),
      );
    },
    onSettled: () => queryClient.invalidateQueries(trpc.sessions.pathFilter()),
  });
  // Nothing to say until it is read, or if it can't be: the session's own status still shows.
  if (!under || read.isPending || read.isError || read.data === null) return null;
  const retirement = read.data;
  const view = retirementView(retirement, facts.nameOf, session.livePeople);
  return (
    <Band
      tone="info"
      {...(view.canReplace
        ? {
            action: {
              label: REPLACE_WORKSPACE_ACTION,
              pending: replace.isPending,
              pendingLabel: "Replacing…",
              onClick: () => replace.mutate(retirement.fingerprint),
            },
          }
        : {})}
    >
      <span className="block">{view.line}</span>
      {view.stops.length === 0 ? null : (
        <ul aria-label="What would stop" className="mt-1.5 flex flex-col gap-0.5">
          {view.stops.map((stop) => (
            <li key={stop} className="font-mono text-meta wrap-anywhere">
              {stop}
            </li>
          ))}
        </ul>
      )}
      <Failure words={refusal} />
    </Band>
  );
}
