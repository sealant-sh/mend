import { useQuery } from "@tanstack/react-query";
import { useReducer, useRef, useState, type ReactNode } from "react";

import { Button } from "#/components/kit/button";
import { Field, TextInput } from "#/components/kit/field";
import { focusFirstControl, SaveBar, SaveStatus } from "#/components/kit/save-bar";
import { Panel, SettingsSection } from "#/components/kit/section";
import { Segment } from "#/components/kit/segment";
import { Dot, ErrorNote, errorText, StatusWord } from "#/components/kit/status";
import { SwitchRow } from "#/components/kit/switch";
import { TextArea } from "#/components/kit/text-area";
import type { SettingsDto, WorkspacePackageResolutionDto } from "#/lib/api";
import { useTRPC } from "#/lib/trpc";
import {
  createWorkspaceEnvironmentForm,
  OS_LABELS,
  parsePackageDraft,
  resolutionIssue,
  workspaceEnvironmentFormReducer,
  workspaceImageFromForm,
  workspaceImagesEqual,
} from "#/lib/workspace-environment";

import { CaptionedControl } from "./org-parts";

type WorkspaceImage = SettingsDto["workspaceImage"];
type Os = Extract<WorkspaceImage, { mode: "family" }>["os"];
type Shell = Extract<WorkspaceImage, { mode: "family" }>["shell"];

const BASES = [
  { value: "family", label: "OS family" },
  { value: "custom", label: "Custom image" },
] as const satisfies ReadonlyArray<{ value: WorkspaceImage["mode"]; label: string }>;

const OSES: ReadonlyArray<{ readonly value: Os; readonly label: string }> = (
  ["arch", "fedora", "ubuntu", "nix"] as const
).map((os) => ({ value: os, label: OS_LABELS[os] }));

const SHELLS = [
  { value: "bash", label: "bash" },
  { value: "zsh", label: "zsh" },
  { value: "fish", label: "fish" },
] as const satisfies ReadonlyArray<{ value: Shell; label: string }>;

/** What a save answered: the image as saved, or null when a package did not resolve. */
export interface EnvironmentSaved {
  readonly saved: WorkspaceImage | null;
  readonly resolutions: ReadonlyArray<WorkspacePackageResolutionDto>;
}

export interface EnvironmentFormProps {
  readonly title: string;
  readonly why: ReactNode;
  /** The environment as saved: the draft starts from it and Discard goes back to it. */
  readonly savedImage: WorkspaceImage;
  /** Resolve and save the draft. A rejection shows the mutation's error, passed as `error`. */
  readonly onSave: (image: WorkspaceImage) => Promise<EnvironmentSaved>;
  readonly pending: boolean;
  readonly error: unknown;
  /** The machine scan reads the host Mend runs on, so it is the operator's alone. */
  readonly allowScan: boolean;
  /** What a save changes, after the count ("rebuilds images"). */
  readonly saveEffect: string;
  /** Quieter actions under the form, such as an organization's "Follow the instance". */
  readonly actions?: ReactNode;
}

/**
 * The workspace environment, as Settings edits it for an organization (O4) and for the instance
 * (O9): base, operating system, login shell, Screen and Docker, packages. The draft is local until
 * Save; Sealant resolves every family package before anything is saved. A new saved value, or
 * Discard, starts the draft over.
 */
export function EnvironmentForm(props: EnvironmentFormProps) {
  const [generation, setGeneration] = useState(0);
  // What the last save or discard did. The draft remounts after either, so this line and the
  // focus target live out here, where they stay mounted.
  const [said, setSaid] = useState<string | null>(null);
  const fields = useRef<HTMLDivElement>(null);
  return (
    <div ref={fields}>
      <EnvironmentDraft
        key={`${generation}:${JSON.stringify(props.savedImage)}`}
        {...props}
        onEdit={() => setSaid(null)}
        onSaved={() => setSaid("Saved")}
        onDiscard={() => {
          setSaid("Discarded");
          setGeneration((value) => value + 1);
        }}
        returnFocus={() => focusFirstControl(fields.current)}
      />
      <SaveStatus>{said}</SaveStatus>
    </div>
  );
}

