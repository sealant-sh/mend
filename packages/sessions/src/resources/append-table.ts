import * as fs from "node:fs/promises";
import path from "node:path";

import { SessionsRepo, WorktreesRepo } from "@mend/db";
import type { ProjectId, WorktreeId } from "@mend/domain";
import { asSealantUser, SealantClient } from "@mend/sealant";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";
import { parse as parseToml } from "smol-toml";

import {
  LEGACY_MEND_TOML,
  MEND_TOML,
  readWorktreeFile,
  selectMendToml,
  tomlDiagnostic,
} from "../recipes.ts";
import { SessionRepository } from "../session-repository.ts";
import { resourceWorkspace } from "./workspace.ts";

/** The selected repository file, using the same precedence as the readers. */
export type ResourceTablePath = typeof MEND_TOML | typeof LEGACY_MEND_TOML;

/** No settings, index or commit is changed by this request. */
export interface AppendResourceTableInput {
  readonly projectId: ProjectId;
  readonly worktreeId: WorktreeId;
  readonly name: string;
  readonly table: string;
}

/** A refused write preserves the file and lets the caller explain or offer the table to copy. */
export type AppendResourceTableResult =
  | { readonly kind: "written"; readonly path: ResourceTablePath }
  | { readonly kind: "declared"; readonly path: ResourceTablePath }
  | { readonly kind: "unreachable"; readonly reason: string; readonly table: string }
  | { readonly kind: "unparsed"; readonly path: ResourceTablePath; readonly message: string };

/** Append a declaration at the worktree's writable authority, never a captured snapshot. */
export class ResourceTableWrites extends Context.Service<
  ResourceTableWrites,
  {
    /** Existing tables and invalid TOML are refused without changing any bytes. */
    readonly appendResourceTable: (
      input: AppendResourceTableInput,
    ) => Effect.Effect<AppendResourceTableResult>;
  }
>()("@mend/sessions/resources/ResourceTableWrites") {}

class ResourceTableWriteError extends Schema.TaggedError<ResourceTableWriteError>()(
  "ResourceTableWriteError",
  { message: Schema.String },
) {}
const io = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: () => new ResourceTableWriteError({ message: "The worktree file could not be written" }),
  });
const unreachable = (table: string, reason: string): AppendResourceTableResult => ({
  kind: "unreachable",
  reason,
  table,
});
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const refusal = (
  text: string,
  file: ResourceTablePath,
  name: string,
): AppendResourceTableResult | null => {
  let parsed: unknown;
  try {
    parsed = parseToml(text);
  } catch (cause) {
    return { kind: "unparsed", path: file, message: tomlDiagnostic(cause, file) };
  }
  const resources = isRecord(parsed) ? parsed["resource"] : undefined;
  if (resources !== undefined && !isRecord(resources))
    return { kind: "unparsed", path: file, message: `${file}: resource is not a table` };
  return isRecord(resources) && Object.hasOwn(resources, name)
    ? { kind: "declared", path: file }
    : null;
};
const suffix = (text: string): string =>
  text.length === 0 || text.endsWith("\n\n") || text.endsWith("\r\n\r\n")
    ? ""
    : text.endsWith("\n")
      ? "\n"
      : "\n\n";
const inside = (root: string, target: string): boolean =>
  target === root || target.startsWith(`${root}${path.sep}`);
const exists = async (target: string): Promise<boolean> => {
  try {
    await fs.lstat(target);
    return true;
  } catch (cause) {
    if (isRecord(cause) && (cause["code"] === "ENOENT" || cause["code"] === "ENOTDIR"))
      return false;
    throw cause;
  }
};

