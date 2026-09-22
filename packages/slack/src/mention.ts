import { EFFORT_LEVELS, HARNESS_MODELS, type EffortLevel } from "@mend/domain/workbench";

import { slackToPlain, userMentionPattern, type SlackUserNames } from "./markup.ts";
import { parseRepositoryUrl, projectsNamedBy, type RepositoryProject } from "./repository.ts";

/**
 * Reading a mention (docs/adr/0006-slack.md, "Reading a mention"). Options come inline
 * (`project=billing-api`) or in natural forms (`in billing-api with codex, …`). Inline options are
 * parsed exactly and always win; a later duplicate wins over an earlier one. The natural forms
 * read here are the deterministic ones: a run of option phrases at the very start or the very end
 * of the request, each of whose values Mend recognises. Anything else is left in the prompt, for
 * the inference step (PR 8) or for the agent.
 */

/** Words that are commands when they are the first word of a mention. */
export const MENTION_COMMANDS = ["help", "settings", "list", "new"] as const;
export type MentionCommand = (typeof MENTION_COMMANDS)[number];

export const MENTION_OPTIONS = ["project", "branch", "harness", "model", "effort"] as const;
export type MentionOptionName = (typeof MENTION_OPTIONS)[number];

/** An option and how it was written: `inline` (`key=value`) or `natural` (`in <project>`). */
export interface MentionOption<A extends string = string> {
  readonly value: A;
  readonly form: "inline" | "natural";
}

export interface MentionOptions {
  readonly project: MentionOption | null;
  readonly branch: MentionOption | null;
  readonly harness: MentionOption | null;
  readonly model: MentionOption | null;
  readonly effort: MentionOption<EffortLevel> | null;
}

/** An inline option Mend could not use, with the reason worded for a reply in the thread. */
export interface RejectedOption {
  readonly option: MentionOptionName;
  readonly value: string;
  readonly reason: string;
}

export interface ParsedMention {
  /** The first word, when it is a command; the prompt is what follows it. */
  readonly command: MentionCommand | null;
  /** The request as plain text, with the bot mention, the command and the options taken out. */
  readonly prompt: string;
  readonly options: MentionOptions;
  readonly rejected: ReadonlyArray<RejectedOption>;
}

/**
 * What natural forms are read against. A natural value Mend does not recognise is not an option,
 * so `in short, the test is flaky` keeps its words.
 */
export interface MentionVocabulary {
  /** The harnesses a mention may name, for `harness=` and `with <harness>`. */
  readonly harnesses: ReadonlyArray<string>;
  /** Models by harness, for `with <model>`; a model listed under one harness also names it. */
  readonly models: Readonly<Record<string, ReadonlyArray<string>>>;
  /** The projects `in <project>` may name, by name or by repository. */
  readonly projects: ReadonlyArray<RepositoryProject>;
}

/**
 * The harnesses that run in protocol mode, the one mode Slack starts, with their catalogued
 * models. Claude also takes the family aliases its CLI accepts.
 */
export const DEFAULT_MENTION_VOCABULARY: MentionVocabulary = {
  harnesses: ["claude", "codex"],
  models: {
    claude: [...(HARNESS_MODELS.claude ?? []).map((model) => model.id), "opus", "sonnet", "haiku"],
    codex: (HARNESS_MODELS.codex ?? []).map((model) => model.id),
  },
  projects: [],
};

/** Branches `from <branch>` and `on <branch>` name without quotes. */
const PLAIN_BRANCHES: ReadonlySet<string> = new Set(["main", "master", "develop", "trunk"]);

/** Prefixes that make `from <prefix>/…` a branch rather than, say, a directory. */
const BRANCH_PREFIXES: ReadonlySet<string> = new Set([
  "bugfix",
  "chore",
  "dependabot",
  "feat",
  "feature",
  "fix",
  "hotfix",
  "mend",
  "release",
  "releases",
  "renovate",
]);

const INLINE_OPTION =
  /(?<=^|\s)(project|branch|harness|model|effort)=("[^"]*"|“[^”]*”|'[^']*'|‘[^’]*’|\S+)(?=[\s,;]|$)[ \t]*/gi;

const QUOTED = /^(?:"([^"]*)"|“([^”]*)”|'([^']*)'|‘([^’]*)’|`([^`]*)`)$/;

/** A value with its quotes taken off; `quoted` says it had them. */
const unquote = (raw: string): { readonly value: string; readonly quoted: boolean } => {
  const match = QUOTED.exec(raw);
  if (match === null) return { value: raw.replace(/[.,;:!?]+$/, ""), quoted: false };
  const inner = match.slice(1).find((group) => group !== undefined) ?? "";
  return { value: inner.trim(), quoted: true };
};

const isOptionName = (name: string): name is MentionOptionName =>
  MENTION_OPTIONS.some((option) => option === name);

