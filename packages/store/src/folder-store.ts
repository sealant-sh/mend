import * as fs from "node:fs";
import * as path from "node:path";

import {
  FOLDER_MAX_FILE_BYTES,
  FOLDER_MAX_REQUEST_BYTES,
  FolderFile,
} from "@mend/domain/workbench";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { StoreConfig } from "./store.ts";

/** A folder operation refused or failed; the message says which rule or what happened. */
export class FolderStoreError extends Schema.TaggedErrorClass<FolderStoreError>()(
  "FolderStoreError",
  { message: Schema.String },
) {}

export interface FolderUpload {
  /** Folder-relative, forward slashes, no `.` or `..` segments. */
  readonly path: string;
  readonly contentsBase64: string;
}

export interface FolderListing {
  readonly files: ReadonlyArray<FolderFile>;
  readonly truncated: boolean;
}

/** Where an organization's folder lives, relative to the store root. */
export const folderDirectory = (organizationId: string, folderId: string): string =>
  path.join("_organizations", organizationId, "folders", folderId);

/** A folder-relative path the store accepts: relative, normalized, no escapes. */
export const isSafeFolderPath = (value: string): boolean =>
  value.length > 0 &&
  !value.startsWith("/") &&
  !value.includes("\\") &&
  !value.includes("\0") &&
  !value.split("/").some((segment) => segment === ".." || segment === "" || segment === ".");

/**
 * The organization folders on disk (docs/adr/0003-organizations-and-tenancy.md). Plain directories
 * under the store root, written only through this service: every path is checked to stay inside
 * its folder, symlinks are neither followed nor created, and uploads are capped per file and per
 * request.
 */
export class FolderStore extends Context.Service<
  FolderStore,
  {
    /** Create the directory; answers its absolute path. */
    readonly create: (directory: string) => Effect.Effect<string, FolderStoreError>;
    /** Write files; `merge: false` empties the folder first. */
    readonly write: (
      directory: string,
      files: ReadonlyArray<FolderUpload>,
      options: { readonly merge: boolean },
    ) => Effect.Effect<void, FolderStoreError>;
    readonly deleteFile: (
      directory: string,
      filePath: string,
    ) => Effect.Effect<void, FolderStoreError>;
    readonly list: (
      directory: string,
      limit: number,
    ) => Effect.Effect<FolderListing, FolderStoreError>;
    readonly remove: (directory: string) => Effect.Effect<void>;
  }
>()("@mend/store/FolderStore") {}

const failure = (message: string) => new FolderStoreError({ message });

export const FolderStoreLive: Layer.Layer<FolderStore, never, StoreConfig> = Layer.effect(
  FolderStore,
  Effect.gen(function* () {
    const config = yield* StoreConfig;

    const rootOf = (directory: string) => path.join(config.root, directory);

    /** The absolute target of `filePath` inside `root`, refusing anything that would escape it. */
    const targetOf = (root: string, filePath: string) =>
      Effect.gen(function* () {
        if (!isSafeFolderPath(filePath)) {
          return yield* failure(`not a folder-relative path: ${filePath}`);
        }
        const target = path.join(root, filePath);
        // Every existing ancestor must be a real directory, never a symlink out of the folder.
        let current = root;
        for (const segment of path.relative(root, path.dirname(target)).split(path.sep)) {
          if (segment === "") continue;
          current = path.join(current, segment);
          const stat = fs.lstatSync(current, { throwIfNoEntry: false });
          if (stat === undefined) break;
          if (!stat.isDirectory() || stat.isSymbolicLink()) {
            return yield* failure(`${filePath} passes through something that is not a directory`);
          }
        }
        const existing = fs.lstatSync(target, { throwIfNoEntry: false });
        if (existing !== undefined && !existing.isFile()) {
          return yield* failure(`${filePath} exists and is not a regular file`);
        }
        return target;
      });

    const create = Effect.fn("FolderStore.create")(function* (directory: string) {
      const root = rootOf(directory);
      yield* Effect.try({
        try: () => fs.mkdirSync(root, { recursive: true }),
        catch: (cause) => failure(`could not create the folder: ${String(cause)}`),
      });
      return root;
    });

    const write = Effect.fn("FolderStore.write")(function* (
      directory: string,
      files: ReadonlyArray<FolderUpload>,
      options: { readonly merge: boolean },
    ) {
      const root = yield* create(directory);
      const decoded = files.map((file) => ({
        path: file.path,
        contents: Buffer.from(file.contentsBase64, "base64"),
      }));
      const oversized = decoded.find((file) => file.contents.byteLength > FOLDER_MAX_FILE_BYTES);
      if (oversized !== undefined) {
        return yield* failure(`${oversized.path} is over 1 MiB`);
      }
      const total = decoded.reduce((sum, file) => sum + file.contents.byteLength, 0);
      if (total > FOLDER_MAX_REQUEST_BYTES) {
        return yield* failure("an upload is capped at 4 MiB; send the files in smaller batches");
      }
      // Validate every path before touching the disk, so a refused upload writes nothing.
      for (const file of decoded) {
        if (!isSafeFolderPath(file.path)) {
          return yield* failure(`not a folder-relative path: ${file.path}`);
        }
      }
      if (!options.merge) {
        yield* Effect.sync(() => {
          for (const entry of fs.readdirSync(root)) {
            fs.rmSync(path.join(root, entry), { recursive: true, force: true });
          }
        });
      }
      for (const file of decoded) {
        const target = yield* targetOf(root, file.path);
        yield* Effect.try({
          try: () => {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, file.contents);
          },
          catch: (cause) => failure(`could not write ${file.path}: ${String(cause)}`),
        });
      }
    });

    const deleteFile = Effect.fn("FolderStore.deleteFile")(function* (
      directory: string,
      filePath: string,
    ) {
      const target = yield* targetOf(rootOf(directory), filePath);
      yield* Effect.sync(() => fs.rmSync(target, { force: true }));
    });

    const list = Effect.fn("FolderStore.list")(function* (directory: string, limit: number) {
      const root = rootOf(directory);
      return yield* Effect.sync((): FolderListing => {
        const files: Array<FolderFile> = [];
        let truncated = false;
        const walk = (relative: string): void => {
          const entries = fs.readdirSync(path.join(root, relative), { withFileTypes: true });
          for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
            if (truncated) return;
            const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
            if (entry.isDirectory()) walk(child);
            else if (entry.isFile()) {
              if (files.length >= limit) {
                truncated = true;
                return;
              }
              files.push(
                new FolderFile({ path: child, bytes: fs.statSync(path.join(root, child)).size }),
              );
            }
          }
        };
        if (fs.existsSync(root)) walk("");
        return { files, truncated };
      });
    });

    const remove = Effect.fn("FolderStore.remove")(function* (directory: string) {
      yield* Effect.sync(() => fs.rmSync(rootOf(directory), { recursive: true, force: true }));
    });

    return { create, write, deleteFile, list, remove };
  }),
);
