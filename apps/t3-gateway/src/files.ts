import {
  type FilesystemEntryMetadata,
  type FilesystemGetMetadataInput,
  type FilesystemGetMetadataResult,
  ProjectListEntriesError,
  ProjectReadFileError,
  ProjectSearchContentsError,
  ProjectSearchEntriesError,
  type ProjectReadFileInput,
  type ProjectReadFileResult,
  type ProjectSearchContentsInput,
  type ProjectSearchContentsResult,
  type ProjectEntry,
  type ProjectListEntriesInput,
  type ProjectListEntriesResult,
  type ProjectSearchEntriesInput,
  type ProjectSearchEntriesResult,
} from "@mend/t3-contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";

import type { AssetSubject } from "./assets.ts";
import type { GatedMend } from "./device-gate.ts";
import { resolveFavicon } from "./favicon.ts";
import { highlightLines } from "./highlight.ts";
import type { CwdLocation, PersonHub } from "./hub.ts";
import type { MendRead } from "./mend-client.ts";
import type { MendFileListing } from "./mend-workbench.ts";
import type { BearerSession } from "./state.ts";

/**
 * A project's files for t3code's composer (ADR 0012, phase 2: `@`-mentions). The composer asks
 * `projects.searchEntries` on every keystroke after `@`, and the file tree `projects.listEntries`;
 * both name the thread's worktree (or the project's root) as `cwd`. The gateway answers from
 * Mend's `GET /api/projects/:id/files`, read as the person, which lists a session's worktree, or
 * the default branch for the project's root.
 *
 * Mend returns sorted pages. The gateway follows their exclusive path cursors and bounds its
 * in-memory index, reporting truncation whenever that bound or a non-advancing source cuts it.
 */

const LISTING_TTL = Duration.seconds(1);

/** The extensions t3code previews as images (`isWorkspaceImagePreviewPath`). */
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "avif",
  "bmp",
  "ico",
]);

const isImagePath = (path: string): boolean =>
  IMAGE_EXTENSIONS.has(path.slice(path.lastIndexOf(".") + 1).toLowerCase());

/** Every file and every directory above one, as t3code's index holds them. */
export const entriesOf = (files: ReadonlyArray<string>): ReadonlyArray<ProjectEntry> => {
  const directories = new Set<string>();
  for (const file of files) {
    const parts = file.split("/");
    for (let depth = 1; depth < parts.length; depth++) {
      directories.add(parts.slice(0, depth).join("/"));
    }
  }
  return [
    ...Array.from(directories, (path): ProjectEntry => ({ path, kind: "directory" })),
    ...files.map((path): ProjectEntry => ({ path, kind: "file" })),
  ].toSorted((left, right) => left.path.localeCompare(right.path));
};

/**
 * How well a path matches what was typed; null when it does not. The name matched from its start
 * ranks first, then the name containing it, then the path containing it, then its letters in order
 * anywhere in the path. Shorter paths win a tie.
 */
export const matchScore = (path: string, query: string): number | null => {
  const needle = query.toLowerCase();
  const haystack = path.toLowerCase();
  const name = haystack.slice(haystack.lastIndexOf("/") + 1);
  if (name.startsWith(needle)) return 0;
  if (name.includes(needle)) return 1;
  if (haystack.includes(needle)) return 2;
  let at = 0;
  for (const char of needle) {
    at = haystack.indexOf(char, at);
    if (at === -1) return null;
    at += 1;
  }
  return 3;
};

/**
 * The entries a search answers, best first, at most `limit`. A search over a listing Mend cut
 * (`sourceTruncated`) is never complete: it says it was cut even when nothing matched, as a file
 * past Mend's cut may match.
 */
export const searchEntries = (
  entries: ReadonlyArray<ProjectEntry>,
  input: Pick<ProjectSearchEntriesInput, "query" | "limit" | "kind" | "imageOnly">,
  sourceTruncated = false,
): ProjectSearchEntriesResult => {
  const query = input.query.trim();
  const candidates = entries.filter(
    (entry) =>
      (input.kind === undefined || entry.kind === input.kind) &&
      (input.imageOnly !== true || (entry.kind === "file" && isImagePath(entry.path))),
  );
  const ranked =
    query.length === 0
      ? // An empty query is a bounded browse: the shallowest first.
        candidates.toSorted(
          (left, right) =>
            left.path.split("/").length - right.path.split("/").length ||
            left.path.localeCompare(right.path),
        )
      : candidates
          .flatMap((entry) => {
            const score = matchScore(entry.path, query);
            return score === null ? [] : [{ entry, score }];
          })
          .toSorted(
            (left, right) =>
              left.score - right.score ||
              left.entry.path.length - right.entry.path.length ||
              left.entry.path.localeCompare(right.entry.path),
          )
          .map((match) => match.entry);
  return {
    entries: ranked.slice(0, input.limit),
    truncated: sourceTruncated || ranked.length > input.limit,
  };
};

