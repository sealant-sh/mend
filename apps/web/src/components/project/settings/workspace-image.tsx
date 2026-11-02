import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { SaveBar, SwitchRow } from "#/components/kit/controls";
import { Field, FieldSource, GroupField, TextInput } from "#/components/kit/field";
import { SettingsSection } from "#/components/kit/section";
import { Segment } from "#/components/kit/segment";
import { setProjectWorkspaceImage, type ProjectDto, type SettingsDto } from "#/lib/api";
import { useTRPC } from "#/lib/trpc";
import { useInheritedSettings } from "#/lib/viewer";
import {
  createWorkspaceEnvironmentForm,
  OS_LABELS,
  parsePackageDraft,
  resolutionIssue,
  SCREEN_SWITCH_COPY,
  workspaceEnvironmentFormReducer,
  workspaceImageFromForm,
  workspaceImagesEqual,
  type WorkspaceEnvironmentFormState,
} from "#/lib/workspace-environment";

type WorkspaceImage = SettingsDto["workspaceImage"];

const OS_CHOICES = (["arch", "fedora", "ubuntu", "nix"] as const).map((os) => ({
  value: os,
  label: OS_LABELS[os],
}));
const SHELL_CHOICES = (["bash", "zsh", "fish"] as const).map((shell) => ({
  value: shell,
  label: shell,
}));
const MODE_CHOICES = [
  { value: "family", label: "OS family" },
  { value: "custom", label: "Custom image" },
] as const;

const packages = (image: WorkspaceImage) => image.packages.join(" ");

/** How many of the image's fields the draft changes, for the save bar. */
const changedFields = (form: WorkspaceEnvironmentFormState, saved: WorkspaceImage): number => {
  const draft = workspaceImageFromForm(form);
  if (draft.mode !== saved.mode) return 1;
  const facts = (image: WorkspaceImage): ReadonlyArray<string> =>
    image.mode === "family"
      ? [
          image.os,
          image.shell,
          packages(image),
          String(image.services.docker),
          String(image.screen),
        ]
      : [
          image.baseImage,
          image.setupCommands.join("\n"),
          packages(image),
          String(image.services.docker),
        ];
  const before = facts(saved);
  return facts(draft).filter((fact, index) => fact !== before[index]).length;
};

/** The image draft of the Workspace tab: its fields, where they come from, and saving them. */
export type ImageDraft = ReturnType<typeof useWorkspaceImageDraft>;

/**
 * The project's workspace image and its Screen and Docker switches (screen L2) as one draft, saved
 * together by "Save and rebuild", since every save rebuilds the image new sessions wait for. The
 * draft is null until something is edited, so the fields show what is saved, including a save
 * another person makes. Each field says whether it follows the organization or is set for this
 * project; reset puts the whole image back on the organization's, because the image is saved as
 * one. `undefined` while the inherited image is read.
 */
export function useWorkspaceImageDraft(project: ProjectDto) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const inherited = useInheritedSettings();
  const organization = useQuery(
    trpc.organization.settings.queryOptions(undefined, { retry: false }),
  );
  const [edited, setEdited] = useState<WorkspaceEnvironmentFormState | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const saved = project.workspaceImage ?? inherited?.workspaceImage;
  const save = useMutation({
    mutationFn: (image: WorkspaceImage | null) => setProjectWorkspaceImage(project.id, image),
    onMutate: () => setFailure(null),
    onSuccess: async (result) => {
      if (!result.saved) {
        setEdited((current) =>
          current === null
            ? current
            : workspaceEnvironmentFormReducer(current, {
                type: "save-rejected",
                resolutions: result.resolutions,
              }),
        );
        return;
      }
      await queryClient.invalidateQueries(trpc.projects.detail.queryFilter({ id: project.id }));
      setEdited(null);
    },
    onError: (error) => setFailure(error.message),
  });
  if (saved === undefined) return undefined;
  const form = edited ?? createWorkspaceEnvironmentForm(saved);
  const dispatch = (action: Parameters<typeof workspaceEnvironmentFormReducer>[1]) =>
    setEdited(workspaceEnvironmentFormReducer(form, action));
  // From the instance when the organization set no image of its own.
  const inheritedFrom =
    organization.data !== undefined && organization.data.organization.workspaceImage === null
      ? "from the instance default"
      : "from your organization";
  const draft = workspaceImageFromForm(form);
  const dirty = !workspaceImagesEqual(draft, saved);
  return {
    project,
    form,
    dispatch,
    dirty,
    changes: dirty ? Math.max(1, changedFields(form, saved)) : 0,
    inheritedFrom,
    busy: save.isPending,
    failure,
    save: () => save.mutate(draft),
    reset: () => save.mutate(null),
    discard: () => {
      setFailure(null);
      setEdited(null);
    },
  };
}

