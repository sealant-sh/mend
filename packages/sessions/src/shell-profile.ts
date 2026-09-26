/**
 * The default shell profile (docs: guides/dotfiles, "Default shell profile"): a zsh setup for
 * people who bring no dotfiles of their own — history, completion, fzf, direnv, the
 * autosuggestions / syntax-highlighting / history-substring-search plugins and a starship prompt.
 * The files are real files beside this module (`shell-profile/`), read as they are; the API bundle
 * ships them next to `dist/main.js` (`apps/api` build, `BUNDLE_ASSETS`), where the same relative
 * URL finds them.
 *
 * Mend writes them at launch only into a managed-family image whose shell is zsh, only when the
 * project leaves `defaultShellProfile` on, and only where nothing exists yet: dotfiles applied at
 * boot always win.
 */

import * as fs from "node:fs";

import type { WorkspaceImage } from "@mend/domain";
import { Effect, Schema } from "effect";

import type { WorkspaceFile } from "./workspace-files.ts";

/** Each profile file: where it lands under `$HOME`, and its asset name in `shell-profile/`. */
export const SHELL_PROFILE_FILES: ReadonlyArray<{ readonly home: string; readonly asset: string }> =
  [
    { home: ".zshrc", asset: "zshrc" },
    { home: ".config/starship.toml", asset: "starship.toml" },
  ];

export class ShellProfileAssetError extends Schema.TaggedErrorClass<ShellProfileAssetError>()(
  "ShellProfileAssetError",
  { asset: Schema.String, message: Schema.String },
) {}

/** The profile's files, `path` relative to `$HOME`, read from the assets beside this module. */
export const loadShellProfile: Effect.Effect<
  ReadonlyArray<WorkspaceFile>,
  ShellProfileAssetError
> = Effect.forEach(SHELL_PROFILE_FILES, (file) =>
  Effect.try({
    try: (): WorkspaceFile => ({
      path: file.home,
      bytes: new Uint8Array(
        fs.readFileSync(new URL(`./shell-profile/${file.asset}`, import.meta.url)),
      ),
    }),
    catch: (cause) =>
      new ShellProfileAssetError({
        asset: file.asset,
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  }),
);

/**
 * Whether a launch writes the profile: the project leaves it on and the image is a managed family
 * whose login shell is zsh. A custom base promises only a POSIX shell, so it never gets one.
 */
export const shellProfileApplies = (
  project: { readonly defaultShellProfile: boolean },
  image: WorkspaceImage,
): boolean => project.defaultShellProfile && image.mode === "family" && image.shell === "zsh";