const appendLocal = Effect.fn("ResourceTableWrites.appendLocal")(function* (
  rootPath: string,
  input: AppendResourceTableInput,
) {
  const root = yield* io(() => fs.realpath(rootPath));
  const preferred = yield* io(() => exists(path.join(root, MEND_TOML)));
  const legacy = !preferred && (yield* io(() => exists(path.join(root, LEGACY_MEND_TOML))));
  const selected = selectMendToml(preferred ? true : null, legacy ? true : null);
  const file = selected?.path === LEGACY_MEND_TOML ? LEGACY_MEND_TOML : MEND_TOML;
  const bytes = yield* readWorktreeFile(root, file);
  if ((preferred || legacy) && bytes === null)
    return unreachable(input.table, `${file} could not be read`);
  let text: string;
  try {
    text = bytes === null ? "" : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return {
      kind: "unparsed",
      path: file,
      message: `${file} is not UTF-8 text`,
    } satisfies AppendResourceTableResult;
  }
  const refused = refusal(text, file, input.name);
  if (refused !== null) return refused;
  yield* io(async () => {
    const directory = path.dirname(path.join(root, file));
    if (await exists(directory)) {
      if (!inside(root, await fs.realpath(directory)))
        throw new Error("Directory leaves the worktree");
    } else {
      await fs.mkdir(directory);
    }
    const target =
      bytes === null
        ? path.join(await fs.realpath(directory), path.basename(file))
        : await fs.realpath(path.join(root, file));
    if (!inside(root, target)) throw new Error("File leaves the worktree");
    const parent = path.dirname(target);
    const temporary = path.join(parent, `.mend-resource-${crypto.randomUUID()}.tmp`);
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      if (!inside(root, await fs.realpath(temporary)))
        throw new Error("Temporary file leaves the worktree");
      if (bytes !== null) {
        await handle.chmod((await fs.stat(target)).mode & 0o777);
        await handle.writeFile(bytes);
      }
      await handle.writeFile(
        `${suffix(text)}${input.table.endsWith("\n") ? input.table.slice(0, -1) : input.table}\n`,
      );
      await handle.sync();
      await handle.close();
      if (!inside(root, await fs.realpath(parent)))
        throw new Error("Directory leaves the worktree");
      await fs.rename(temporary, target);
    } finally {
      await handle.close();
      await fs.unlink(temporary).catch((cause: unknown) => {
        if (!isRecord(cause) || cause["code"] !== "ENOENT") throw cause;
      });
    }
  });
  return { kind: "written", path: file } satisfies AppendResourceTableResult;
});

/**
 * Read or append inside a live workspace. Arguments: root, read|write|observe, selected path, expected
 * base64 bytes, appended base64 bytes. A write checks precedence and the bytes read by the server.
 * Observe takes a byte limit in place of the path and returns base64, or exit 44 when absent.
 * All replacement files are created beside their destination and renamed atomically. It needs only
 * coreutils: workspace images carry no `cmp`. A new file belongs to the worktree's owner, mode 644,
 * so the person's processes can read it.
 */
export const WORKSPACE_RESOURCE_TABLE_SCRIPT = `set -eu
root=$(cd -P "$1" && pwd -P)
file=${MEND_TOML}
for candidate in ${MEND_TOML} ${LEGACY_MEND_TOML}; do
  if [ -e "$root/$candidate" ] || [ -L "$root/$candidate" ]; then file=$candidate; break; fi
done
check_inside() { case "$1" in "$root"|"$root"/*) ;; *) exit 45 ;; esac; }
if [ "$file" = .mend/mend.toml ] && { [ -e "$root/.mend" ] || [ -L "$root/.mend" ]; }; then check_inside "$(realpath "$root/.mend")"; fi
target="$root/$file"
if [ -e "$target" ] || [ -L "$target" ]; then
  target=$(realpath "$target")
  check_inside "$target"
  [ -f "$target" ] || exit 45
fi
if [ "$2" = read ] || [ "$2" = observe ]; then
  printf '%s\\n' "$file"
  if [ -e "$target" ]; then
    [ -r "$target" ] || exit 45
    if [ "$2" = observe ]; then head -c "$3" -- "$target" | base64; else cat -- "$target"; fi
  elif [ "$2" = observe ]; then exit 44; fi
  exit 0
fi
[ "$file" = "$3" ] || exit 46
made_dir=
[ -e "$(dirname "$target")" ] || made_dir=1
mkdir -p -- "$(dirname "$target")"
parent=$(cd -P "$(dirname "$target")" && pwd -P)
check_inside "$parent"
tmp=$(mktemp "$parent/.mend-resource.XXXXXX")
trap 'rm -f -- "$tmp"' EXIT HUP INT TERM
if [ -e "$target" ]; then
  [ "$(base64 < "$target" | tr -d '\n')" = "$4" ] || exit 46
  cp -p -- "$target" "$tmp"
else
  [ -z "$4" ] || exit 46
  chmod 644 "$tmp"
  chown --reference="$root" "$tmp" 2>/dev/null || true
fi
[ -z "$made_dir" ] || chown --reference="$root" "$parent" 2>/dev/null || true
printf '%s' "$5" | base64 -d >> "$tmp"
check_inside "$(cd -P "$(dirname "$target")" && pwd -P)"
mv -f -- "$tmp" "$target"
`;

