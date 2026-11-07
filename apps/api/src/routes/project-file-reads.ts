import { ProjectContents, WorktreeFile, WorktreeMatch, StoreFailure } from "@mend/api-contracts";
import type { ProjectId } from "@mend/domain";
import { WorktreeReads } from "@mend/sessions";
import { isWorktreeRelativePath, Store } from "@mend/store";
import { Effect } from "effect";

import { ProjectAccess } from "../access.ts";
import { rawFileResponse } from "./raw-file-response.ts";

interface ContentsQuery {
  readonly path?: string | undefined;
  readonly query?: string | undefined;
  readonly caseSensitive?: string | undefined;
  readonly wholeWord?: string | undefined;
  readonly regex?: string | undefined;
  readonly limit?: string | undefined;
}

/** Read/search the adopted default branch after checking the person's project visibility. */
export const projectContents = (id: ProjectId, query: ContentsQuery) =>
  Effect.gen(function* () {
    const project = yield* (yield* ProjectAccess).project(id);
    if ((query.path === undefined) === (query.query === undefined))
      return yield* new StoreFailure({ message: "Name either a path or a search query." });
    if (query.path !== undefined) {
      if (!isWorktreeRelativePath(query.path))
        return yield* new StoreFailure({
          message: "A path must stay within the project and outside .git.",
        });
      const read = yield* (yield* WorktreeReads)
        .readDefaultBranchFile(project.id, query.path, 1024 * 1024)
        .pipe(
          Effect.mapError(
            () => new StoreFailure({ message: "The default branch could not be read." }),
          ),
        );
      const file = read.value;
      return new ProjectContents({
        projectId: id,
        file:
          file === null
            ? null
            : new WorktreeFile({
                path: query.path,
                at: null,
                size: file.size,
                truncated: file.truncated,
                binary: file.binary,
                contents: file.binary ? null : new TextDecoder().decode(file.bytes),
              }),
        search: null,
      });
    }
    const pattern = query.query ?? "";
    const limit = query.limit === undefined ? 100 : Number(query.limit);
    if (
      pattern.length < 1 ||
      pattern.length > 256 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 500 ||
      (query.limit !== undefined && String(limit) !== query.limit)
    )
      return yield* new StoreFailure({
        message: "A search needs 1 to 256 characters and a limit from 1 to 500.",
      });
    const store = yield* Store;
    const branches = yield* store
      .listBranches(project.storePath)
      .pipe(
        Effect.mapError(
          () => new StoreFailure({ message: "The default branch could not be read." }),
        ),
      );
    const branch = branches.find((row) => row.name === project.defaultBranch);
    if (branch === undefined)
      return yield* new StoreFailure({ message: "The default branch is unavailable." });
    const found = yield* store
      .grep(
        project.storePath,
        branch.sha,
        {
          pattern,
          caseSensitive: query.caseSensitive === "true",
          wholeWord: query.wholeWord === "true",
          regex: query.regex === "true",
        },
        limit,
      )
      .pipe(
        Effect.mapError(
          () =>
            new StoreFailure({
              message: "The default branch search failed. Check the search expression.",
            }),
        ),
      );
    return new ProjectContents({
      projectId: id,
      file: null,
      search: {
        matches: found.matches.map((match) => new WorktreeMatch(match)),
        truncated: found.truncated,
      },
    });
  });

/** Default-branch bytes use the same raw cache and HTTP behavior as worktree bytes. */
export const projectRawFile = (
  id: ProjectId,
  query: { readonly path: string; readonly within?: string | undefined },
) =>
  Effect.gen(function* () {
    const project = yield* (yield* ProjectAccess).project(id);
    return yield* rawFileResponse(
      (yield* WorktreeReads).openDefaultBranchRawFile(project.id, {
        path: query.path,
        within: query.within ?? "",
      }),
    );
  });
