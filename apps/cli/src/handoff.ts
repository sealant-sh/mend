import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  formatFactLine,
  handoffWorktreeName,
  HexSha,
  repositoryCloneUrlIssue,
} from "@mend/domain/workbench";
import { Schema } from "effect";

import { failureWords, noteRefusal } from "./failure-words.ts";
import {
  checkoutOf,
  type HandoffSnapshot,
  type LeftOut,
  preflightIssue,
  scratchParentIssue,
  snapshotCheckout,
  type SnapshotRequest,
} from "./handoff-snapshot.ts";
import { type Download, type Downloaded, formatBytes, remoteForOrigin } from "./landing.ts";
import type { ApiCall } from "./pair.ts";
import { askYesNo, confirmPlan } from "./shared-workspace.ts";
import {
  matchProjectByCwd,
  normalizeProjectName,
  normalizeRemoteUrl,
  redactCredentials,
} from "./shared.ts";

const paint = (code: string) => (text: string) =>
  process.stdout.isTTY === true ? `\u001b[${code}m${text}\u001b[0m` : text;
const dim = paint("2");
const green = paint("32");
const amber = paint("33");
const say = (line: string) => process.stdout.write(`${redactCredentials(line)}\n`);

/** A refusal on its way to the command boundary, which says it and exits. */
class Refusal extends Error {
  readonly words: string;
  readonly code: number;
  constructor(words: string, code = 1) {
    super(words);
    this.words = words;
    this.code = code;
  }
}

const refuse = (words: string): never => {
  throw new Refusal(words);
};

interface ProjectDto {
  readonly id: string;
  readonly name: string;
  readonly originUrl: string | null;
  readonly storePath: string;
  readonly defaultBranch: string;
}

interface HandoffTerms {
  readonly bundleBytes: number;
  readonly fileBytes: number;
}

interface HandoffReceived {
  readonly session: {
    readonly id: string;
    readonly status: string;
    readonly summary: string | null;
  };
  readonly worktree: { readonly name: string };
  readonly replayed: boolean;
  readonly previous: { readonly name: string } | null;
}

export type Launched =
  | { readonly _tag: "running" }
  | { readonly _tag: "not-started"; readonly words: string }
  | { readonly _tag: "no-answer"; readonly words: string };

export type Uploaded =
  | ({ readonly _tag: "answered" } & Downloaded)
  | { readonly _tag: "no-answer"; readonly message: string };

export type Upload = (
  route: string,
  contentType: string,
  body: Uint8Array<ArrayBuffer>,
) => Promise<Uploaded>;

export interface HandoffDeps {
  readonly api: ApiCall;
  readonly download: Download;
  readonly upload: Upload;
  readonly serverVersion: () => Promise<string | null>;
  readonly launch: (sessionId: string, prompt: string) => Promise<Launched>;
  readonly spin: <T>(label: string, work: Promise<T>) => Promise<T>;
  readonly serverUrl: string;
}

export interface HandoffIo {
  readonly interactive: boolean;
  readonly ask: (question: string) => Promise<boolean>;
}

const HARNESSES: ReadonlyArray<string> = ["claude", "codex", "opencode", "pi"];

export interface HandoffArgs {
  readonly prompt: string | null;
  readonly harness: string;
  readonly project: string | null;
}

export const parseHandoffArgs = (
  args: ReadonlyArray<string>,
): { readonly args: HandoffArgs } | { readonly error: string } => {
  let prompt: string | null = null;
  let harness = "claude";
  let project: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--with" || arg === "--project") {
      const value = args[index + 1];
      if (value === undefined) return { error: `${arg} needs a value` };
      if (arg === "--with") harness = value;
      else project = value;
      index += 1;
    } else if (arg === "--yes" || arg === "-y") {
      continue;
    } else if (arg.startsWith("-")) {
      return { error: `unknown flag ${arg} · quote the prompt if it starts with "-"` };
    } else if (prompt !== null) {
      return { error: 'one prompt only · quote it: mend handoff "finish the tests"' };
    } else {
      prompt = arg;
    }
  }
  if (!HARNESSES.includes(harness)) {
    return { error: `--with takes ${HARNESSES.join(", ")}, not "${harness}"` };
  }
  return { args: { prompt: prompt?.trim() === "" ? null : prompt, harness, project } };
};