const make: Effect.Effect<
  ResourceTableWrites["Service"],
  never,
  SessionRepository | WorktreesRepo | SessionsRepo | SealantClient
> = Effect.gen(function* () {
  const repository = yield* SessionRepository;
  const worktrees = yield* WorktreesRepo;
  const sealant = yield* SealantClient;

  const liveWorkspace = yield* resourceWorkspace;

  const appendResourceTable = Effect.fn("ResourceTableWrites.appendResourceTable")(
    function* (input: AppendResourceTableInput) {
      const worktree = yield* worktrees.byId(input.worktreeId);
      if (worktree.projectId !== input.projectId)
        return unreachable(input.table, "The worktree does not belong to this project");
      const mount = yield* repository.worktreeMount(input.projectId, worktree.directory);
      if (mount !== undefined) return yield* appendLocal(mount, input);
      const live = yield* liveWorkspace(input.worktreeId);
      if (live === null)
        return unreachable(input.table, "The worktree has no co-located files or live workspace");
      const exec = (args: ReadonlyArray<string>) =>
        sealant
          .exec(live.workspace, [
            "sh",
            "-c",
            WORKSPACE_RESOURCE_TABLE_SCRIPT,
            "sh",
            "/workspace/repo",
            ...args,
          ])
          .pipe(asSealantUser(live.owner));
      const read = yield* exec(["read"]);
      if (read.exitCode !== 0)
        return unreachable(input.table, "The worktree file could not be read in its workspace");
      const newline = read.stdout.indexOf("\n");
      const name = read.stdout.slice(0, newline);
      if (name !== MEND_TOML && name !== LEGACY_MEND_TOML)
        return unreachable(input.table, "The workspace returned no repository file path");
      const text = read.stdout.slice(newline + 1);
      const refused = refusal(text, name, input.name);
      if (refused !== null) return refused;
      const write = yield* exec([
        "write",
        name,
        Buffer.from(text).toString("base64"),
        Buffer.from(
          `${suffix(text)}${input.table.endsWith("\n") ? input.table.slice(0, -1) : input.table}\n`,
        ).toString("base64"),
      ]);
      return write.exitCode === 0
        ? ({ kind: "written", path: name } satisfies AppendResourceTableResult)
        : unreachable(
            input.table,
            "The worktree file changed or could not be written in its workspace",
          );
    },
    (effect, input) =>
      effect.pipe(
        Effect.catch(() =>
          Effect.succeed(
            unreachable(input.table, "The worktree file could not be reached or written"),
          ),
        ),
      ),
  );
  return ResourceTableWrites.of({ appendResourceTable });
});

/** Uses the store mount when available, otherwise execs as the live workspace's owner. */
export const ResourceTableWritesLive: Layer.Layer<
  ResourceTableWrites,
  never,
  SessionRepository | WorktreesRepo | SessionsRepo | SealantClient
> = Layer.effect(ResourceTableWrites, make);