/** The Image and Screen and Docker sections, drawn from the draft. */
export function WorkspaceImageSections({ draft: image }: { readonly draft: ImageDraft }) {
  if (image === undefined)
    return (
      <SettingsSection title="Image" why="What the workspace is built from.">
        <p role="status" className="font-mono text-[12px] text-muted-foreground">
          Reading the organization&apos;s image…
        </p>
      </SettingsSection>
    );
  const { project, form, dispatch, busy, inheritedFrom } = image;
  const set = project.workspaceImage !== null;
  const invalidPackage = parsePackageDraft(form.packageDraft).invalid;
  const rejections = (form.resolutions ?? []).filter(
    (resolution) => resolution.status !== "resolved" || !resolution.supported,
  );
  const source = set ? (
    <FieldSource tone="set">
      set for {project.name} ·{" "}
      <button type="button" disabled={busy} onClick={image.reset}>
        reset
      </button>
    </FieldSource>
  ) : (
    <FieldSource>{inheritedFrom}</FieldSource>
  );

  return (
    <>
      <SettingsSection
        title="Image"
        why="What the workspace is built from. New sessions wait for a rebuild."
      >
        <GroupField label="Base" source={source}>
          <Segment
            label="Base"
            value={form.mode}
            options={MODE_CHOICES}
            disabled={busy}
            onChange={(mode) => dispatch({ type: "mode-changed", mode })}
          />
        </GroupField>
        {form.mode === "family" ? (
          <>
            <GroupField label="OS" source={source}>
              <Segment
                label="OS"
                value={form.os}
                options={OS_CHOICES}
                disabled={busy}
                onChange={(os) => dispatch({ type: "os-changed", os })}
              />
            </GroupField>
            <GroupField label="Login shell" source={source}>
              <Segment
                label="Login shell"
                value={form.shell}
                options={SHELL_CHOICES}
                disabled={busy}
                onChange={(shell) => dispatch({ type: "shell-changed", shell })}
              />
            </GroupField>
          </>
        ) : (
          <>
            <Field label="Base image" source={source}>
              {(id) => (
                <TextInput
                  id={id}
                  value={form.baseImage}
                  disabled={busy}
                  placeholder="node:22-bookworm"
                  spellCheck={false}
                  onChange={(event) =>
                    dispatch({ type: "base-image-changed", baseImage: event.target.value })
                  }
                />
              )}
            </Field>
            <Field label="Setup commands" source={<FieldSource>one per line</FieldSource>}>
              {(id) => (
                <textarea
                  id={id}
                  value={form.setupDraft}
                  disabled={busy}
                  rows={2}
                  spellCheck={false}
                  onChange={(event) =>
                    dispatch({ type: "setup-changed", setupDraft: event.target.value })
                  }
                  className="w-full resize-y rounded-[10px] border border-input bg-panel px-3 py-[9px] font-mono text-[13px] leading-relaxed text-foreground outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring/30"
                />
              )}
            </Field>
          </>
        )}
        <Field label="Packages" source={source}>
          {(id) => (
            <>
              <TextInput
                id={id}
                value={form.packageDraft.replaceAll("\n", " ")}
                disabled={busy}
                placeholder="packages, separated by spaces"
                spellCheck={false}
                aria-invalid={invalidPackage !== null || rejections.length > 0 || undefined}
                aria-describedby={`${id}-issues`}
                onChange={(event) =>
                  dispatch({
                    type: "packages-changed",
                    packageDraft: event.target.value.split(/\s+/).join("\n"),
                  })
                }
              />
              <div id={`${id}-issues`} role="alert" className="grid gap-1 empty:hidden">
                {invalidPackage === null ? null : (
                  <p className="text-[12.5px] text-danger">
                    <span className="font-mono">{invalidPackage}</span> is not a package name.
                  </p>
                )}
                {rejections.map((resolution) => (
                  <p key={resolution.requested} className="text-[12.5px] text-danger">
                    <span className="font-mono">{resolution.requested}</span> ·{" "}
                    {resolutionIssue(resolution, form.os)}
                  </p>
                ))}
              </div>
            </>
          )}
        </Field>
      </SettingsSection>
      <SettingsSection
        title={form.mode === "family" ? "Screen and Docker" : "Docker"}
        why={
          form.mode === "family"
            ? "Let sessions open a screen and run containers."
            : "Let sessions run containers."
        }
      >
        {form.mode === "family" ? (
          <SwitchRow
            label="Screen"
            detail={SCREEN_SWITCH_COPY}
            checked={form.screen}
            disabled={busy}
            onCheckedChange={() => dispatch({ type: "screen-toggled" })}
          />
        ) : null}
        <SwitchRow
          label="Docker service"
          detail="A disposable daemon belongs to the workspace. Mend never mounts the host Docker socket."
          checked={form.docker}
          disabled={busy}
          onCheckedChange={() => dispatch({ type: "docker-toggled" })}
        />
      </SettingsSection>
    </>
  );
}

/** "N unsaved changes · rebuilds the image", under the tab's panel while the image is edited. */
export function WorkspaceImageSaveBar({ draft: image }: { readonly draft: ImageDraft }) {
  if (image === undefined || (!image.dirty && image.failure === null)) return null;
  const invalid =
    parsePackageDraft(image.form.packageDraft).invalid !== null ||
    (image.form.mode === "custom" && image.form.baseImage.trim() === "");
  return (
    <SaveBar
      summary={
        image.dirty
          ? `${image.changes} unsaved change${image.changes === 1 ? "" : "s"} · rebuilds the image`
          : "nothing unsaved"
      }
      saveLabel="Save and rebuild"
      pending={image.busy}
      error={image.failure === null ? undefined : `The image did not save: ${image.failure}`}
      onSave={() => {
        if (!invalid && image.dirty) image.save();
      }}
      onDiscard={image.discard}
    />
  );
}
