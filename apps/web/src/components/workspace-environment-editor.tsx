import { useReducer, useState, type ReactNode } from "react";

import type {
  HostEnvironmentSuggestionsDto,
  SettingsDto,
  WorkspacePackageResolutionDto,
} from "#/lib/api";
import { orLogin, trpcClient } from "#/lib/trpc";
import {
  createWorkspaceEnvironmentForm,
  OS_LABELS,
  parsePackageDraft,
  resolutionIssue,
  workspaceEnvironmentFormReducer,
  workspaceImageFromForm,
  workspaceImagesEqual,
} from "#/lib/workspace-environment";

type WorkspaceImage = SettingsDto["workspaceImage"];

const OS_OPTIONS: ReadonlyArray<{
  readonly value: Extract<WorkspaceImage, { mode: "family" }>["os"];
  readonly label: string;
  readonly detail: string;
}> = [
  { value: "arch", label: "Arch", detail: "Rolling packages; Mend’s default." },
  { value: "fedora", label: "Fedora", detail: "Fedora 41 packages." },
  { value: "ubuntu", label: "Ubuntu", detail: "Ubuntu 24.04 LTS packages." },
  { value: "nix", label: "Nix", detail: "Tools resolved from nixpkgs." },
];

/** What a save answered: the image as saved, or null when a package did not resolve. */
export interface WorkspaceEnvironmentSaved {
  readonly saved: WorkspaceImage | null;
  readonly resolutions: ReadonlyArray<WorkspacePackageResolutionDto>;
}

/**
 * The workspace environment form: base, login shell, Docker, packages, and Save. The instance's
 * and an organization's Settings panels both edit with it; each supplies its own save.
 */
