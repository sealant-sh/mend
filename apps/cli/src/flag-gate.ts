import { type CommandDoc, COMMANDS, findCommand, usageOf } from "./help.ts";
import { isFlag } from "./shared.ts";

export interface FlagSpec {
  readonly spellings: ReadonlyArray<string>;
  readonly value: "none" | "required" | "optional";
}

const ROW =
  /^(--?[a-z][a-z0-9-]*(?:=[a-z0-9]+)?)(?:, (--?[a-z][a-z0-9-]*))?(?: (<[^<>]+>|\[[^[\]]+\]))?$/;

export const parseOptionRow = (flag: string): FlagSpec | null => {
  const match = ROW.exec(flag);
  if (match === null) return null;
  const [, first, second, value] = match;
  if (first === undefined) return null;
  return {
    spellings: second === undefined ? [first] : [first, second],
    value: value === undefined ? "none" : value.startsWith("<") ? "required" : "optional",
  };
};

const rowsOf = (doc: CommandDoc | null): ReadonlyArray<FlagSpec> =>
  (doc?.options ?? []).flatMap((option) => {
    const spec = parseOptionRow(option.flag);
    return spec === null ? [] : [spec];
  });

const LAUNCH_PARSER_PAGES: ReadonlyArray<string> = ["codex", "run"];

export const declaredFlags = (doc: CommandDoc): ReadonlyArray<FlagSpec> =>
  LAUNCH_PARSER_PAGES.includes(doc.name)
    ? LAUNCH_PARSER_PAGES.flatMap((name) => rowsOf(findCommand([name])))
    : rowsOf(doc);

export const ROOT_PAGES: ReadonlyMap<string, string> = new Map([
  ["-h", "help"],
  ["--help", "help"],
  ["-v", "version"],
  ["--version", "version"],
]);

export const VERB_ALIASES: ReadonlyArray<readonly [ReadonlyArray<string>, ReadonlyArray<string>]> =
  [
    [
      ["ssh", "keys", "rm"],
      ["ssh", "keys", "remove"],
    ],
  ];

export const GROUP_DEFAULTS: ReadonlyArray<readonly [ReadonlyArray<string>, string]> = [
  [["service"], "service run"],
  [["env"], "env show"],
  [["keys"], "keys show"],
  [["folder"], "folder list"],
  [["resource"], "resource list"],
  [["operator", "org"], "operator org list"],
];

const RECIPE_GROUP = "service";

const VERB_AFTER_FLAGS: ReadonlySet<string> = new Set(["folder", "operator", "workspace"]);

const COMMAND_TAIL = "-- <command...>";

const firstWordOf = (doc: CommandDoc): string => doc.name.split(" ")[0] ?? doc.name;

const startsWith = (words: ReadonlyArray<string>, prefix: ReadonlyArray<string>): boolean =>
  prefix.every((word, index) => words[index] === word);

const aliasedVerb = (words: ReadonlyArray<string>): ReadonlyArray<string> => {
  const alias = VERB_ALIASES.find(([from]) => startsWith(words, from));
  return alias === undefined ? words : [...alias[1], ...words.slice(alias[0].length)];
};

const groupDefault = (words: ReadonlyArray<string>): CommandDoc | null => {
  const entry = GROUP_DEFAULTS.find(
    ([prefix]) =>
      startsWith(words, prefix) && (words.length === prefix.length || prefix[0] === RECIPE_GROUP),
  );
  return entry === undefined ? null : findCommand(entry[1].split(" "));
};

const pageOf = (words: ReadonlyArray<string>): CommandDoc | null => {
  const verb = aliasedVerb(words);
  return findCommand(verb) ?? groupDefault(verb);
};

const valuedFlagsOf = (group: string): ReadonlySet<string> =>
  new Set(
    COMMANDS.filter((doc) => firstWordOf(doc) === group)
      .flatMap(declaredFlags)
      .filter((spec) => spec.value !== "none")
      .flatMap((spec) => spec.spellings),
  );

