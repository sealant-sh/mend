import { canRelaunchSession, terminalOwnerOnlyLine } from "@mend/domain/workbench";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "#/components/kit/button";
import { Menu, MenuItem } from "#/components/kit/menu";
import { resumeSession } from "#/lib/api";
import { failureWords } from "#/lib/refusal";
import { useTRPC } from "#/lib/trpc";

import type { SessionFacts } from "./facts";

/** The harnesses a settled session resumes with; another than its own receives the conversation. */
const RESUME_HARNESSES = ["claude", "codex", "opencode", "pi"] as const;

/**
 * Resume, on the session's own harness or another, in the middle of its stopped screen. A resume
 * that opens a terminal is the owner's alone, even while control is shared (docs/adr/0013);
 * everyone else who steers reads why. Elsewhere, sending a message resumes the session.
 */
export function ResumeButtons({ facts }: { readonly facts: SessionFacts }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { session, control, detail } = facts;
  const [error, setError] = useState<string | null>(null);
  const resume = useMutation({
    mutationFn: (harness: string) =>
      resumeSession(session.id, harness === session.harness ? null : harness),
    onMutate: () => setError(null),
    onError: (cause) =>
      setError(`The session did not resume. ${failureWords(cause, "Mend could not do that.")}`),
    onSettled: () => queryClient.invalidateQueries(trpc.sessions.pathFilter()),
  });
  if (facts.agentLive) return null;
  const harnesses = RESUME_HARNESSES.filter((harness) =>
    canRelaunchSession(control, detail.currentAgent?.kind ?? null, harness !== session.harness),
  );
  if (harnesses.length === 0)
    return control.steer && !control.own ? (
      <p className="max-w-[420px] text-[12.5px]">
        {terminalOwnerOnlyLine(facts.ownerName ?? "its owner", "resume")}
      </p>
    ) : null;
  const own = harnesses.find((harness) => harness === session.harness);
  const others = harnesses.filter((harness) => harness !== session.harness);
  return (
    <div className="flex flex-col items-center gap-2">
      <span className="flex items-center">
        {own === undefined ? null : (
          <Button
            variant="primary"
            disabled={resume.isPending}
            onClick={() => resume.mutate(own)}
            className={others.length > 0 ? "rounded-r-none" : undefined}
          >
            {resume.isPending ? "Resuming…" : "Resume"}
          </Button>
        )}
        {others.length === 0 ? null : (
          <Menu
            align="end"
            trigger={
              own === undefined ? (
                <Button variant="primary" disabled={resume.isPending}>
                  {resume.isPending ? "Resuming…" : "Resume with…"}
                </Button>
              ) : (
                <Button
                  variant="primary"
                  aria-label="Resume with another agent"
                  disabled={resume.isPending}
                  className="-ml-px rounded-l-none px-1.5"
                >
                  ▾
                </Button>
              )
            }
          >
            {others.map((harness) => (
              <MenuItem key={harness} onClick={() => resume.mutate(harness)}>
                Resume with {harness}
              </MenuItem>
            ))}
          </Menu>
        )}
      </span>
      {error === null ? null : (
        <p role="alert" className="max-w-[420px] text-[12.5px] text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