const sizeOf = (bytes: number): string => formatBytes(bytes).replace(/\.0 /u, " ");

const count = (n: number, one: string, many: string): string =>
  n === 0 ? `no ${many}` : `${n} ${n === 1 ? one : many}`;

export const machineName = (hostname: string = os.hostname()): string => {
  const name = [
    ...hostname
      .replace(/\.local$/iu, "")
      .replace(/\p{Cc}/gu, "")
      .trim(),
  ]
    .slice(0, 64)
    .join("")
    .trim();
  return name === "" ? "this machine" : name;
};

type NamedLeftOut = Exclude<LeftOut, { readonly reason: "env" }>;

const leftOutLine = (out: NamedLeftOut, fileBytes: number): string =>
  out.reason === "over-limit"
    ? `${sizeOf(out.bytes)}, over the ${sizeOf(fileBytes)} file limit`
    : `filter ${out.filter}, which a handoff does not run`;

export const snapshotLines = (
  snapshot: HandoffSnapshot,
  defaultBranch: string,
  fileBytes: number,
): ReadonlyArray<string> => {
  const where = snapshot.localBranch ?? `detached at ${snapshot.head.slice(0, 7)}`;
  const env = snapshot.leftOut.filter((out) => out.reason === "env").map((out) => out.path);
  return [
    `${green("✓")} ${where} · ${formatFactLine({ ...snapshot.facts, defaultBranch })}`,
    `${dim("  stays here")} · gitignored files and .env files${env.length === 0 ? "" : `: ${env.join(", ")}`}`,
    ...snapshot.committedEnv.map(
      (committed) => `${amber("  travels in a commit")} · ${committed.path} (${committed.commit})`,
    ),
    ...snapshot.leftOut
      .filter((out): out is NamedLeftOut => out.reason !== "env")
      .map((out) => `${dim("  left out")} · ${out.path} · ${leftOutLine(out, fileBytes)}`),
  ];
};

export const progressLine = (snapshot: HandoffSnapshot): string =>
  dim(
    `  bundling ${count(snapshot.facts.commitsAhead, "commit", "commits")} · ${count(
      snapshot.facts.uncommitted + snapshot.facts.untracked,
      "file",
      "files",
    )} → uploading ${sizeOf(snapshot.bundleBytes)} → creating worktree`,
  );

const clockOf = (iso: string): string => new Date(iso).toTimeString().slice(0, 8);

export const receivedLines = (
  received: HandoffReceived,
  snapshot: HandoffSnapshot,
  defaultBranch: string,
): ReadonlyArray<string> => {
  const name = received.worktree.name;
  const first = handoffWorktreeName(
    snapshot.localBranch,
    Schema.decodeUnknownSync(HexSha)(snapshot.head),
    () => false,
  );
  const handed = received.replayed ? `already handed off as ${name}` : `handed off as ${name}`;
  const why =
    received.previous !== null
      ? [`${received.previous.name} is your earlier handoff`]
      : name === first
        ? []
        : [`${first} was taken`];
  return [
    [
      `${green("✓")} ${handed}`,
      ...why,
      "your checkout is unchanged",
      `as of ${clockOf(snapshot.cutAt)}`,
    ].join(" · "),
    `${dim("  base")} ${defaultBranch} ${snapshot.mergeBase.slice(0, 7)} · session ${received.session.id.slice(0, 8)}`,
  ];
};

const parseJson = (bytes: Uint8Array): unknown => {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
};

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;

const termsOf = (body: unknown): HandoffTerms | null => {
  const bundleBytes = field(body, "bundleBytes");
  const fileBytes = field(body, "fileBytes");
  return typeof bundleBytes === "number" && typeof fileBytes === "number"
    ? { bundleBytes, fileBytes }
    : null;
};

const receivedOf = (body: unknown): HandoffReceived | null => {
  const session = field(body, "session");
  const id = field(session, "id");
  const status = field(session, "status");
  const summary = field(session, "summary") ?? null;
  const name = field(field(body, "worktree"), "name");
  const replayed = field(body, "replayed");
  const previous = field(body, "previous") ?? null;
  const previousName = field(previous, "name");
  return typeof id === "string" &&
    typeof status === "string" &&
    (summary === null || typeof summary === "string") &&
    typeof name === "string" &&
    typeof replayed === "boolean" &&
    (previous === null || typeof previousName === "string")
    ? {
        session: { id, status, summary },
        worktree: { name },
        replayed,
        previous: typeof previousName === "string" ? { name: previousName } : null,
      }
    : null;
};

