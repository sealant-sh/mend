import type { ServerProviderSkill } from "@mend/t3-contracts";
import { Effect } from "effect";
import { parse } from "yaml";

import type { MendClient, MendDeviceRefused, MendUnavailable } from "./mend-client.ts";

/** Native repository skill catalogs, keyed by the harness that discovers each directory. */
export interface RepositorySkills {
  readonly claude: ReadonlyArray<ServerProviderSkill>;
  readonly codex: ReadonlyArray<ServerProviderSkill>;
}

const EMPTY: RepositorySkills = { claude: [], codex: [] };
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseSkillBoolean = (value: unknown): boolean | undefined => {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === 0) return value === 1;
  if (typeof value !== "string") return undefined;
  if (["true", "yes", "on", "y"].includes(value.trim().toLowerCase())) return true;
  if (["false", "no", "off", "n"].includes(value.trim().toLowerCase())) return false;
  return undefined;
};

const parseSkillMetadata = (contents: string): Readonly<Record<string, unknown>> | null => {
  const frontmatter = FRONTMATTER.exec(contents)?.[1];
  if (frontmatter === undefined) return contents.startsWith("---") ? null : {};
  try {
    const value: unknown = parse(frontmatter, { maxAliasCount: 16 });
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
};

const parseSkillCandidate = (path: string) => {
  const match = /^(\.claude|\.agents)\/skills\/([a-zA-Z0-9][a-zA-Z0-9_-]*)\/SKILL\.md$/.exec(path);
  const folder = match?.[2];
  if (folder === undefined) return null;
  return { path, folder, harness: match?.[1] === ".claude" ? "claude" : "codex" };
};

/** Discover skill entry files through Mend's visibility-checked API, never arbitrary host files. */
export const readRepositorySkills = Effect.fn("readRepositorySkills")(function* (
  mend: Pick<MendClient["Service"], "projectFiles" | "worktreeContents">,
  deviceToken: string,
  location: {
    readonly projectId: string;
    readonly sessionId: string | null;
    readonly worktreeId: string | null;
  },
  cwd: string,
): Effect.fn.Return<RepositorySkills, MendDeviceRefused | MendUnavailable> {
  const worktreeId = location.worktreeId;
  if (worktreeId === null) return EMPTY;
  const listing = yield* mend
    .projectFiles(deviceToken, location.projectId, location.sessionId)
    .pipe(Effect.catchTag("MendNotFound", () => Effect.succeed({ files: [], truncated: false })));
  const candidates = listing.files
    .flatMap((path) => {
      const candidate = parseSkillCandidate(path);
      return candidate === null ? [] : [candidate];
    })
    .toSorted((left, right) => left.path.localeCompare(right.path))
    .slice(0, 200);
  const found = yield* Effect.forEach(
    candidates,
    (candidate) =>
      Effect.gen(function* () {
        const { file } = yield* mend
          .worktreeContents(deviceToken, worktreeId, { path: candidate.path, at: null })
          .pipe(
            Effect.catchTags({
              MendNotFound: () => Effect.succeed({ file: null }),
              MendCommandRefused: () => Effect.succeed({ file: null }),
            }),
          );
        if (
          file === null ||
          file.binary ||
          file.truncated ||
          file.contents === null ||
          file.size > 64 * 1024
        )
          return null;
        const metadata = parseSkillMetadata(file.contents);
        if (metadata === null) return null;
        const declared = metadata["name"];
        const name =
          candidate.harness === "claude"
            ? candidate.folder
            : typeof declared === "string"
              ? declared.trim()
              : "";
        if (
          name.length > 64 ||
          !/^[a-zA-Z0-9][a-zA-Z0-9:_-]*$/.test(name) ||
          !/[a-zA-Z]/.test(name)
        )
          return null;
        const description =
          typeof metadata["description"] === "string"
            ? metadata["description"].trim().slice(0, 1024)
            : "";
        const skill: ServerProviderSkill = {
          name,
          ...(description.length === 0 ? {} : { description }),
          path: `${cwd}/${candidate.path}`,
          scope: "project",
          enabled: true,
          ...(parseSkillBoolean(metadata["disable-model-invocation"]) === true
            ? { userInvocationOnly: true }
            : {}),
          ...(parseSkillBoolean(metadata["user-invocable"]) === false
            ? { userInvocable: false }
            : {}),
        };
        return { harness: candidate.harness, skill };
      }),
    { concurrency: 8 },
  );
  return {
    claude: found.flatMap((entry) => (entry?.harness === "claude" ? [entry.skill] : [])),
    codex: found.flatMap((entry) => (entry?.harness === "codex" ? [entry.skill] : [])),
  } satisfies RepositorySkills;
});