export function WorkspaceEnvironmentEditor({
  savedImage,
  onSave,
  allowScan,
  secondaryAction,
}: {
  readonly savedImage: WorkspaceImage;
  /** Resolve and save one complete draft; nothing is saved when a package does not resolve. */
  readonly onSave: (image: WorkspaceImage) => Promise<WorkspaceEnvironmentSaved>;
  /** The machine scan reads the host Mend runs on, so it is the operator's alone. */
  readonly allowScan: boolean;
  /** A quieter action beside Save, such as an organization's "Follow the instance". */
  readonly secondaryAction?: ReactNode;
}) {
  const [form, dispatch] = useReducer(
    workspaceEnvironmentFormReducer,
    savedImage,
    createWorkspaceEnvironmentForm,
  );
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<HostEnvironmentSuggestionsDto | null>(null);

  const pending = form.phase === "saving";
  const parsedDraft = parsePackageDraft(form.packageDraft);
  const candidate = workspaceImageFromForm(form);
  const dirty = !workspaceImagesEqual(form.savedImage, candidate);
  const rejectedResolutions = (form.resolutions ?? []).flatMap((resolution) => {
    const issue = resolutionIssue(resolution, form.os);
    return issue === null ? [] : [{ resolution, issue }];
  });

  const persist = async () => {
    dispatch({ type: "save-started" });
    try {
      const result = await onSave(candidate);
      if (result.saved === null) {
        dispatch({ type: "save-rejected", resolutions: result.resolutions });
        return;
      }
      dispatch({
        type: "save-succeeded",
        workspaceImage: result.saved,
        resolutions: result.resolutions,
      });
    } catch (cause) {
      dispatch({
        type: "save-failed",
        message:
          cause instanceof Error
            ? cause.message
            : "Could not validate and save the workspace environment.",
      });
    }
  };

  const applySuggestions = () => {
    if (suggestions === null) return;
    const suggestedPackages = suggestions.tools
      .filter((tool) => tool.kind === "package")
      .map((tool) => tool.id);
    const dockerObserved = suggestions.tools.some(
      (tool) => tool.kind === "service" && tool.id === "docker",
    );
    dispatch({ type: "suggestions-applied", packageIds: suggestedPackages, dockerObserved });
  };

  return (
    <>
      <div className="mt-5 border-t border-[var(--sw-faint-rule)] pt-5">
        <div className="flex items-start justify-between gap-4">
          <p className="font-sans text-sm font-medium text-foreground">Base</p>
          <div className="flex shrink-0 gap-2">
            {(
              [
                { mode: "family", label: "OS family" },
                { mode: "custom", label: "Custom image" },
              ] as const
            ).map((option) => (
              <button
                key={option.mode}
                type="button"
                disabled={pending}
                onClick={() => dispatch({ type: "mode-changed", mode: option.mode })}
                className={`rounded-xl border px-3.5 py-1.5 font-sans text-xs font-medium shadow-xs transition-colors disabled:opacity-60 ${
                  form.mode === option.mode
                    ? "border-[color-mix(in_oklab,var(--sw-accent)_45%,transparent)] bg-wash text-foreground"
                    : "border-border bg-card text-muted-foreground hover:text-foreground"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        {form.mode === "family" ? (
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {OS_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                disabled={pending}
                onClick={() => dispatch({ type: "os-changed", os: option.value })}
                className={`rounded-xl border p-3 text-left shadow-xs transition-colors disabled:opacity-60 ${
                  form.os === option.value
                    ? "border-[color-mix(in_oklab,var(--sw-accent)_45%,transparent)] bg-wash"
                    : "border-border bg-card hover:border-input"
                }`}
              >
                <span className="block font-sans text-sm font-medium text-foreground">
                  {option.label}
                </span>
                <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                  {option.detail}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="mt-3 space-y-4">
            <div>
              <label
                htmlFor="workspace-base-image"
                className="font-sans text-[13px] font-medium text-foreground"
              >
                Base image
              </label>
              <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
                Any Linux image with a shell, node + npm, and git. Sealant overlays only its
                supervisor and the agent CLIs.
              </p>
              <input
                id="workspace-base-image"
                type="text"
                value={form.baseImage}
                disabled={pending}
                placeholder="node:22-bookworm"
                spellCheck={false}
                onChange={(event) =>
                  dispatch({ type: "base-image-changed", baseImage: event.target.value })
                }
                className="mt-2 w-full rounded-xl border border-input bg-card px-3.5 py-2.5 font-mono text-[12.5px] text-foreground outline-none transition-colors focus:border-[var(--sw-accent)] focus:ring-2 focus:ring-[color-mix(in_oklab,var(--sw-accent)_18%,transparent)] disabled:opacity-60"
              />
            </div>
            <div>
              <label
                htmlFor="workspace-setup-commands"
                className="font-sans text-[13px] font-medium text-foreground"
              >
                Setup commands
              </label>
              <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
                One command per line, run in the fresh workspace before the agent starts. A failing
                command fails the launch.
              </p>
              <textarea
                id="workspace-setup-commands"
                value={form.setupDraft}
                disabled={pending}
                rows={3}
                spellCheck={false}
                onChange={(event) =>
                  dispatch({ type: "setup-changed", setupDraft: event.target.value })
                }
                className="mt-2 w-full resize-y rounded-xl border border-input bg-card px-3.5 py-2.5 font-mono text-[12.5px] leading-relaxed text-foreground outline-none transition-colors focus:border-[var(--sw-accent)] focus:ring-2 focus:ring-[color-mix(in_oklab,var(--sw-accent)_18%,transparent)] disabled:opacity-60"
              />
            </div>
          </div>
        )}
      </div>

      {form.mode === "family" ? (
        <div className="mt-6 border-t border-[var(--sw-faint-rule)] pt-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="font-sans text-sm font-medium text-foreground">Login shell</p>
              <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
                Installed and set as the session’s login shell, so your shell config actually
                applies.
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              {(["bash", "zsh", "fish"] as const).map((shell) => (
                <button
                  key={shell}
                  type="button"
                  disabled={pending}
                  onClick={() => dispatch({ type: "shell-changed", shell })}
                  className={`rounded-xl border px-3.5 py-1.5 font-mono text-xs shadow-xs transition-colors disabled:opacity-60 ${
                    form.shell === shell
                      ? "border-[color-mix(in_oklab,var(--sw-accent)_45%,transparent)] bg-wash text-foreground"
                      : "border-border bg-card text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {shell}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      <div className="mt-6 border-t border-[var(--sw-faint-rule)] pt-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="font-sans text-sm font-medium text-foreground">Docker service</p>
            <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
              A disposable daemon belongs to the workspace. Mend never mounts the host Docker
              socket.
            </p>
          </div>
          <button
            type="button"
            disabled={pending}
            onClick={() => dispatch({ type: "docker-toggled" })}
            className={`shrink-0 rounded-xl border px-3.5 py-1.5 font-sans text-xs font-medium shadow-xs transition-colors disabled:opacity-60 ${
              form.docker
                ? "border-[color-mix(in_oklab,var(--sw-accent)_45%,transparent)] bg-wash text-foreground"
                : "border-border bg-card text-muted-foreground hover:text-foreground"
            }`}
          >
            {form.docker ? "Enabled" : "Disabled"}
          </button>
        </div>
      </div>

      <div className="mt-6 border-t border-[var(--sw-faint-rule)] pt-5">
        <label
          htmlFor="workspace-packages"
          className="font-sans text-sm font-medium text-foreground"
        >
          Packages
        </label>
        <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
          {form.mode === "family"
            ? "One package per line. Sealant resolves every entry for the selected operating system before Mend saves it."
            : "One package per line, passed verbatim to the base image’s own package manager (apt, apk, dnf, or pacman)."}
        </p>
        <textarea
          id="workspace-packages"
          value={form.packageDraft}
          disabled={pending}
          onChange={(event) =>
            dispatch({ type: "packages-changed", packageDraft: event.target.value })
          }
          rows={8}
          spellCheck={false}
          className="mt-3 w-full resize-y rounded-xl border border-input bg-card px-3.5 py-3 font-mono text-[12.5px] leading-relaxed text-foreground outline-none transition-colors focus:border-[var(--sw-accent)] focus:ring-2 focus:ring-[color-mix(in_oklab,var(--sw-accent)_18%,transparent)] disabled:opacity-60"
        />
        <p className="mt-3 text-xs text-muted-foreground">
          {parsedDraft.packages.length} package{parsedDraft.packages.length === 1 ? "" : "s"}
          {form.mode === "family"
            ? ` · checked for ${OS_LABELS[form.os]} on save`
            : " · unchecked (custom base)"}
        </p>
        {parsedDraft.invalid === null ? null : (
          <p className="mt-2 text-xs text-danger">
            Unsupported package syntax: {parsedDraft.invalid}
          </p>
        )}
        {rejectedResolutions.length === 0 ? null : (
          <div className="mt-4 divide-y divide-[var(--sw-faint-rule)] border-y border-[var(--sw-faint-rule)]">
            {rejectedResolutions.map(({ resolution, issue }) => (
              <div key={resolution.requested} className="flex gap-3 py-3">
                <span className="mt-1.5 size-2 shrink-0 rounded-full bg-danger-dot" aria-hidden />
                <div className="min-w-0">
                  <p className="font-mono text-[12.5px] text-ink-2">{resolution.requested}</p>
                  <p className="mt-0.5 text-xs leading-relaxed text-danger">{issue}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {allowScan ? (
        <div className="mt-6 border-t border-[var(--sw-faint-rule)] pt-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="font-sans text-sm font-medium text-foreground">
                Suggestions from this machine
              </p>
              <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
                Checks a fixed list of executable and config paths on the machine running Mend. It
                does not list your home directory or read config contents.
              </p>
            </div>
            <button
              type="button"
              disabled={scanning}
              onClick={() => {
                setScanning(true);
                setScanError(null);
                void orLogin(trpcClient.settings.environmentSuggestions.query())
                  .then(setSuggestions)
                  .catch((cause: unknown) =>
                    setScanError(
                      cause instanceof Error ? cause.message : "Could not scan this machine.",
                    ),
                  )
                  .finally(() => setScanning(false));
              }}
              className="inline-flex min-h-9 shrink-0 items-center justify-center rounded-xl border border-border bg-panel px-3.5 font-sans text-[13px] font-medium text-foreground shadow-[var(--shadow-xs)] transition-[transform,border-color] hover:-translate-y-0.5 hover:border-input disabled:pointer-events-none disabled:opacity-60"
            >
              {scanning ? "Scanning…" : "Scan machine"}
            </button>
          </div>

          {suggestions === null ? null : (
            <div className="mt-4 space-y-4">
              <div className="divide-y divide-[var(--sw-faint-rule)] border-y border-[var(--sw-faint-rule)]">
                {suggestions.tools.map((tool) => (
                  <div
                    key={`${tool.kind}:${tool.id}`}
                    className="flex items-baseline justify-between gap-4 py-2.5"
                  >
                    <span className="font-mono text-[12.5px] text-ink-2">{tool.executable}</span>
                    <span className="text-xs text-muted-foreground">
                      {tool.kind === "service" ? "workspace service" : tool.id}
                    </span>
                  </div>
                ))}
                {suggestions.tools.length === 0 ? (
                  <p className="py-3 text-[13px] text-muted-foreground">No known tools observed.</p>
                ) : null}
              </div>
              {suggestions.tools.length === 0 ? null : (
                <button
                  type="button"
                  disabled={pending}
                  onClick={applySuggestions}
                  className="rounded-xl border border-border bg-card px-3.5 py-2 font-sans text-[13px] font-medium text-foreground shadow-xs transition-transform hover:-translate-y-0.5 disabled:opacity-60"
                >
                  Add observed tools to draft
                </button>
              )}
              {suggestions.configs.length === 0 ? null : (
                <div>
                  <p className="font-sans text-xs font-medium text-muted-foreground">
                    Config candidates · presence observed
                  </p>
                  <div className="mt-2 space-y-2">
                    {suggestions.configs.map((config) => (
                      <div key={config.path} className="flex items-baseline gap-3">
                        <span className="w-24 shrink-0 text-xs text-muted-foreground">
                          {config.label}
                        </span>
                        <span className="font-mono text-[12.5px] text-ink-2">{config.path}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      ) : null}

      <div className="mt-6 flex items-center justify-between gap-4 border-t border-[var(--sw-faint-rule)] pt-5">
        <div className="flex min-w-0 items-center gap-2.5 text-[13px]">
          {form.phase === "saved" ? (
            <>
              <span className="size-2 shrink-0 rounded-full bg-success-dot" aria-hidden />
              <span className="text-success">Saved · packages resolved by Sealant</span>
            </>
          ) : (
            <span className={dirty ? "text-foreground" : "text-muted-foreground"}>
              {dirty ? "Unsaved environment changes" : "No environment changes"}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-4">
          {secondaryAction}
          <button
            type="button"
            disabled={
              pending ||
              !dirty ||
              parsedDraft.invalid !== null ||
              (form.mode === "custom" && form.baseImage.trim() === "")
            }
            onClick={() => void persist()}
            className="inline-flex min-h-9 shrink-0 items-center justify-center rounded-xl bg-primary px-4 font-sans text-[13px] font-medium text-primary-foreground shadow-[var(--shadow-cobalt)] transition-transform hover:-translate-y-0.5 disabled:pointer-events-none disabled:opacity-60"
          >
            {pending ? "Checking packages…" : "Save environment"}
          </button>
        </div>
      </div>

      {form.error === null && scanError === null ? null : (
        <p className="mt-4 border-l-2 border-danger pl-3 text-[13px] text-danger">
          {form.error ?? scanError}
        </p>
      )}
    </>
  );
}