export const heldLine = (session: HandoffReceived["session"]): string => {
  switch (session.status) {
    case "idle":
      return `${green("✓")} held · idle, no agent`;
    case "starting":
      return `${dim("  starting")} · the hold is still coming up`;
    case "failed":
      return `${amber("!")} not held · failed${session.summary === null ? "" : ` · ${session.summary}`}`;
    default:
      return `${amber("·")} the session reads ${session.status}`;
  }
};

const predatesHandoffs = (answer: Downloaded): boolean =>
  answer.status === 404 && typeof field(parseJson(answer.bytes), "_tag") !== "string";

const serverTakesHandoffs = async (deps: HandoffDeps): Promise<boolean> =>
  !predatesHandoffs(await deps.download("/projects/handoff-probe/handoffs"));

const oldServer = async (deps: HandoffDeps): Promise<never> => {
  const version = await deps.serverVersion();
  return refuse(
    `this Mend server${version === null ? "" : ` (${version})`} does not take handoffs · upgrade it, then hand off again · nothing was created`,
  );
};

const tooLarge = (bytes: number, limit: number): string =>
  `handoff not sent · the bundle is ${sizeOf(bytes)} (${bytes} bytes) · the server's limit is ${sizeOf(limit)} (MEND_BUDGET_BUNDLE_BYTES) · nothing was created`;

const refusal = async (deps: HandoffDeps, call: string, answer: Downloaded): Promise<never> => {
  if (predatesHandoffs(answer)) return oldServer(deps);
  const body = parseJson(answer.bytes);
  return refuse(noteRefusal(call, answer.status, failureWords(answer.status, body)).words);
};

const termsFor = async (deps: HandoffDeps, projectId: string): Promise<HandoffTerms> => {
  const route = `/projects/${projectId}/handoffs`;
  const answer = await deps.download(route);
  if (answer.status !== 200) return refusal(deps, `GET ${route}`, answer);
  const terms = termsOf(parseJson(answer.bytes));
  if (terms === null) {
    return refuse("the server's handoff terms are in a shape this CLI cannot read · update mend");
  }
  return terms;
};

const UPLOAD_ATTEMPTS = 3;

const GATEWAY_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