/** How many of the draft's parts differ from what is saved, for the save bar. */
const changedParts = (saved: WorkspaceImage, draft: WorkspaceImage): number => {
  if (saved.mode !== draft.mode) return 1;
  const parts: ReadonlyArray<boolean> = [
    saved.services.docker !== draft.services.docker,
    saved.packages.join("\n") !== draft.packages.join("\n"),
    ...(saved.mode === "family" && draft.mode === "family"
      ? [saved.os !== draft.os, saved.shell !== draft.shell, saved.screen !== draft.screen]
      : saved.mode === "custom" && draft.mode === "custom"
        ? [
            saved.baseImage !== draft.baseImage,
            saved.setupCommands.join("\n") !== draft.setupCommands.join("\n"),
          ]
        : []),
  ];
  return parts.filter(Boolean).length;
};

function EnvironmentDraft({
  title,
  why,
  savedImage,
  onSave,
  pending,
  error,
  allowScan,
  saveEffect,
  actions,
  onEdit,
  onSaved,
  onDiscard,
  returnFocus,
}: EnvironmentFormProps & {
  readonly onEdit: () => void;
  readonly onSaved: () => void;
  readonly onDiscard: () => void;
  readonly returnFocus: () => void;
}) {
  const [form, dispatch] = useReducer(
    workspaceEnvironmentFormReducer,
    savedImage,
    createWorkspaceEnvironmentForm,
  );
  // Any edit starts a new draft, so what the last save did no longer describes it.
  const edit: typeof dispatch = (action) => {
    onEdit();
    dispatch(action);
  };
  const parsed = parsePackageDraft(form.packageDraft);
  const candidate = workspaceImageFromForm(form);
  const dirty = !workspaceImagesEqual(savedImage, candidate);
  const changes = changedParts(savedImage, candidate);
  const rejected = (form.resolutions ?? []).flatMap((resolution) => {
    const issue = resolutionIssue(resolution, form.os);
    return issue === null ? [] : [{ resolution, issue }];
  });

  const save = () => {
    void onSave(candidate)
      .then((result) => {
        if (result.saved === null)
          dispatch({ type: "save-rejected", resolutions: result.resolutions });
        else onSaved();
        return undefined;
      })
      // The mutation holds the failure; the save bar shows it.
      .catch(() => undefined);
  };

  return (
    <>
      <Panel>
        <SettingsSection title={title} why={why}>
          <CaptionedControl caption="Base">
            <Segment
              label="Base"
              value={form.mode}
              disabled={pending}
              onChange={(mode) => edit({ type: "mode-changed", mode })}
              options={BASES}
            />
          </CaptionedControl>
          {form.mode === "family" ? (
            <>
              <CaptionedControl caption="OS">
                <Segment
                  label="OS"
                  value={form.os}
                  disabled={pending}
                  onChange={(os) => edit({ type: "os-changed", os })}
                  options={OSES}
                />
              </CaptionedControl>
              <CaptionedControl caption="Login shell">
                <Segment
                  label="Login shell"
                  value={form.shell}
                  disabled={pending}
                  onChange={(shell) => edit({ type: "shell-changed", shell })}
                  options={SHELLS}
                />
              </CaptionedControl>
            </>
          ) : (
            <>
              <Field label="Base image">
                {(id) => (
                  <TextInput
                    id={id}
                    value={form.baseImage}
                    disabled={pending}
                    placeholder="node:22-bookworm"
                    spellCheck={false}
                    onChange={(event) =>
                      edit({ type: "base-image-changed", baseImage: event.target.value })
                    }
                  />
                )}
              </Field>
              <Field label="Setup commands">
                {(id) => (
                  <TextArea
                    id={id}
                    rows={3}
                    value={form.setupDraft}
                    disabled={pending}
                    placeholder="one command per line"
                    onChange={(event) =>
                      edit({ type: "setup-changed", setupDraft: event.target.value })
                    }
                  />
                )}
              </Field>
              <p className="-mt-2 mb-4 text-[12.5px] text-muted-foreground">
                Any Linux image with a shell, node and npm, and git. Setup commands run on a
                worktree&apos;s first launch, before the agent starts; one that fails fails the
                launch.
              </p>
            </>
          )}
          <div className="mb-3">
            {form.mode === "family" ? (
              <SwitchRow
                label="Screen"
                detail="TigerVNC, Openbox, Chromium and DejaVu fonts, so the agent can drive a browser people watch · grows the image by an amount Mend has not measured yet · x86_64 only"
                checked={form.screen}
                disabled={pending}
                onCheckedChange={() => edit({ type: "screen-toggled" })}
              />
            ) : null}
            <SwitchRow
              label="Docker service"
              detail="a disposable daemon in the workspace · never the host's socket"
              checked={form.docker}
              disabled={pending}
              onCheckedChange={() => edit({ type: "docker-toggled" })}
            />
          </div>
          <Field
            label="Packages"
            source={
              <span className="font-mono text-[11px] text-faint">
                {parsed.packages.length} ·{" "}
                {form.mode === "family"
                  ? `checked for ${OS_LABELS[form.os]} on save`
                  : "passed to the image's package manager"}
              </span>
            }
          >
            {(id) => (
              <TextInput
                id={id}
                // One line, packages apart by spaces; the draft keeps one per line.
                value={form.packageDraft.split("\n").join(" ")}
                disabled={pending}
                spellCheck={false}
                placeholder="git ripgrep jq"
                onChange={(event) =>
                  edit({
                    type: "packages-changed",
                    packageDraft: event.target.value.replace(/\s/g, "\n"),
                  })
                }
              />
            )}
          </Field>
          {parsed.invalid === null ? null : (
            <ErrorNote className="mb-4">Not a package name: {parsed.invalid}</ErrorNote>
          )}
          {rejected.length === 0 ? null : (
            <div role="alert" className="mb-4 grid gap-1.5">
              {rejected.map(({ resolution, issue }) => (
                <p key={resolution.requested} className="flex items-baseline gap-2 text-[12.5px]">
                  <Dot tone="bad" />
                  <span className="font-mono text-ink-2">{resolution.requested}</span>
                  <span className="text-danger">{issue}</span>
                </p>
              ))}
            </div>
          )}
          {allowScan ? <MachineScan pending={pending} dispatch={dispatch} /> : null}
          {actions === undefined ? null : <div className="mt-2 flex gap-2">{actions}</div>}
        </SettingsSection>
      </Panel>
      <SaveBar
        dirty={dirty}
        summary={`${changes} unsaved ${changes === 1 ? "change" : "changes"} · ${saveEffect}`}
        saveLabel="Save environment"
        pendingLabel="Checking packages…"
        pending={pending}
        error={error === null ? null : errorText(error)}
        canSave={
          parsed.invalid === null && !(form.mode === "custom" && form.baseImage.trim() === "")
        }
        returnFocus={returnFocus}
        onDiscard={onDiscard}
        onSave={save}
      />
    </>
  );
}

