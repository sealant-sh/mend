import type { WorkspaceImage } from "@mend/domain";
import { Segmented } from "@mend/ui/components/segmented";
import { Button } from "@mend/ui/components/ui/button";
import { Input } from "@mend/ui/components/ui/input";
import { Spinner } from "@mend/ui/components/ui/spinner";
import { Switch } from "@mend/ui/components/ui/switch";
import { Textarea } from "@mend/ui/components/ui/textarea";
import { toast } from "@mend/ui/components/ui/toast";
import { cn } from "@mend/ui/lib/utils";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { InfoIcon, PlusIcon, XIcon } from "lucide-react";
import { useCallback, useId, useState } from "react";

import { namesList, ownersOf } from "#/lib/organization-general";
import { usePhone } from "#/lib/phone";
import { failureWords } from "#/lib/refusal";
import { pickerNotes, refusedFamilies, useRuntimeFacts } from "#/lib/runtime-support";
import { signedInOptions } from "#/lib/sign-in";
import { useTRPC } from "#/lib/trpc";
import {
  addPackages,
  draftOf,
  draftProblem,
  type ImageDraft,
  imageLine,
  imageOf,
  OS_LABELS,
  OS_ORDER,
  rejectedPackages,
  rejectionLine,
  SHELL_ORDER,
  startingImageSaved,
  workspaceImagesEqual,
} from "#/lib/workspace-image";

import { SettingRow, SettingSection } from "./setting-row.tsx";
import { SettingsPage } from "./settings-page.tsx";

/** A control's height: the frames' 36px on the desk, a 44px touch target on a phone. */
const CONTROL = "h-9 max-lg:h-11 max-lg:text-base";

const MODES = [
  { value: "family", label: "Build from a family" },
  { value: "custom", label: "Custom image" },
] as const;

/**
 * Settings → the organization → Workspace image (Doop "Workspace image · Northwind"): the
 * organization's starting image, which Mend copies into each new project when the project is
 * created. Owners edit it; everyone else reads it and who can change it. Saving changes no existing
 * project and starts no build: a new project builds its copy when its first session needs it.
 */
export function WorkspaceImagePage() {
  const trpc = useTRPC();
  const viewer = useSuspenseQuery(signedInOptions(trpc)).data;
  const settings = useSuspenseQuery(trpc.organization.settings.queryOptions()).data;
  const roster = useSuspenseQuery(trpc.organization.members.queryOptions()).data;
  const organization = viewer.organization.name;
  const saved = settings.organization.workspaceImage;
  const owners = ownersOf(roster, viewer.userId).map((person) => person.name);
  return (
    <SettingsPage
      page="o-image"
      intro={
        <>
          The starting image for {organization}&apos;s projects. Mend copies it into each new
          project when the project is created.
          <span className="mt-1.5 flex gap-1.5 text-row text-muted-foreground">
            <InfoIcon aria-hidden className="mt-0.5 size-3.5 flex-none" />
            Changing it doesn&apos;t change existing projects. Each project edits its own copy on
            its Workspace page.
            {settings.editable
              ? ""
              : owners.length === 0
                ? ` Only an owner of ${organization} can change it.`
                : ` Only an owner can change it: ${namesList(owners)}.`}
          </span>
        </>
      }
    >
      {settings.editable ? (
        // A new saved image starts the draft over.
        <ImageEditor key={JSON.stringify(saved)} saved={saved} organization={organization} />
      ) : (
        <ImageReading image={saved} />
      )}
    </SettingsPage>
  );
}

/** The image for someone who can't change it: what it is, row by row. */
function ImageReading({ image }: { readonly image: WorkspaceImage }) {
  return (
    <>
      <SettingSection title="Starting image">
        <SettingRow label="Image" control={<span>{imageLine(image)}</span>} />
        {image.mode === "custom" ? (
          <SettingRow
            label="Setup commands"
            description={
              image.setupCommands.length === 0 ? (
                "None."
              ) : (
                <code className="whitespace-pre-wrap">{image.setupCommands.join("\n")}</code>
              )
            }
          />
        ) : null}
        <SettingRow
          layout="stack"
          label="Packages"
          description={image.packages.length === 0 ? "None." : undefined}
          note={image.packages.length === 0 ? null : <PackageList packages={image.packages} />}
        />
      </SettingSection>
      <SettingSection title="Workspace features">
        {image.mode === "family" ? (
          <SettingRow
            label="Screen for the agent"
            control={<span>{image.screen ? "On" : "Off"}</span>}
          />
        ) : null}
        <SettingRow
          label="Docker inside workspaces"
          control={<span>{image.services.docker ? "On" : "Off"}</span>}
        />
      </SettingSection>
    </>
  );
}