const isEffort = (value: string): value is EffortLevel =>
  EFFORT_LEVELS.some((level) => level === value);

const isCommand = (word: string): word is MentionCommand =>
  MENTION_COMMANDS.some((command) => command === word);

interface Found {
  readonly option: MentionOptionName;
  readonly value: string;
  /** A harness a model implies (`with opus`), which a named harness overrides. */
  readonly implied: boolean;
}

interface Token {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

const tokenise = (text: string): ReadonlyArray<Token> =>
  [...text.matchAll(/"[^"]*"|“[^”]*”|`[^`]*`|\S+/g)].map((match) => ({
    text: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }));

/** The harness a model belongs to, when exactly one lists it. */
const harnessOfModel = (vocabulary: MentionVocabulary, model: string): string | null => {
  const owners = Object.entries(vocabulary.models)
    .filter(([, models]) => models.some((known) => known.toLowerCase() === model))
    .map(([harness]) => harness);
  return owners.length === 1 ? (owners[0] ?? null) : null;
};

const modelIn = (vocabulary: MentionVocabulary, model: string): string | null => {
  for (const models of Object.values(vocabulary.models)) {
    const known = models.find((candidate) => candidate.toLowerCase() === model);
    if (known !== undefined) return known;
  }
  return null;
};

const isBranch = (value: string, quoted: boolean): boolean => {
  if (value === "" || /\s/.test(value)) return false;
  if (quoted || PLAIN_BRANCHES.has(value)) return true;
  const [prefix, ...rest] = value.split("/");
  return (
    rest.length > 0 && rest.every((segment) => segment !== "") && BRANCH_PREFIXES.has(prefix ?? "")
  );
};

const bare = (token: Token | undefined): string =>
  (token?.text ?? "").toLowerCase().replace(/[.,;:!?]+$/, "");

/**
 * The natural phrase that starts at token `at`, as the options it gives and the tokens it takes
 * (two, or three for `with <level> effort`). Null when the words there are not a phrase Mend
 * recognises.
 */
const phraseAt = (
  tokens: ReadonlyArray<Token>,
  at: number,
  vocabulary: MentionVocabulary,
): { readonly found: ReadonlyArray<Found>; readonly length: number } | null => {
  const keyword = bare(tokens[at]);
  const raw = tokens[at + 1];
  if (raw === undefined) return null;
  const { value, quoted } = unquote(raw.text);
  if (value === "") return null;
  const lower = value.toLowerCase();
  switch (keyword) {
    case "in": {
      const named =
        quoted ||
        projectsNamedBy(value, vocabulary.projects).length > 0 ||
        parseRepositoryUrl(value) !== null;
      return named ? { found: [{ option: "project", value, implied: false }], length: 2 } : null;
    }
    case "from":
    case "on":
      return isBranch(value, quoted)
        ? { found: [{ option: "branch", value, implied: false }], length: 2 }
        : null;
    case "with": {
      if (!quoted && isEffort(lower) && bare(tokens[at + 2]) === "effort") {
        return { found: [{ option: "effort", value: lower, implied: false }], length: 3 };
      }
      if (vocabulary.harnesses.includes(lower)) {
        return { found: [{ option: "harness", value: lower, implied: false }], length: 2 };
      }
      const model = modelIn(vocabulary, lower);
      if (model === null) return null;
      const harness = harnessOfModel(vocabulary, lower);
      const named: Found = { option: "model", value: model, implied: false };
      return {
        found:
          harness === null
            ? [named]
            : [named, { option: "harness", value: harness, implied: true }],
        length: 2,
      };
    }
    default:
      return null;
  }
};

/** Phrases from the first token on; returns the options and the index of the first prose token. */
const leadingPhrases = (
  tokens: ReadonlyArray<Token>,
  vocabulary: MentionVocabulary,
): { readonly found: ReadonlyArray<Found>; readonly next: number } => {
  const found: Array<Found> = [];
  let at = 0;
  while (at < tokens.length) {
    const joined = found.length > 0 && bare(tokens[at]) === "and" ? at + 1 : at;
    const phrase = phraseAt(tokens, joined, vocabulary);
    if (phrase === null) break;
    found.push(...phrase.found);
    at = joined + phrase.length;
  }
  return { found, next: at };
};

/** The phrase that ends just before token `end` and starts no earlier than `from`. */
const phraseEndingAt = (
  tokens: ReadonlyArray<Token>,
  end: number,
  from: number,
  vocabulary: MentionVocabulary,
): { readonly found: ReadonlyArray<Found>; readonly start: number } | null => {
  for (const length of [3, 2]) {
    const start = end - length;
    if (start < from) continue;
    const phrase = phraseAt(tokens, start, vocabulary);
    if (phrase !== null && phrase.length === length) return { found: phrase.found, start };
  }
  return null;
};

