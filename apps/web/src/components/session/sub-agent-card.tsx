import {
  agentFacts,
  durationWords,
  taskFacts,
  taskKindName,
  taskPhaseGroups,
  type AgentTaskView,
} from "@mend/agent-conversation";
import type { ReactNode } from "react";

import { focusRing } from "#/components/kit/button";
import { StatusWord, type Tone } from "#/components/kit/status";
import type { SubAgentView } from "#/lib/sub-agents";

import { RichText } from "./rich-text";

const toneOf = (status: string): Tone => {
  switch (status) {
    case "running":
      return "run";
    case "completed":
    case "done":
      return "ok";
    case "failed":
    case "error":
    case "errored":
      return "bad";
    default:
      return "off";
  }
};

function Card({
  kind,
  description,
  status,
  facts,
  children,
}: {
  readonly kind: string;
  readonly description: string;
  readonly status: string;
  readonly facts?: string;
  readonly children: ReactNode;
}) {
  return (
    <details className="min-w-0 rounded-2xl bg-panel shadow-sm ring-1 ring-rule">
      <summary
        className={`cursor-pointer rounded-2xl px-4 py-3 marker:text-muted-foreground ${focusRing}`}
      >
        <span className="ml-1 inline-flex max-w-[calc(100%-24px)] flex-col gap-1 align-top">
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="text-[12px] font-medium text-label">{kind}</span>
            <StatusWord tone={toneOf(status)}>{status}</StatusWord>
          </span>
          <span className="text-[13px] font-medium break-words text-foreground">{description}</span>
          {facts ? (
            <span className="font-mono text-[12px] break-words text-muted-foreground">{facts}</span>
          ) : null}
        </span>
      </summary>
      <div className="grid min-w-0 gap-3 border-t border-rule px-4 py-3">{children}</div>
    </details>
  );
}

/** A background task stays on its originating turn as the harness reports later progress. */
export function TaskCard({ task }: { readonly task: AgentTaskView }) {
  return (
    <Card
      kind={`Background task · ${taskKindName(task)}`}
      description={task.workflow ?? task.description}
      status={task.status}
      facts={taskFacts(task)}
    >
      {task.workflow !== null && task.description !== "" && task.description !== task.workflow ? (
        <p className="text-[13px] text-ink-2">{task.description}</p>
      ) : null}
      {taskPhaseGroups(task).map((group, index) => (
        <div key={index} className="grid gap-3">
          {group.title === null ? null : (
            <h4 className="text-[12px] font-medium text-label">{group.title}</h4>
          )}
          {group.agents.map((agent) => (
            <div key={agent.index} className="grid min-w-0 gap-1">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-[13px] font-medium text-foreground">{agent.label}</span>
                <StatusWord tone={toneOf(agent.state)}>{agent.state}</StatusWord>
              </div>
              <p className="font-mono text-[12px] break-words text-muted-foreground">
                {agentFacts(agent)}
              </p>
              {agent.lastTool === null || agent.state === "running" ? null : (
                <p className="font-mono text-[12px] text-muted-foreground">
                  Last tool · {agent.lastTool}
                </p>
              )}
              {agent.durationMs === null || agent.state === "done" ? null : (
                <p className="font-mono text-[12px] text-muted-foreground">
                  {durationWords(agent.durationMs)}
                </p>
              )}
              {agent.preview === null ? null : (
                <p className="line-clamp-3 text-[13px] break-words whitespace-pre-wrap text-ink-2">
                  {agent.preview}
                </p>
              )}
            </div>
          ))}
        </div>
      ))}
      {task.error === null ? null : (
        <p className="text-[13px] break-words text-danger">{task.error}</p>
      )}
      {task.summary === null ? null : <RichText text={task.summary} />}
    </Card>
  );
}

/** A synchronous delegation, its prompt, nested activity, and the result the harness returned. */
export function SubAgentCard({
  agent,
  stepCount,
  children,
}: {
  readonly agent: SubAgentView;
  readonly stepCount: number;
  readonly children: ReactNode;
}) {
  return (
    <Card
      kind={`Sub-agent · ${agent.type}`}
      description={agent.description}
      status={agent.status}
      facts={agent.model ?? ""}
    >
      {agent.prompt === null ? null : (
        <details className="min-w-0">
          <summary
            className={`cursor-pointer rounded-md text-[12px] text-muted-foreground ${focusRing}`}
          >
            Prompt
          </summary>
          <p className="mt-2 text-[13px] break-words whitespace-pre-wrap text-ink-2">
            {agent.prompt}
          </p>
        </details>
      )}
      {stepCount === 0 && !children ? null : (
        <details className="min-w-0">
          <summary
            className={`cursor-pointer rounded-md font-mono text-[12px] text-muted-foreground ${focusRing}`}
          >
            {stepCount} nested step{stepCount === 1 ? "" : "s"}
          </summary>
          <div className="mt-3 grid min-w-0 gap-3">{children}</div>
        </details>
      )}
      {agent.agents.map((child) => (
        <div key={child.id} className="grid min-w-0 gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <span className="font-mono text-[12px] break-all text-muted-foreground">
              {child.id}
            </span>
            <StatusWord tone={toneOf(child.status)}>{child.status}</StatusWord>
          </div>
          {child.message === null ? null : <RichText text={child.message} />}
        </div>
      ))}
      {agent.result === null ? null : <RichText text={agent.result} />}
    </Card>
  );
}