/**
 * Scan the machine Mend runs on for known tools (operators only): a fixed list of executable and
 * config paths, never the home directory's listing or any config's contents.
 */
function MachineScan({
  pending,
  dispatch,
}: {
  readonly pending: boolean;
  readonly dispatch: (action: Parameters<typeof workspaceEnvironmentFormReducer>[1]) => void;
}) {
  const trpc = useTRPC();
  const scan = useQuery({
    ...trpc.settings.environmentSuggestions.queryOptions(undefined, { retry: false }),
    enabled: false,
  });
  const tools = scan.data?.tools ?? [];
  return (
    <div className="mt-2">
      <div className="flex gap-2">
        <Button size="sm" disabled={scan.isFetching} onClick={() => void scan.refetch()}>
          {scan.isFetching ? "Scanning…" : "Scan machine"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={pending || tools.length === 0}
          onClick={() =>
            dispatch({
              type: "suggestions-applied",
              packageIds: tools.filter((tool) => tool.kind === "package").map((tool) => tool.id),
              dockerObserved: tools.some((tool) => tool.kind === "service" && tool.id === "docker"),
            })
          }
        >
          Add observed tools to draft
        </Button>
      </div>
      {scan.error === null ? null : <ErrorNote className="mt-3">{errorText(scan.error)}</ErrorNote>}
      {scan.data === undefined ? null : (
        <div className="mt-3 grid gap-1" role="status">
          {tools.length === 0 ? (
            <p className="font-mono text-[12px] text-faint">no known tools observed</p>
          ) : (
            tools.map((tool) => (
              <StatusWord key={`${tool.kind}:${tool.id}`} tone="ok">
                {tool.executable} · {tool.kind === "service" ? "workspace service" : tool.id} ·
                observed
              </StatusWord>
            ))
          )}
          {scan.data.configs.map((config) => (
            <p key={config.path} className="font-mono text-[12px] text-muted-foreground">
              {config.label} · {config.path} · present
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
