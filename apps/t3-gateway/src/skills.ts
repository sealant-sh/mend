import type { ServerProviderSkill, ServerProviderWorkspaceSnapshot } from "@mend/t3-contracts";

import type { MendSkill } from "./mend-workbench.ts";

/**
 * The skills a session of a project receives, by name, the project's over the person's. `user` is
 * empty for a project that does not inherit its launcher's skills.
 */
export const deliveredSkills = (
  user: ReadonlyArray<MendSkill>,
  project: ReadonlyArray<MendSkill>,
): ReadonlyArray<MendSkill> => {
  const byName = new Map<string, MendSkill>();
  for (const skill of [...user, ...project]) byName.set(skill.name, skill);
  return [...byName.values()];
};

const SKILL_DIRECTORIES: Readonly<Record<string, string>> = {
  claude: "~/.claude/skills",
  codex: "~/.codex/skills",
};

/** The skills Mend delivered to a workspace, as the gateway last read them. */
export interface WorkspaceSkills {
  readonly cwd: string;
  readonly checkedAt: string;
  readonly skills: ReadonlyArray<MendSkill>;
}

const providerSkillOf = (harness: string, skill: MendSkill): ServerProviderSkill => {
  const description = skill.description.trim();
  return {
    name: skill.name,
    ...(description.length === 0 ? {} : { description }),
    path: `${SKILL_DIRECTORIES[harness] ?? "~/.agents/skills"}/${skill.name}/SKILL.md`,
    scope: skill.scope,
    enabled: true,
  };
};

/** A workspace's skills as t3code's provider for a harness lists them. Mend has no slash commands. */
export const workspaceSnapshotOf = (
  harness: string,
  workspace: WorkspaceSkills,
): ServerProviderWorkspaceSnapshot => ({
  cwd: workspace.cwd,
  checkedAt: workspace.checkedAt,
  slashCommands: [],
  skills: workspace.skills.map((skill) => providerSkillOf(harness, skill)),
});

/**
 * A skill as t3code's composers write one: any currency sigil and a name
 * (`SKILL_MENTION_PATTERN`, packages/shared/src/composerInlineTokens.ts at the pinned tag).
 */
const SKILL_MENTION =
  /(^|\s)\p{Sc}(?![0-9][0-9_]*(?:[kKmMbBtT]|[eE][0-9]+)?(?:\s|$))(?=[a-zA-Z0-9:_-]*[a-zA-Z])([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s|$)/gu;

export const mentionsSkill = (text: string): boolean => new RegExp(SKILL_MENTION).test(text);

/**
 * The message as the harness invokes a skill. Codex reads `$name` in the text, whatever sigil was
 * typed (`codexSkillMentionText`). Claude Code expands only a message that starts with `/name`,
 * and one skill per message (`planClaudeSkillDispatch`): the last skill named leads as `/name`,
 * the rest of the message, in order and without it, is its arguments, and any earlier skill named
 * stays inline as `/name`. A name Mend did not deliver is left as typed.
 */
export const skillInvocationOf = (
  harness: string,
  text: string,
  skillNames: ReadonlySet<string>,
): string => {
  if (harness === "codex") return text.replace(SKILL_MENTION, "$1$$$2");
  if (harness !== "claude") return text;
  const mentions = [...text.matchAll(SKILL_MENTION)].flatMap((match) => {
    const name = match[2] ?? "";
    if (!skillNames.has(name)) return [];
    const start = match.index + (match[1]?.length ?? 0);
    return [{ name, start, end: match.index + match[0].length }];
  });
  const last = mentions.at(-1);
  if (last === undefined) return text;
  const leading = mentions
    .slice(0, -1)
    .reduceRight(
      (rest, mention) =>
        `${rest.slice(0, mention.start)}/${mention.name}${rest.slice(mention.end)}`,
      text.slice(0, last.start),
    )
    .trim();
  const trailing = text.slice(last.end).trimEnd();
  return leading.length === 0 ? `/${last.name}${trailing}` : `/${last.name} ${leading}${trailing}`;
};
