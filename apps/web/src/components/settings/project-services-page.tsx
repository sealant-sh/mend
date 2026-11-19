import type { ProjectPreviewView } from "@mend/api-contracts";
import { WorktreeId } from "@mend/domain";
import { Banner, InlineAlert } from "@mend/ui/components/banner";
import { Button } from "@mend/ui/components/ui/button";
import {
  CodeBlock,
  CodeBlockContent,
  CodeBlockHeader,
  CodeBlockTitle,
} from "@mend/ui/components/ui/code-block";
import { RadioGroup, RadioGroupItem } from "@mend/ui/components/ui/radio-group";
import { toast } from "@mend/ui/components/ui/toast";
import { cn } from "@mend/ui/lib/utils";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { FileCodeIcon } from "lucide-react";
import { type RefObject, useId, useRef, useState } from "react";

import type { ProjectDetailDto } from "#/lib/api";
import { usePhone } from "#/lib/phone";
import {
  changedWords,
  currentChoice,
  type PreviewChoice,
  previewChoices,
  previewHost,
  previewLine,
} from "#/lib/project-services";
import { readOnlyLine, type ProjectPeople } from "#/lib/project-settings";
import { failureWords } from "#/lib/refusal";
import { useTRPC } from "#/lib/trpc";
import { useProjectSettings } from "#/lib/use-project-settings";

import { Overlay } from "../projects/overlay.tsx";
import { QueryView } from "../query-view.tsx";
import { SettingRow, SettingSection } from "./setting-row.tsx";
import { SettingsPage } from "./settings-page.tsx";

/** A control's height: the frames' 36px on the desk, a 44px touch target on a phone. */
const CONTROL = "h-9 max-lg:h-11 max-lg:text-base";

/**
 * Settings → a project → Services (Doop "Settings · Project · checkout-api · Services"): the
 * project's `.mend/mend.toml` as its default branch holds it, read-only (anyone who can commit
 * changes it, in a session), and the fixed preview address with the worktree it shows. Recipes
 * saved in the database and their "Shadowed" rows are gone (ruling D8, docs/adr/0025).
 *
 * Mend reads the file's Services only inside a session, so the page shows the file itself rather
 * than the frame's table of Services, until the server can read them for a project.
 */
export function ProjectServicesPage({ projectId }: { readonly projectId: string }) {
  const trpc = useTRPC();
  const phone = usePhone();
  const { detail, people } = useProjectSettings(projectId);
  const { project } = detail;
  const file = useSuspenseQuery(trpc.projects.mendToml.queryOptions({ id: projectId })).data;
  const preview = useQuery(trpc.previews.project.queryOptions({ id: projectId }));
  return (
    <SettingsPage
      page="p-services"
      project={{ id: project.id, name: project.name }}
      intro={`These are the services Mend starts in each ${project.name} session, and where the preview points.`}
      banner={
        <Banner
          title="Read-only here."
          icon={<FileCodeIcon />}
          layout={phone ? "stacked" : "inline"}
        >
          Mend reads these from .mend/mend.toml on each session's branch. To change them, edit the
          file in a session.
        </Banner>
      }
    >
      <SettingSection
        title="Services"
        description={
          file === null ? (
            <>
              <span className="font-mono">{project.defaultBranch}</span> has no .mend/mend.toml.
            </>
          ) : (
            <>
              This is the file on <span className="font-mono">{project.defaultBranch}</span>.
            </>
          )
        }
      >
        {file === null ? (
          <p className="border-b border-border py-3.5 text-row text-muted-foreground max-lg:px-4">
            A branch without .mend/mend.toml starts no services. A setup session, from the General
            page, can write one.
          </p>
        ) : (
          <div className="py-3.5 max-lg:px-4">
            <CodeBlock size="sm">
              <CodeBlockHeader>
                <CodeBlockTitle className="font-mono">{file.path}</CodeBlockTitle>
              </CodeBlockHeader>
              {file.contents === null ? (
                <p className="px-3 py-3 text-row text-muted-foreground">
                  The file isn't text, so Mend can't show it.
                </p>
              ) : (
                <CodeBlockContent lineNumbers aria-label={file.path}>
                  {file.contents}
                </CodeBlockContent>
              )}
            </CodeBlock>
            {file.truncated ? (
              <p className="mt-2 text-row text-muted-foreground">
                This is the first 1 MiB of the file.
              </p>
            ) : null}
          </div>
        )}
      </SettingSection>
      <SettingSection title="Preview">
        <QueryView query={preview}>
          {(read: ProjectPreviewView) => (
            <FixedPreviewRow detail={detail} people={people} read={read} />
          )}
        </QueryView>
      </SettingSection>
    </SettingsPage>
  );
}

/**
 * The fixed preview address: what it shows now, and Change worktree… for whoever the server lets
 * manage it (`canManage`); everyone else reads who can.
 */