/**
 * Phrases that end at the last token, read backwards and no earlier than `from`; returns the
 * options, in the order they were written, and the index of the first token they take.
 */
const trailingPhrases = (
  tokens: ReadonlyArray<Token>,
  from: number,
  vocabulary: MentionVocabulary,
): { readonly found: ReadonlyArray<Found>; readonly start: number } => {
  const runs: Array<ReadonlyArray<Found>> = [];
  let start = tokens.length;
  let end = tokens.length;
  for (;;) {
    const phrase = phraseEndingAt(tokens, end, from, vocabulary);
    if (phrase === null) break;
    runs.unshift(phrase.found);
    start = phrase.start;
    // `… in billing-api and with codex`: an `and` joins two phrases, and stays in the prose
    // when no phrase comes before it.
    end = start > from && bare(tokens[start - 1]) === "and" ? start - 1 : start;
  }
  return { found: runs.flat(), start };
};

/** Commas and semicolons left at either end once options are taken out. */
const EDGE_PUNCTUATION = /^[\s,;]+|[\s,;]+$/g;

/** A dash on its own between options and the request: `in web — fix the test`. */
const DASH = /^[—–-]+$/;

/**
 * Parses a mention's Slack text: strips every mention of the bot, reads a leading command,
 * the inline options anywhere in the text, then the natural forms at either end. `names` names
 * the other users the text mentions.
 */
export const parseMention = (
  text: string,
  botUserId: string,
  vocabulary: MentionVocabulary = DEFAULT_MENTION_VOCABULARY,
  names?: SlackUserNames,
): ParsedMention => {
  const botMention = new RegExp(`[ \\t]*${userMentionPattern(botUserId).source}[ \\t]*`, "g");
  const plain = slackToPlain(text.replace(botMention, " "), names);

  const inline = new Map<MentionOptionName, string>();
  const rejected: Array<RejectedOption> = [];
  const withoutInline = plain.replace(INLINE_OPTION, (whole, key: string, raw: string) => {
    const option = key.toLowerCase();
    if (!isOptionName(option)) return whole;
    const { value } = unquote(raw);
    const normalised = option === "harness" || option === "effort" ? value.toLowerCase() : value;
    if (normalised === "") {
      rejected.push({ option, value, reason: "no value" });
    } else if (option === "effort" && !isEffort(normalised)) {
      rejected.push({ option, value, reason: `not one of ${EFFORT_LEVELS.join(", ")}` });
    } else if (option === "harness" && !vocabulary.harnesses.includes(normalised)) {
      rejected.push({ option, value, reason: `not one of ${vocabulary.harnesses.join(", ")}` });
    } else {
      inline.set(option, normalised);
    }
    return "";
  });

  const body = withoutInline.trim();
  const first = /^(\S+)/.exec(body)?.[1] ?? "";
  const word = first.toLowerCase().replace(/[.,;:!?]+$/, "");
  const command = isCommand(word) ? word : null;
  const rest = command === null ? body : body.slice(first.length).replace(/^\s*(?:[—–]\s*)?/, "");

  const natural = new Map<MentionOptionName, string>();
  let prompt = rest;
  if (command === null || command === "new") {
    const tokens = tokenise(rest);
    const leading = leadingPhrases(tokens, vocabulary);
    const trailing = trailingPhrases(tokens, leading.next, vocabulary);
    const found = [...leading.found, ...trailing.found];
    for (const { option, value, implied } of found) {
      // A harness a model implies never overrides one the mention names.
      if (implied && found.some((other) => other.option === option && !other.implied)) continue;
      natural.set(option, value);
    }
    let head = leading.next;
    if (leading.found.length > 0 && DASH.test(tokens[head]?.text ?? "")) head += 1;
    let tail = trailing.start;
    if (trailing.found.length > 0 && tail - 1 >= head && DASH.test(tokens[tail - 1]?.text ?? "")) {
      tail -= 1;
    }
    const startAt = tokens[head]?.start ?? rest.length;
    const endAt = tokens[tail]?.start ?? rest.length;
    prompt = rest.slice(startAt, Math.max(startAt, endAt));
  }

  const pick = (option: MentionOptionName): MentionOption | null => {
    const fromInline = inline.get(option);
    if (fromInline !== undefined) return { value: fromInline, form: "inline" };
    const fromNatural = natural.get(option);
    return fromNatural === undefined ? null : { value: fromNatural, form: "natural" };
  };
  const effort = pick("effort");
  return {
    command,
    prompt: prompt.replace(EDGE_PUNCTUATION, ""),
    options: {
      project: pick("project"),
      branch: pick("branch"),
      harness: pick("harness"),
      model: pick("model"),
      effort:
        effort !== null && isEffort(effort.value)
          ? { value: effort.value, form: effort.form }
          : null,
    },
    rejected,
  };
};
