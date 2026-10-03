import {
  agentFacts,
  taskFacts,
  taskKindName,
  taskPhaseGroups,
  type AgentTaskAgentView,
  type AgentTaskView,
} from "@mend/agent-conversation";
import { useState } from "react";
import { StyleSheet, View } from "react-native";

import { EvButton } from "@/components/button";
import { StatusWord, type StatusTone } from "@/components/status";
import { Eyebrow, MonoText, UiText } from "@/components/typography";
import { radius, useEvidenceTheme } from "@/theme/evidence";

/** Agents a card shows before it asks to show the rest. */
const AGENTS_SHOWN = 12;

const taskTone = (status: string): StatusTone => {
  switch (status) {
    case "running":
      return "live";
    case "completed":
      return "observed";
    case "failed":
      return "breakage";
    default:
      return "pending";
  }
};

const agentTone = (state: string): StatusTone => {
  switch (state) {
    case "running":
      return "live";
    case "done":
      return "observed";
    case "error":
      return "breakage";
    default:
      return "pending";
  }
};

function AgentRow({ agent }: { readonly agent: AgentTaskAgentView }) {
  const facts = agentFacts(agent);
  return (
    <View style={{ gap: 2 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <StatusWord tone={agentTone(agent.state)} word={agent.state} size={10.5} />
        <UiText size={12.5} numberOfLines={1} style={{ flex: 1 }}>
          {agent.label}
        </UiText>
      </View>
      {facts === "" ? null : (
        <MonoText tone="faint" size={10.5} numberOfLines={1}>
          {facts}
        </MonoText>
      )}
      {agent.preview === null ? null : (
        <MonoText tone={agent.state === "error" ? "danger" : "muted"} size={10.5} numberOfLines={2}>
          {agent.preview}
        </MonoText>
      )}
    </View>
  );
}

/**
 * A background task the agent started: a workflow with its phases and agents, or a background
 * agent or command. It sits on the turn that started it and keeps growing after that turn ends.
 */
export function TaskCard({ task }: { readonly task: AgentTaskView }) {
  const { colors } = useEvidenceTheme();
  const [showAll, setShowAll] = useState(false);
  const groups = taskPhaseGroups(task);
  const name = task.workflow ?? task.description;
  const facts = taskFacts(task);
  let budget = showAll ? Number.POSITIVE_INFINITY : AGENTS_SHOWN;
  const shown = groups.flatMap((group) => {
    if (budget <= 0) return [];
    const agents = group.agents.slice(0, budget);
    budget -= agents.length;
    return group.title === null && agents.length === 0 ? [] : [{ ...group, agents }];
  });
  const hidden = task.agents.length - shown.reduce((sum, group) => sum + group.agents.length, 0);

  return (
    <View
      style={{
        backgroundColor: colors.panel,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colors.rule,
        borderRadius: radius.lg,
        padding: 12,
        gap: 10,
      }}
    >
      <View style={{ gap: 3 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Eyebrow style={{ flex: 1 }}>{taskKindName(task)}</Eyebrow>
          <StatusWord tone={taskTone(task.status)} word={task.status} />
        </View>
        <UiText weight="medium" numberOfLines={2}>
          {name}
        </UiText>
        {task.workflow !== null && task.description !== "" && task.description !== name ? (
          <UiText tone="muted" size={12.5} numberOfLines={3}>
            {task.description}
          </UiText>
        ) : null}
      </View>

      {shown.map((group) => (
        <View key={group.title ?? "agents"} style={{ gap: 8 }}>
          {group.title === null ? null : (
            <UiText tone="label" weight="medium" size={12}>
              {group.title}
            </UiText>
          )}
          {group.agents.map((agent) => (
            <AgentRow key={agent.index} agent={agent} />
          ))}
        </View>
      ))}
      {hidden > 0 ? (
        <View style={{ flexDirection: "row" }}>
          <EvButton
            size="sm"
            variant="ghost"
            label={`Show ${hidden} more agents`}
            onPress={() => setShowAll(true)}
          />
        </View>
      ) : null}

      {facts === "" && task.summary === null && task.error === null ? null : (
        <View
          style={{
            gap: 2,
            borderTopWidth: StyleSheet.hairlineWidth,
            borderTopColor: colors.softRule,
            paddingTop: 8,
          }}
        >
          {facts === "" ? null : (
            <MonoText tone="faint" size={10.5}>
              {facts}
            </MonoText>
          )}
          {task.error === null ? null : (
            <MonoText tone="danger" size={10.5} numberOfLines={3}>
              {task.error}
            </MonoText>
          )}
          {task.summary === null ? null : (
            <MonoText tone="muted" size={10.5} numberOfLines={2}>
              {task.summary}
            </MonoText>
          )}
        </View>
      )}
    </View>
  );
}