function FixedPreviewRow({
  detail,
  people,
  read,
}: {
  readonly detail: ProjectDetailDto;
  readonly people: ProjectPeople;
  readonly read: ProjectPreviewView;
}) {
  const trpc = useTRPC();
  const members = useQuery(trpc.organization.members.queryOptions());
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const choices = previewChoices({
    defaultBranch: detail.project.defaultBranch,
    worktrees: detail.worktrees,
    sessions: detail.sessions,
    members: members.status === "success" ? members.data : [],
  });
  return (
    <>
      <SettingRow
        layout="stack"
        label="Fixed preview address"
        description={previewLine(read, choices)}
        note={
          read.canManage || !read.configured ? null : (
            <span className="text-muted-foreground">{readOnlyLine(people)}</span>
          )
        }
        control={
          read.canManage && read.configured ? (
            <Button
              ref={trigger}
              type="button"
              variant="outline"
              className={CONTROL}
              onClick={() => setOpen(true)}
            >
              Change worktree…
            </Button>
          ) : undefined
        }
      />
      {read.canManage && read.configured ? (
        <ChangeWorktree
          open={open}
          onOpenChange={setOpen}
          projectId={detail.project.id}
          read={read}
          choices={choices}
          finalFocus={trigger}
        />
      ) : null}
    </>
  );
}

/**
 * Change preview worktree (Doop "change preview worktree dialog", a sheet on a phone): the
 * project's worktrees and its default branch, the current one marked. Changing it moves the
 * address for everyone who opens it.
 */
function ChangeWorktree({
  open,
  onOpenChange,
  projectId,
  read,
  choices,
  finalFocus,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly projectId: string;
  readonly read: ProjectPreviewView;
  readonly choices: ReadonlyArray<PreviewChoice>;
  readonly finalFocus: RefObject<HTMLButtonElement | null>;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const phone = usePhone();
  const ids = useId();
  const current = currentChoice(read);
  // Null until the person picks: the dialog starts on what the address shows now.
  const [picked, setPicked] = useState<string | null>(null);
  const chosen = picked ?? current;
  const use = useMutation(
    trpc.previews.use.mutationOptions({
      onSuccess: () =>
        Promise.all([
          queryClient.invalidateQueries(trpc.previews.project.queryFilter({ id: projectId })),
          queryClient.invalidateQueries(trpc.projects.detail.queryFilter({ id: projectId })),
        ]),
    }),
  );
  const choice = choices.find(
    (entry) => (entry.kind === "default" ? "default" : entry.id) === chosen,
  );
  const size = phone ? "touch" : "default";
  const close = (next: boolean) => {
    if (use.isPending) return;
    if (!next) {
      setPicked(null);
      use.reset();
    }
    onOpenChange(next);
  };
  const host = read.url === null ? "The preview address" : previewHost(read.url);
  return (
    <Overlay
      open={open}
      onOpenChange={close}
      title="Change preview worktree"
      description={`${host} will show ${read.fixed?.preview.serviceName ?? "the preview"} from the worktree you pick. Everyone who opens the address sees the change.`}
      size="md"
      finalFocus={finalFocus}
      footer={
        <>
          <Button
            variant="outline"
            size={size}
            disabled={use.isPending}
            onClick={() => close(false)}
          >
            Cancel
          </Button>
          <Button
            size={size}
            disabled={use.isPending || choice === undefined || chosen === current}
            onClick={() => {
              if (choice === undefined) return;
              use.mutate(
                {
                  id: projectId,
                  target:
                    choice.kind === "default"
                      ? { _tag: "Default" }
                      : { _tag: "Worktree", worktreeId: WorktreeId.make(choice.id) },
                },
                {
                  onSuccess: () => {
                    toast.add({ description: changedWords(choice) });
                    setPicked(null);
                    onOpenChange(false);
                  },
                },
              );
            }}
          >
            {use.isPending ? "Changing…" : "Change worktree"}
          </Button>
        </>
      }
    >
      <RadioGroup
        aria-label="Worktree"
        value={chosen ?? ""}
        onValueChange={(value: unknown) => {
          if (typeof value === "string") setPicked(value);
        }}
        className="gap-0 border-y border-border"
      >
        {choices.map((entry) => {
          const value = entry.kind === "default" ? "default" : entry.id;
          const id = `${ids}-${value}`;
          return (
            <label
              key={value}
              htmlFor={id}
              className={cn(
                "flex cursor-pointer items-start gap-3 border-b border-border py-3 last:border-b-0",
                phone && "min-h-11",
              )}
            >
              <RadioGroupItem id={id} value={value} className="mt-0.5" />
              <span className="min-w-0 flex-1">
                <span className="block">
                  {entry.kind === "default" ? "Default branch" : entry.label}
                  {value === current ? (
                    <span className="text-row text-muted-foreground"> · Current</span>
                  ) : null}
                </span>
                <span className="block truncate text-row text-muted-foreground">
                  <span className="font-mono">{entry.branch}</span>
                  {entry.kind === "default"
                    ? " · Mend keeps a worktree of it for the preview"
                    : entry.facts === null
                      ? ""
                      : ` · ${entry.facts}`}
                </span>
              </span>
            </label>
          );
        })}
      </RadioGroup>
      {use.isError ? (
        <InlineAlert size={size} title="The preview didn't move.">
          {failureWords(use.error, "Mend didn't answer. Try again.")}
        </InlineAlert>
      ) : null}
    </Overlay>
  );
}