/** The packages as chips; with `onRemove`, each has a remove button. */
function PackageList({
  packages,
  rejected,
  onRemove,
  disabled,
}: {
  readonly packages: ReadonlyArray<string>;
  readonly rejected?: ReadonlySet<string>;
  readonly onRemove?: (name: string) => void;
  readonly disabled?: boolean;
}) {
  return (
    <ul aria-label="Packages" className="mt-2 flex flex-wrap gap-2">
      {packages.map((name) => (
        <li
          key={name}
          className={cn(
            "inline-flex h-8 items-center gap-1 rounded-md border border-border pr-1 pl-2.5 font-mono text-row max-lg:h-11 max-lg:pr-0",
            onRemove === undefined && "pr-2.5",
            rejected?.has(name) === true && "border-destructive text-destructive",
          )}
        >
          {name}
          {onRemove === undefined ? null : (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={`Remove ${name}`}
              disabled={disabled}
              onClick={() => onRemove(name)}
              className="max-lg:size-11"
            >
              <XIcon aria-hidden />
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * The editor, for an owner. The draft is local until Save; Sealant resolves every family package
 * before anything is saved, and a package it can't find refuses the whole save.
 */
function ImageEditor({
  saved,
  organization,
}: {
  readonly saved: WorkspaceImage;
  readonly organization: string;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const phone = usePhone();
  const id = useId();
  const runtime = useRuntimeFacts();
  const [draft, setDraft] = useState<ImageDraft>(() => draftOf(saved));
  const [adding, setAdding] = useState<string | null>(null);
  const [addProblem, setAddProblem] = useState<string | null>(null);
  const [rejected, setRejected] = useState<ReadonlyArray<{ name: string; issue: string }>>([]);
  const save = useMutation(
    trpc.organization.setWorkspaceEnvironment.mutationOptions({
      onSuccess: (result) => {
        if (!result.saved) {
          setRejected(rejectedPackages(result.resolutions, draft.os));
          return;
        }
        queryClient.setQueryData(trpc.organization.settings.queryKey(), result.settings);
        toast.add({ description: startingImageSaved(organization) });
      },
    }),
  );
  const pending = save.isPending;
  const image = imageOf(draft);
  const dirty = !workspaceImagesEqual(saved, image);
  const notes = pickerNotes(runtime, image);
  const problem = draftProblem(draft) ?? notes.blocks;
  const edit = (next: ImageDraft) => {
    setDraft(next);
    setRejected([]);
    save.reset();
  };
  const commitAdd = () => {
    if (adding === null) return;
    const result = addPackages(draft.packages, adding);
    if (result.invalid !== null) {
      setAddProblem(
        `${result.invalid} isn't a package name: use letters, digits and . _ : + -, starting with a letter or digit.`,
      );
      return;
    }
    setAddProblem(null);
    edit({ ...draft, packages: result.packages });
    setAdding("");
  };
  const discard = () => {
    setDraft(draftOf(saved));
    setAdding(null);
    setAddProblem(null);
    setRejected([]);
    save.reset();
  };
  const size = phone ? "touch" : "default";
  // The field opens on Add package, so focus goes into it once, when it appears.
  const focusOnMount = useCallback((field: HTMLInputElement | null) => field?.focus(), []);
  return (
    <>
      <SettingSection title="Starting image">
        <SettingRow
          layout="stack"
          label="Image"
          description={
            draft.mode === "family"
              ? "Mend builds it from an operating system, a shell and the packages below."
              : "Mend starts from your image, runs its setup commands and adds the packages below."
          }
          note={runtimeLine(notes.base, notes.blocks !== null && draft.mode === "custom")}
          control={
            <Segmented
              aria-label="Image"
              size={size}
              value={draft.mode}
              disabled={pending}
              options={MODES}
              onValueChange={(mode) => edit({ ...draft, mode })}
            />
          }
        />
        {draft.mode === "family" ? (
          <>
            <SettingRow
              layout="stack"
              label="Operating system"
              description="Agents install extra tools with this system's package manager."
              note={runtimeLine(notes.os, notes.blocks !== null)}
              control={
                <Segmented
                  aria-label="Operating system"
                  size={size}
                  value={draft.os}
                  disabled={pending}
                  options={OS_ORDER.map((os) => ({
                    value: os,
                    label: OS_LABELS[os],
                    disabled: refusedFamilies(runtime).has(os),
                  }))}
                  onValueChange={(os) => edit({ ...draft, os })}
                />
              }
            />
            <SettingRow
              layout="stack"
              label="Shell"
              description="The shell for terminals and the agent's commands."
              control={
                <Segmented
                  aria-label="Shell"
                  size={size}
                  value={draft.shell}
                  disabled={pending}
                  options={SHELL_ORDER.map((shell) => ({ value: shell, label: shell }))}
                  onValueChange={(shell) => edit({ ...draft, shell })}
                />
              }
            />
          </>
        ) : (
          <>
            <SettingRow
              layout="stack"
              label="Base image"
              labelFor={`${id}-base`}
              description="Any Linux image with a shell, node and npm, and git."
              control={
                <Input
                  id={`${id}-base`}
                  value={draft.baseImage}
                  disabled={pending}
                  spellCheck={false}
                  placeholder="node:22-bookworm"
                  onChange={(event) => edit({ ...draft, baseImage: event.target.value })}
                  className={`${CONTROL} w-80 font-mono max-lg:w-full`}
                />
              }
            />
            <SettingRow
              layout="stack"
              label="Setup commands"
              labelFor={`${id}-setup`}
              description="One command per line. They run on a worktree's first launch, before the agent starts; one that fails fails the launch."
              control={
                <Textarea
                  id={`${id}-setup`}
                  rows={3}
                  value={draft.setupCommands}
                  disabled={pending}
                  spellCheck={false}
                  placeholder="corepack enable"
                  onChange={(event) => edit({ ...draft, setupCommands: event.target.value })}
                  className="w-80 font-mono max-lg:w-full"
                />
              }
            />
          </>
        )}
        <div className="border-b border-border py-3.5 max-lg:px-4">
          <p className="font-semibold">Packages</p>
          <p className="mt-0.5 text-row text-pretty text-muted-foreground">
            {draft.mode === "family"
              ? "Use the package's usual name. Mend finds the right one for each operating system."
              : "Passed to the image's own package manager as they are."}
          </p>
          <PackageList
            packages={draft.packages}
            rejected={new Set(rejected.map((entry) => entry.name))}
            disabled={pending}
            onRemove={(name) =>
              edit({ ...draft, packages: draft.packages.filter((other) => other !== name) })
            }
          />
          {adding === null ? (
            <Button
              type="button"
              variant="outline"
              className={cn(CONTROL, "mt-2 border-dashed")}
              disabled={pending}
              onClick={() => setAdding("")}
            >
              <PlusIcon aria-hidden />
              Add package
            </Button>
          ) : (
            <div className="mt-2 flex gap-2 max-lg:flex-col">
              <Input
                ref={focusOnMount}
                aria-label="Package to add"
                aria-invalid={addProblem !== null}
                value={adding}
                spellCheck={false}
                placeholder="postgresql-client terraform"
                onChange={(event) => {
                  setAdding(event.target.value);
                  setAddProblem(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") commitAdd();
                  if (event.key === "Escape") setAdding(null);
                }}
                className={`${CONTROL} w-80 font-mono max-lg:w-full`}
              />
              <Button type="button" variant="outline" className={CONTROL} onClick={commitAdd}>
                Add
              </Button>
            </div>
          )}
          {addProblem === null ? null : (
            <p role="alert" className="mt-1.5 text-row text-destructive">
              {addProblem}
            </p>
          )}
          {rejected.length === 0 ? null : (
            <div role="alert" className="mt-3 grid gap-1 text-row">
              <p className="text-destructive">{rejectionLine(rejected.length, draft.os)}</p>
              {rejected.map((entry) => (
                <p key={entry.name}>
                  <span className="font-mono">{entry.name}</span>
                  <span className="text-muted-foreground"> · {entry.issue}</span>
                </p>
              ))}
            </div>
          )}
        </div>
        {dirty ? (
          <div
            role="group"
            aria-label="Unsaved changes"
            className="flex items-center gap-3 border-b border-border py-3 max-lg:sticky max-lg:bottom-0 max-lg:z-10 max-lg:flex-col max-lg:items-stretch max-lg:border-t max-lg:bg-background max-lg:px-4"
          >
            <div className="min-w-0 flex-1">
              <p>Unsaved changes. New projects start from it once you save.</p>
              {problem === null && save.error === null ? null : (
                <p role="alert" className="text-row text-destructive">
                  {problem ?? `Not saved. ${failureWords(save.error, "Try again.")}`}
                </p>
              )}
            </div>
            <div className="flex gap-2 max-lg:*:flex-1">
              <Button
                type="button"
                variant="outline"
                className={CONTROL}
                disabled={pending}
                onClick={discard}
              >
                Discard
              </Button>
              <Button
                type="button"
                className={CONTROL}
                disabled={pending || problem !== null}
                onClick={() => save.mutate({ workspaceImage: image })}
              >
                {pending ? <Spinner aria-hidden /> : null}
                {pending ? "Checking packages…" : "Save"}
              </Button>
            </div>
          </div>
        ) : null}
      </SettingSection>
      <SettingSection title="Workspace features">
        {draft.mode === "family" ? (
          <FeatureRow
            label="Screen for the agent"
            description="The agent gets a display it can see and click, for testing in a browser. This only works on x86_64 servers."
            checked={draft.screen}
            disabled={pending}
            onChange={(screen) => edit({ ...draft, screen })}
          />
        ) : null}
        <FeatureRow
          label="Docker inside workspaces"
          description="Sessions can run docker and docker compose."
          checked={draft.docker}
          disabled={pending}
          onChange={(docker) => edit({ ...draft, docker })}
        />
      </SettingSection>
    </>
  );
}

/** A runtime note under a control: red when it keeps Save off, muted otherwise. */
function runtimeLine(text: string | null, blocking: boolean) {
  if (text === null) return null;
  return (
    <span
      role={blocking ? "alert" : undefined}
      className={blocking ? "text-destructive" : "text-muted-foreground"}
    >
      {text}
    </span>
  );
}

function FeatureRow({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly description: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <SettingRow
      label={label}
      labelFor={id}
      description={description}
      control={<Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />}
    />
  );
}