const send = async (
  deps: HandoffDeps,
  route: string,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<Downloaded> => {
  for (let attempt = 1; ; attempt += 1) {
    const uploaded = await deps.spin(
      `uploading ${sizeOf(bytes.byteLength)}`,
      deps.upload(route, "application/x-git-bundle", bytes),
    );
    if (uploaded._tag === "answered" && !GATEWAY_STATUSES.has(uploaded.status)) return uploaded;
    const words = uploaded._tag === "answered" ? `HTTP ${uploaded.status}` : uploaded.message;
    if (attempt === UPLOAD_ATTEMPTS) {
      return refuse(
        `${words} · sent ${UPLOAD_ATTEMPTS} times with no answer from Mend · mend sessions shows whether it arrived`,
      );
    }
    say(
      dim(
        `  ${uploaded._tag === "answered" ? words : "no answer"} · sending the same bundle again`,
      ),
    );
  }
};

const CO_LOCATED =
  "this server keeps worktrees in the co-located store, which takes no handoffs · the operator can unset MEND_SESSION_STORE to run the capture store · nothing was created";

interface Resolved {
  readonly project: ProjectDto;
  readonly adopted: boolean;
}

const projectFor = async (
  deps: HandoffDeps,
  args: ReadonlyArray<string>,
  explicit: string | null,
  checkout: { readonly top: string; readonly originUrl: string | null },
  io: HandoffIo,
): Promise<Resolved | null> => {
  const projects = await deps.api<ReadonlyArray<ProjectDto>>("GET", "/projects");
  const found =
    explicit === null
      ? matchProjectByCwd(projects, {
          cwd: checkout.top,
          repoRoot: checkout.top,
          originUrl: checkout.originUrl,
        })
      : projects.find((project) => project.name === explicit);
  if (explicit !== null && found === undefined) {
    return refuse(`no adopted project named "${explicit}"`);
  }
  const origin = checkout.originUrl;
  if (found !== undefined) {
    const originMatches =
      origin !== null &&
      remoteForOrigin([{ name: "origin", url: origin }], found.originUrl, checkout.top) !== null;
    if (!originMatches) {
      return refuse(
        `this checkout's origin is ${origin ?? "not set"} · ${found.name}'s is ${found.originUrl ?? "not set"} · nothing was created`,
      );
    }
    return { project: found, adopted: false };
  }
  if (origin === null) {
    return refuse(
      "no adopted project matches this checkout, and it has no origin to adopt · nothing was created",
    );
  }
  const issue = repositoryCloneUrlIssue(origin);
  if (issue !== null) return refuse(`${issue} · nothing was created`);
  const local = preflightIssue({ checkout: checkout.top, defaultBranch: null });
  if (local !== null) return refuse(local);
  if (!(await serverTakesHandoffs(deps))) return oldServer(deps);
  // The terms answer for a project; before one is adopted the organization says the same store.
  const organization = await deps.api<{ readonly mountDelivery?: string }>("GET", "/organization");
  if (organization.mountDelivery === "bind") return refuse(CO_LOCATED);
  const repository = normalizeRemoteUrl(origin) ?? origin;
  const name = normalizeProjectName(path.basename(origin.replace(/\/+$/u, ""), ".git"));
  const question = `adopt ${repository} as ${name} and hand off?`;
  const plan = confirmPlan(args, io.interactive);
  if (plan === "refuse") {
    return refuse(
      `non-interactive · pass --yes to adopt ${repository} and hand off · nothing was created`,
    );
  }
  if (plan === "ask" && !(await io.ask(question))) {
    say(dim("nothing was adopted or handed off"));
    return null;
  }
  const adopted = await deps.api<ProjectDto>("POST", "/projects", { name, source: origin });
  say(`${green("✓")} adopted · ${adopted.name} · ${dim(adopted.storePath)}`);
  return { project: adopted, adopted: true };
};

const SIGNALS: ReadonlyArray<readonly [NodeJS.Signals, number]> = [
  ["SIGHUP", 129],
  ["SIGINT", 130],
  ["SIGTERM", 143],
];

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

interface Cut {
  readonly snapshot: HandoffSnapshot;
  readonly bundle: Uint8Array<ArrayBuffer>;
}

/**
 * The snapshot and its bundle's bytes. The scratch directory holds a copy of uncommitted work, so
 * it lives only inside this synchronous block. A signal meanwhile is held until the block has
 * removed it, then refuses the handoff.
 */
const cutBundle = async (request: Omit<SnapshotRequest, "scratch">): Promise<Cut> => {
  const caught: { code: number | null } = { code: null };
  const holds = SIGNALS.map(([signal, code]) => {
    const hold = () => {
      caught.code = code;
    };
    process.on(signal, hold);
    return () => process.off(signal, hold);
  });
  let outcome: { readonly cut: Cut } | { readonly refused: string };
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mend-handoff-"));
  try {
    const cut = snapshotCheckout({ ...request, scratch });
    outcome =
      cut._tag === "refused"
        ? { refused: cut.message }
        : {
            cut: {
              snapshot: cut.snapshot,
              bundle: new Uint8Array(fs.readFileSync(cut.snapshot.bundlePath)),
            },
          };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  // The loop's next poll dispatches a signal that arrived during the block. The second of two
  // immediates always runs after one, whatever phase the first is queued in.
  await nextTurn();
  await nextTurn();
  for (const release of holds) release();
  if (caught.code !== null) throw new Refusal("interrupted · nothing was created", caught.code);
  return "refused" in outcome ? refuse(outcome.refused) : outcome.cut;
};

const sendFrom = async (
  deps: HandoffDeps,
  project: ProjectDto,
  checkout: { readonly top: string },
  args: HandoffArgs,
): Promise<void> => {
  const { prompt, harness } = args;
  say(`${green("✓")} project ${project.name} ${dim(`· ${project.defaultBranch} · from origin`)}`);
  const terms = await termsFor(deps, project.id);
  const { snapshot, bundle } = await cutBundle({
    checkout: checkout.top,
    defaultBranch: project.defaultBranch,
    machine: machineName(),
    maxFileBytes: terms.fileBytes,
    cutAt: new Date(),
  });
  for (const line of snapshotLines(snapshot, project.defaultBranch, terms.fileBytes)) say(line);
  if (snapshot.bundleBytes > terms.bundleBytes) {
    return refuse(tooLarge(snapshot.bundleBytes, terms.bundleBytes));
  }
  say(progressLine(snapshot));

  const route = `/projects/${project.id}/handoffs?harness=${encodeURIComponent(harness)}&hold=${prompt === null}`;
  const answer = await send(deps, route, bundle);
  if (answer.status === 413) {
    const body = parseJson(answer.bytes);
    const budget = field(body, "budget");
    const limit = field(body, "limit");
    if (budget === "bodyBytes") return oldServer(deps);
    if (budget === "bundleBytes" && typeof limit === "number") {
      return refuse(tooLarge(snapshot.bundleBytes, limit));
    }
    if (typeof field(body, "_tag") !== "string") {
      return refuse(
        `handoff not sent · something in front of the Mend server refused the ${sizeOf(snapshot.bundleBytes)} bundle (${snapshot.bundleBytes} bytes) with HTTP 413 · its body limit is below the bundle · nothing was created`,
      );
    }
  }
  if (answer.status < 200 || answer.status >= 300) {
    return refusal(deps, `POST /projects/${project.id}/handoffs`, answer);
  }
  const received = receivedOf(parseJson(answer.bytes));
  if (received === null) {
    return refuse(
      "the server's answer to the handoff is in a shape this CLI cannot read · update mend",
    );
  }
  for (const line of receivedLines(received, snapshot, project.defaultBranch)) say(line);
  const sessionId = received.session.id;
  const id8 = sessionId.slice(0, 8);
  const watch = `${dim("  watch")} · ${deps.serverUrl}/sessions/${sessionId}`;
  if (prompt === null) {
    say(heldLine(received.session));
    if (received.session.status === "failed") {
      say(watch);
      // A shell resume is the hold's own first step and needs no harness state.
      return refuse(
        `the hold failed · mend resume ${id8} --with shell opens the workspace with a shell`,
      );
    }
  } else {
    const launched = await deps.launch(sessionId, prompt);
    if (launched._tag !== "running") {
      say(watch);
      // A resume needs the state of a harness that ran; a new session in the worktree needs none.
      return refuse(
        launched._tag === "not-started"
          ? `${launched.words} · the prompt was not sent · mend ${harness} --worktree ${received.worktree.name} starts ${harness} in the handoff`
          : `${launched.words} · the prompt may not have reached an agent · follow it: mend attach ${id8}`,
      );
    }
    say(`${green("✓")} running · ${harness} on your prompt`);
  }
  say(`${dim("  attach")} · mend attach ${id8}`);
  say(watch);
};

const handOff = async (
  deps: HandoffDeps,
  args: ReadonlyArray<string>,
  cwd: string,
  io: HandoffIo,
): Promise<void> => {
  const parsed = parseHandoffArgs(args);
  if ("error" in parsed) return refuse(parsed.error);
  const checkout = checkoutOf(cwd);
  if (checkout === null) {
    return refuse(
      `${cwd} is not inside a git checkout · run mend handoff in one · nothing was created`,
    );
  }
  const scratchIssue = scratchParentIssue(os.tmpdir(), checkout);
  if (scratchIssue !== null) return refuse(scratchIssue);
  const resolved = await projectFor(deps, args, parsed.args.project, checkout, io);
  if (resolved === null) return;
  try {
    await sendFrom(deps, resolved.project, checkout, parsed.args);
  } catch (error) {
    if (!resolved.adopted || !(error instanceof Refusal)) throw error;
    throw new Refusal(
      error.words.replace(
        / · nothing was created$/u,
        ` · nothing was handed off · ${resolved.project.name} stays adopted`,
      ),
      error.code,
    );
  }
};

export const handoffCommand = async (
  deps: HandoffDeps,
  args: ReadonlyArray<string>,
  cwd: string = process.cwd(),
  io: HandoffIo = {
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
    ask: askYesNo,
  },
): Promise<void> => {
  const refused = await handOff(deps, args, cwd, io).then(
    () => null,
    (error: unknown) => {
      if (error instanceof Refusal) return error;
      throw error;
    },
  );
  if (refused === null) return;
  process.stderr.write(`mend: ${redactCredentials(refused.words)}\n`);
  process.exit(refused.code);
};