/** A directory's own children; `""` is the root. Without one, every entry, as older clients ask. */
export const listEntries = (
  entries: ReadonlyArray<ProjectEntry>,
  directoryPath: string | undefined,
): ReadonlyArray<ProjectEntry> => {
  if (directoryPath === undefined) return entries;
  const prefix = directoryPath.replace(/\/+$/, "");
  return entries.filter((entry) => {
    const slash = entry.path.lastIndexOf("/");
    const parent = slash === -1 ? "" : entry.path.slice(0, slash);
    return parent === prefix;
  });
};

interface Listed {
  readonly listing: MendFileListing;
  readonly entries: ReadonlyArray<ProjectEntry>;
  readonly kinds: ReadonlyMap<string, ProjectEntry["kind"]>;
}

/** One read of a listing, and what it has answered. */
interface Kept {
  readonly read: MendRead<Listed>;
  readonly workspaceMutation: string | null;
  /** The directories it listed: t3code asks for one again only to refresh it. */
  readonly listed: Set<string | null>;
}

export const makeFileHandlers = (input: {
  readonly hub: PersonHub;
  readonly mend: GatedMend;
  readonly session: BearerSession;
}) => {
  const { hub, mend, session } = input;
  const listings = new Map<string, Kept>();
  const readListing = (projectId: string, sessionId: string | null) =>
    Effect.gen(function* () {
      let page = yield* mend.projectFiles(session.deviceToken, projectId, sessionId);
      const files = [...page.files];
      let bytes = files.reduce((size, path) => size + Buffer.byteLength(path), 0);
      let after: string | undefined;
      while (page.truncated && files.length < 100_000 && bytes < 8 * 1024 * 1024) {
        const last = page.files.at(-1);
        if (last === undefined || (after !== undefined && last <= after)) break;
        after = last;
        page = yield* mend.projectFiles(session.deviceToken, projectId, sessionId, after);
        if (page.files.some((path) => path <= last)) return { files, truncated: true };
        files.push(...page.files);
        bytes += page.files.reduce((size, path) => size + Buffer.byteLength(path), 0);
      }
      return { files, truncated: page.truncated };
    });

  /**
   * The files of a project, or of a thread's worktree. A listing is read again after a second,
   * after a command or file change finishes in the worktree, and when the tree asks for a directory
   * it already listed. Lookups made at once share one read, and a failed read is not kept.
   */
  const listingOf = (
    location: {
      readonly projectId: string;
      readonly sessionId: string | null;
      readonly workspaceMutation: string | null;
    },
    directory?: string | null,
  ) =>
    Effect.gen(function* () {
      const key = `${location.projectId}:${location.sessionId ?? ""}`;
      const kept = listings.get(key);
      const current =
        kept !== undefined &&
        kept.workspaceMutation === location.workspaceMutation &&
        (directory === undefined || !kept.listed.has(directory))
          ? kept
          : {
              read: yield* readListing(location.projectId, location.sessionId).pipe(
                Effect.map((listing): Listed => {
                  const entries = entriesOf(listing.files);
                  return {
                    listing,
                    entries,
                    kinds: new Map(entries.map((entry) => [entry.path, entry.kind])),
                  };
                }),
                Effect.cachedWithTTL((exit) =>
                  Exit.isSuccess(exit) ? LISTING_TTL : Duration.zero,
                ),
              ),
              workspaceMutation: location.workspaceMutation,
              listed: new Set<string | null>(),
            };
      listings.set(key, current);
      if (directory !== undefined) current.listed.add(directory);
      return yield* current.read;
    });

  const filesAt = (cwd: string, directory?: string | null) =>
    Effect.gen(function* () {
      const location: CwdLocation | null = yield* hub.locationOf(cwd);
      if (location === null) return null;
      return yield* listingOf(location, directory);
    });

  const searchEntriesAt = (request: ProjectSearchEntriesInput) => {
    const failed = (
      failure: "workspace_root_not_found" | "search_index_search_failed",
      detail: string,
    ) =>
      new ProjectSearchEntriesError({
        cwd: request.cwd,
        queryLength: request.query.length,
        limit: request.limit,
        failure,
        detail,
      });
    return filesAt(request.cwd).pipe(
      Effect.mapError((error) => failed("search_index_search_failed", error.message)),
      Effect.flatMap((kept) =>
        kept === null
          ? Effect.fail(
              failed("workspace_root_not_found", "No Mend thread or project of yours is there."),
            )
          : Effect.succeed(searchEntries(kept.entries, request, kept.listing.truncated)),
      ),
    );
  };

  const listEntriesAt = (request: ProjectListEntriesInput) => {
    const failed = (
      failure: "workspace_root_not_found" | "directory_list_failed",
      detail: string,
    ) => new ProjectListEntriesError({ cwd: request.cwd, failure, detail });
    return filesAt(request.cwd, request.directoryPath ?? null).pipe(
      Effect.mapError((error) => failed("directory_list_failed", error.message)),
      Effect.flatMap((kept) => {
        if (kept === null) {
          return Effect.fail(
            failed("workspace_root_not_found", "No Mend thread or project of yours is there."),
          );
        }
        const result: ProjectListEntriesResult = {
          entries: listEntries(kept.entries, request.directoryPath),
          truncated: kept.listing.truncated,
        };
        return Effect.succeed(result);
      }),
    );
  };

  const readFileAt = (request: ProjectReadFileInput) => {
    const failed = (
      failure: "workspace_path_outside_root" | "path_not_file" | "binary_file" | "operation_failed",
    ) =>
      new ProjectReadFileError({ cwd: request.cwd, relativePath: request.relativePath, failure });
    return Effect.gen(function* () {
      const absolute = request.relativePath.startsWith("/");
      if (
        request.relativePath.includes("\\") ||
        request.relativePath.includes("\0") ||
        request.relativePath
          .split("/")
          .some((part) => part === "." || part === ".." || part === ".git")
      )
        return yield* failed("workspace_path_outside_root");
      const target = absolute
        ? yield* hub
            .worktreeFileOf(request.relativePath)
            .pipe(Effect.mapError(() => failed("operation_failed")))
        : null;
      const location = absolute
        ? target
        : yield* hub
            .locationOf(request.cwd)
            .pipe(Effect.mapError(() => failed("operation_failed")));
      if (location === null) return yield* failed("workspace_path_outside_root");
      const relativePath = target?.relativePath ?? request.relativePath;
      const question = { path: relativePath, at: null };
      const answer = yield* (
        location.worktreeId === null
          ? mend.projectContents(session.deviceToken, location.projectId, question)
          : mend.worktreeContents(session.deviceToken, location.worktreeId, question)
      ).pipe(
        Effect.mapError((error) =>
          error._tag === "MendNotFound"
            ? failed("path_not_file")
            : error._tag === "MendCommandRefused"
              ? failed("workspace_path_outside_root")
              : failed("operation_failed"),
        ),
      );
      const file = answer.file;
      if (file === null) {
        if (request.allowMissing !== true) return yield* failed("path_not_file");
        // An optional file (`t3.json`) that is not there, as t3code's own server answers it.
        const absent: ProjectReadFileResult = {
          relativePath,
          contents: "",
          byteLength: 0,
          truncated: false,
          exists: false,
        };
        return absent;
      }
      if (file.binary || file.contents === null) return yield* failed("binary_file");
      const result: ProjectReadFileResult = {
        relativePath,
        contents: file.contents,
        byteLength: file.size,
        truncated: file.truncated,
      };
      return result;
    });
  };

  const searchContentsAt = (request: ProjectSearchContentsInput) => {
    const failed = (
      detail: string,
      failure: "workspace_root_not_found" | "search_index_search_failed",
    ) =>
      new ProjectSearchContentsError({
        cwd: request.cwd,
        queryLength: request.query.length,
        limit: request.limit,
        failure,
        detail,
      });
    const search = (location: CwdLocation, regex: boolean) => {
      const question = {
        query: request.query,
        caseSensitive: request.caseSensitive,
        wholeWord: request.wholeWord,
        regex,
        limit: Math.min(request.limit, 500),
      };
      return location.worktreeId === null
        ? mend.projectContents(session.deviceToken, location.projectId, question)
        : mend.worktreeContents(session.deviceToken, location.worktreeId, question);
    };
    return Effect.gen(function* () {
      const location = yield* hub
        .locationOf(request.cwd)
        .pipe(Effect.mapError((error) => failed(error.message, "search_index_search_failed")));
      if (location === null) {
        return yield* failed(
          "No Mend thread or project of yours is there.",
          "workspace_root_not_found",
        );
      }
      // A regex git cannot read is searched as text, and the client is told so, as t3code does.
      const first = yield* search(location, request.useRegex).pipe(Effect.result);
      const fellBack =
        request.useRegex && first._tag === "Failure" && first.failure._tag === "MendCommandRefused"
          ? first.failure.message
          : null;
      const answer =
        fellBack === null
          ? first._tag === "Success"
            ? first.success
            : yield* Effect.fail(failed(first.failure.message, "search_index_search_failed"))
          : yield* search(location, false).pipe(
              Effect.mapError((error) => failed(error.message, "search_index_search_failed")),
            );
      const lines = answer.search ?? { matches: [], truncated: false };
      const asTyped = { ...request, useRegex: request.useRegex && fellBack === null };
      const kept = lines.matches.filter((match) => match.line >= 1);
      // Never the client's regex on the gateway's thread (`highlight.ts`).
      const ranges = yield* highlightLines(
        kept.map((match) => match.text),
        asTyped,
      );
      const result: ProjectSearchContentsResult = {
        matches: kept.map((match, index) => ({
          path: match.path,
          lineNumber: match.line,
          lineContent: match.text,
          matchRanges: ranges[index] ?? [],
        })),
        truncated: lines.truncated,
        ...(fellBack === null ? {} : { regexFallbackError: fellBack }),
      };
      return result;
    });
  };

  const metadataOf = (path: string) =>
    Effect.gen(function* () {
      const file = yield* hub.worktreeFileOf(path);
      if (file === null) return null;
      if (file.relativePath === "") return { kind: "directory" } as const;
      const kept = yield* listingOf(file);
      const kind = kept.kinds.get(file.relativePath);
      if (kind === "directory") return { kind } as const;
      if (kind === undefined && !kept.listing.truncated) return null;
      const answer = yield* mend.worktreeContents(session.deviceToken, file.worktreeId, {
        path: file.relativePath,
        at: null,
      });
      return answer.file === null ? null : { kind: "file" as const, byteLength: answer.file.size };
    }).pipe(Effect.catch(() => Effect.succeed<FilesystemEntryMetadata | null>(null)));

  const getMetadata = (request: FilesystemGetMetadataInput) =>
    Effect.gen(function* () {
      const paths = [...new Set(request.paths)];
      const entries = yield* Effect.forEach(paths, metadataOf, { concurrency: 8 });
      const byPath = new Map(paths.map((path, index) => [path, entries[index] ?? null]));
      const result: FilesystemGetMetadataResult = {
        entries: request.paths.map((path) => byPath.get(path) ?? null),
      };
      return result;
    });

  const assetFile = (path: string, threadId: string | undefined, preview: "workspace" | "media") =>
    Effect.gen(function* () {
      const file = yield* hub.worktreeFileOf(path, threadId);
      if (file !== null)
        return {
          kind: "file",
          worktreeId: file.worktreeId,
          path: Redacted.make(file.relativePath),
          preview,
        } satisfies AssetSubject;
      for (let at = path.lastIndexOf("/"); at > 0; at = path.lastIndexOf("/", at - 1)) {
        const location = yield* hub.locationOf(path.slice(0, at));
        if (location === null || location.worktreeId !== null) continue;
        return {
          kind: "project-file",
          projectId: location.projectId,
          path: Redacted.make(path.slice(at + 1)),
          preview,
        } satisfies AssetSubject;
      }
      return null;
    });

  const favicon = (cwd: string) =>
    Effect.gen(function* () {
      const listed = yield* filesAt(cwd);
      if (listed === null) return null;
      return yield* resolveFavicon(listed.listing.files, (relativePath) =>
        readFileAt({ cwd, relativePath, allowMissing: true }).pipe(
          Effect.map((file) => (file.exists === false ? null : file.contents)),
          Effect.catch(() => Effect.succeed(null)),
        ),
      );
    });

  return {
    favicon,
    assetFile,
    getMetadata,
    searchEntries: searchEntriesAt,
    listEntries: listEntriesAt,
    readFile: readFileAt,
    searchContents: searchContentsAt,
  };
};