const leadingWords = (argv: ReadonlyArray<string>): ReadonlyArray<string> => {
  const end = argv.findIndex(isFlag);
  return end === -1 ? argv : argv.slice(0, end);
};

const wordsAroundFlags = (
  argv: ReadonlyArray<string>,
  valued: ReadonlySet<string>,
): ReadonlyArray<string> =>
  argv.filter((token, index) => {
    const previous = argv[index - 1];
    return !isFlag(token) && (previous === undefined || !valued.has(previous));
  });

type Resolved =
  | { readonly kind: "page"; readonly doc: CommandDoc; readonly tail: ReadonlyArray<string> }
  | { readonly kind: "group"; readonly group: string; readonly tail: ReadonlyArray<string> }
  | { readonly kind: "flags before words"; readonly doc: CommandDoc }
  | { readonly kind: "ungated" };

const pageNamed = (name: string, tail: ReadonlyArray<string>): Resolved => {
  const doc = findCommand(name.split(" "));
  return doc === null ? { kind: "ungated" } : { kind: "page", doc, tail };
};

const pageOrGroup = (
  doc: CommandDoc | null,
  group: string,
  argv: ReadonlyArray<string>,
): Resolved =>
  doc === null ? { kind: "group", group, tail: argv } : { kind: "page", doc, tail: argv };

const resolve = (argv: ReadonlyArray<string>): Resolved => {
  const [first] = argv;
  if (first === undefined) return pageNamed("ui", []);
  const root = ROOT_PAGES.get(first);
  if (root !== undefined) return pageNamed(root, argv.slice(1));
  if (first === "qr" || isFlag(first)) return { kind: "ungated" };
  if (!COMMANDS.some((doc) => firstWordOf(doc) === first || doc.aliases?.includes(first))) {
    return { kind: "ungated" };
  }
  const around = pageOf(wordsAroundFlags(argv, valuedFlagsOf(first)));
  if (VERB_AFTER_FLAGS.has(first)) return pageOrGroup(around, first, argv);
  const leading = pageOf(leadingWords(argv));
  if (around !== null && around !== leading) return { kind: "flags before words", doc: around };
  return pageOrGroup(leading, first, argv);
};

const scan = (
  tail: ReadonlyArray<string>,
  specs: ReadonlyArray<FlagSpec>,
  commandTail: boolean,
): string | null => {
  const bySpelling = new Map(
    specs.flatMap((spec) => spec.spellings.map((s) => [s, spec] as const)),
  );
  for (let index = 0; index < tail.length; index += 1) {
    const token = tail[index] ?? "";
    if (token === "--") return commandTail ? null : "unknown flag --";
    if (!isFlag(token)) continue;
    const spec = bySpelling.get(token);
    if (spec === undefined) return `unknown flag ${token}`;
    if (spec.value === "none") continue;
    const next = tail[index + 1];
    if (next !== undefined && !isFlag(next)) {
      index += 1;
      continue;
    }
    if (spec.value === "required") return `${token} needs a value`;
  }
  return null;
};

export const flagRefusal = (argv: ReadonlyArray<string>): string | null => {
  const resolved = resolve(argv);
  if (resolved.kind === "ungated") return null;
  if (resolved.kind === "flags before words") {
    return `put flags after the command words · ${usageOf(resolved.doc.name)}`;
  }
  if (resolved.kind === "group") {
    const reason = scan(resolved.tail, [], false);
    return reason === null ? null : `${reason} · mend help ${resolved.group} lists them`;
  }
  const commandTail = resolved.doc.synopsis.some((shape) => shape.includes(COMMAND_TAIL));
  const reason = scan(resolved.tail, declaredFlags(resolved.doc), commandTail);
  return reason === null ? null : `${reason} · ${usageOf(resolved.doc.name)}`;
};
