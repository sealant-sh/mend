import { agentStartingFacts, terminalReadOnlyLine } from "@mend/domain/workbench";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Button, IconButton } from "#/components/kit/button";
import { Segment } from "#/components/kit/segment";
import { SessionTerminal } from "#/components/terminal";
import { failureWords } from "#/lib/refusal";
import { useResolvedDark } from "#/lib/theme";
import { useTRPC } from "#/lib/trpc";

import type { SessionFacts } from "./facts";

const AGENT = "agent";

/**
 * The Terminal tab (screens P5, C5, X4): the agent's own terminal when it runs in one, and the
 * shells open in its workspace; + opens another. Only the owner types, even while control is
 * shared (docs/adr/0013); everyone else reads.
 */
export function TerminalTab({ facts }: { readonly facts: SessionFacts }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const dark = useResolvedDark();
  const { session, control, detail } = facts;
  const processes = useQuery(trpc.sessions.processes.queryOptions({ id: session.id }));
  const shells = (processes.data ?? detail.processes).filter(
    (process) => process.kind === "shell" && process.exitedAt === null,
  );
  // Reading a terminal is for those who steer the session (docs/adr/0003); typing is the owner's.
  const agentTerminal =
    facts.agentLive && !facts.conversationLive && facts.agentPty !== null && control.steer;
  const options = [
    ...(agentTerminal ? [{ value: AGENT, label: facts.agent }] : []),
    ...(control.steer ? shells : []).map((shell, index) => ({
      value: shell.id,
      label: shell.label ?? (index === 0 ? "shell" : `shell ${index + 1}`),
    })),
  ];
  const [picked, setPicked] = useState<string | null>(null);
  const current = options.find((option) => option.value === picked)?.value ?? options[0]?.value;
  const open = useMutation({
    ...trpc.sessions.openShell.mutationOptions(),
    onSuccess: (shell) => setPicked(shell.id),
    onSettled: () => queryClient.invalidateQueries(trpc.sessions.pathFilter()),
  });
  const stop = useMutation({
    ...trpc.sessions.stopShell.mutationOptions(),
    onSettled: () => queryClient.invalidateQueries(trpc.sessions.pathFilter()),
  });
  const canOpen = control.terminalInput && facts.agentLive;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 pb-1">
      <div className="flex flex-wrap items-center gap-2">
        {options.length > 0 ? (
          <Segment
            label="Terminals"
            value={current ?? AGENT}
            onChange={setPicked}
            options={options}
          />
        ) : null}
        {canOpen ? (
          <IconButton
            icon="plus"
            label="Open a shell"
            size="sm"
            bordered
            disabled={open.isPending}
            onClick={() => open.mutate({ id: session.id })}
          />
        ) : null}
        {open.isPending ? (
          <span role="status" className="font-mono text-[11.5px] text-muted-foreground">
            Opening a shell…
          </span>
        ) : null}
        <span className="flex-1" />
        {current !== undefined && current !== AGENT && control.terminalInput ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={stop.isPending}
            onClick={() => stop.mutate({ processId: current })}
          >
            {stop.isPending ? "Closing…" : "Close this shell"}
          </Button>
        ) : null}
        <span className="font-mono text-[11.5px] text-faint">
          in the workspace · {session.worktree}
        </span>
      </div>
      {open.isError || stop.isError ? (
        <p role="alert" className="text-[12.5px] text-danger">
          {failureWords(open.error ?? stop.error, "Mend could not do that.")}
        </p>
      ) : null}
      {!control.terminalInput && current !== undefined ? (
        <p className="text-[12.5px] text-ink-2">
          {terminalReadOnlyLine(facts.ownerName ?? "its owner")}
        </p>
      ) : null}
      {current === undefined ? (
        <p className="font-mono text-[12px] text-muted-foreground">
          {!control.steer
            ? `Only ${facts.ownerName ?? "its owner"} and those they share control with read this session's terminals. The Record tab shows what ran.`
            : facts.agentLive && facts.agentPty === null && !facts.conversationLive
              ? "Provisioning the workspace; a first launch builds the harness image, which can take minutes. The terminal attaches here once it is live."
              : facts.agentLive
                ? canOpen
                  ? `${facts.agent} works in a conversation, not a terminal. + opens a shell in its workspace.`
                  : `${facts.agent} works in a conversation, not a terminal. Only ${facts.ownerName ?? "its owner"} opens shells here.`
                : "The workspace is not running. Resume the session to open a terminal."}
        </p>
      ) : (
        <div className="flex min-h-[380px] flex-1 flex-col overflow-hidden rounded-[14px] bg-[#1e1f22] px-4 py-3.5 shadow-sm">
          {/* Keyed on the platform session too: `mend continue` reopens the session with a fresh
              PTY, and on the theme, since the terminal reads its colours when it attaches. */}
          <SessionTerminal
            key={`${current}:${facts.agentPty ?? ""}:${dark ? "dark" : "light"}`}
            sessionId={session.id}
            {...(current === AGENT ? {} : { processId: current })}
            startingLabel={session.harness}
            starting={agentStartingFacts(detail.currentAgent, detail.processes, Date.now())}
            readOnly={!control.terminalInput}
            palette="dark"
          />
        </div>
      )}
    </div>
  );
}
