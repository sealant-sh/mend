import { InlineAlert } from "@mend/ui/components/banner";
import { Button } from "@mend/ui/components/ui/button";
import { Input } from "@mend/ui/components/ui/input";
import { Label } from "@mend/ui/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@mend/ui/components/ui/native-select";
import { Spinner } from "@mend/ui/components/ui/spinner";
import { toast } from "@mend/ui/components/ui/toast";
import {
  skipToken,
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";
import { useState } from "react";

import type { ProjectDto } from "#/lib/api";
import {
  clearedWords,
  clearLine,
  dopplerChooser,
  dopplerPick,
  dopplerRow,
  dopplerSavedWords,
  dopplerSaveProblem,
  type MemoryNote,
  noteFacts,
  notesLine,
  notesWords,
  noteText,
} from "#/lib/only-you";
import { usePhone } from "#/lib/phone";
import { failureWords } from "#/lib/refusal";
import { useTRPC } from "#/lib/trpc";
import { useProjectSettings } from "#/lib/use-project-settings";

import { Overlay } from "../projects/overlay.tsx";
import { SettingRow, SettingSection } from "./setting-row.tsx";
import { SettingsPage } from "./settings-page.tsx";

const LINK = "text-primary underline-offset-2 hover:underline";

/**
 * Settings → a project → Only you (Doop "Settings · Project · checkout-api · Only you"): what is the
 * signed-in person's alone in this project (docs/adr/0025): the agent's memory of it, which their
 * sessions receive and save (agent-memory.md `memory-list`, `memory-show`, `memory-remove`, on the
 * web for the first time), and the Doppler config the project uses for them (doppler.md
 * `doppler-use`). Everything here is read and written as the signed-in person, so nobody, an owner
 * included, can open anyone else's. Their Doppler token lives on Connected apps; no part of it is
 * shown here. The route's loader read the memory and the Doppler status.
 */
export function OnlyYouPage({ projectId }: { readonly projectId: string }) {
  const { detail } = useProjectSettings(projectId);
  const { project } = detail;
  return (
    <SettingsPage
      page="p-only-you"
      project={{ id: project.id, name: project.name }}
      intro={`These are yours, in ${project.name} only. Other people who open ${project.name} don't see them.`}
    >
      <MemorySection project={project} />
      <DopplerSection project={project} />
    </SettingsPage>
  );
}

// --- Agent memory -------------------------------------------------------------------------------

/**
 * The person's agent memory here: how many notes and when the agent last changed one, View notes…
 * (each note, its words, and Remove), and Clear memory…. The frame's "Remember between sessions"
 * switch waits on the server: memory always goes with the person's sessions today.
 */
function MemorySection({ project }: { readonly project: ProjectDto }) {
  const trpc = useTRPC();
  const phone = usePhone();
  const memory = useSuspenseQuery(trpc.memory.list.queryOptions({ id: project.id })).data;
  const [open, setOpen] = useState<"notes" | "clear" | null>(null);
  const now = new Date();
  const size = phone ? "touch" : "default";
  const empty = memory.files.length === 0;
  return (
    <SettingSection
      title="Agent memory"
      description={`The agent keeps notes about ${project.name} between your sessions, such as how to run the tests and what you asked it to avoid.`}
    >
      <SettingRow
        layout="stack"
        label="Notes"
        description={notesLine(memory.files, project.name, now)}
        control={
          empty ? undefined : (
            <>
              <Button type="button" variant="outline" size={size} onClick={() => setOpen("notes")}>
                View notes…
              </Button>
              <Button type="button" variant="ghost" size={size} onClick={() => setOpen("clear")}>
                Clear memory…
              </Button>
            </>
          )
        }
      />
      <NotesDialog
        project={project}
        notes={memory.files}
        open={open === "notes"}
        onClose={() => setOpen(null)}
      />
      <ClearMemoryDialog
        project={project}
        count={memory.files.length}
        open={open === "clear"}
        onClose={() => setOpen(null)}
      />
    </SettingSection>
  );
}

/**
 * View notes…: every note with its agent, size and what last changed it; choosing one shows its
 * words, with Remove…, which asks before it removes. Mend keeps the last version on the server.
 */
function NotesDialog({
  project,
  notes,
  open,
  onClose,
}: {
  readonly project: ProjectDto;
  readonly notes: ReadonlyArray<MemoryNote>;
  readonly open: boolean;
  readonly onClose: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const phone = usePhone();
  const [shown, setShown] = useState<MemoryNote | null>(null);
  const [removing, setRemoving] = useState(false);
  const file = useQuery(
    trpc.memory.file.queryOptions(
      shown === null ? skipToken : { id: project.id, path: shown.path },
    ),
  );
  const remove = useMutation(
    trpc.memory.remove.mutationOptions({
      onSuccess: async () => {
        toast.add({
          description: `Removed ${shown?.name ?? "the note"}. Mend keeps its last version.`,
        });
        await queryClient.invalidateQueries(trpc.memory.list.queryFilter({ id: project.id }));
        setRemoving(false);
        setShown(null);
      },
    }),
  );
  const close = () => {
    if (remove.isPending) return;
    remove.reset();
    setRemoving(false);
    setShown(null);
    onClose();
  };
  const size = phone ? "touch" : "default";
  const now = new Date();
  const back = () => {
    remove.reset();
    setRemoving(false);
    setShown(null);
  };
  const title =
    shown === null
      ? `Notes about ${project.name}`
      : removing
        ? `Remove ${shown.name}?`
        : shown.name;
  const description =
    shown === null
      ? `${notesWords(notes.length)}. Your sessions in ${project.name} start with these.`
      : removing
        ? "Your next sessions here start without it. Mend keeps its last version on the server."
        : noteFacts(shown, now);
  return (
    <Overlay
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      title={title}
      description={description}
      size="lg"
      footer={
        shown === null ? (
          <Button type="button" variant="outline" size={size} onClick={close}>
            Close
          </Button>
        ) : removing ? (
          <>
            <Button
              type="button"
              variant="outline"
              size={size}
              disabled={remove.isPending}
              onClick={() => setRemoving(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              size={size}
              disabled={remove.isPending}
              onClick={() => remove.mutate({ id: project.id, path: shown.path })}
            >
              {remove.isPending ? <Spinner aria-hidden /> : null}
              {remove.isPending ? "Removing…" : "Remove note"}
            </Button>
          </>
        ) : (
          <>
            <Button type="button" variant="outline" size={size} onClick={back}>
              <ArrowLeftIcon aria-hidden />
              All notes
            </Button>
            <Button type="button" variant="outline" size={size} onClick={() => setRemoving(true)}>
              Remove…
            </Button>
          </>
        )
      }
    >
      {shown === null ? (
        notes.length === 0 ? (
          <p className="text-muted-foreground">No notes left.</p>
        ) : (
          <ul aria-label="Notes" className="-mx-1 grid">
            {notes.map((note) => (
              <li key={note.path} className="border-b border-border last:border-b-0">
                <button
                  type="button"
                  onClick={() => setShown(note)}
                  className="grid w-full gap-0.5 rounded-md px-1 py-2.5 text-left outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 max-lg:py-3"
                >
                  <span className="font-mono text-meta font-semibold break-all">{note.name}</span>
                  <span className="text-meta text-muted-foreground">{noteFacts(note, now)}</span>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : removing ? (
        remove.isError ? (
          <InlineAlert title={`Mend didn't remove ${shown.name}.`}>
            {failureWords(remove.error, "Check your connection and try again.")}
          </InlineAlert>
        ) : null
      ) : file.status === "pending" ? (
        <p role="status" className="text-muted-foreground">
          Reading {shown.name}…
        </p>
      ) : file.status === "error" ? (
        <InlineAlert title={`Mend couldn't read ${shown.name}.`}>
          {failureWords(file.error, "Check your connection and try again.")}{" "}
          <button type="button" className={LINK} onClick={() => void file.refetch()}>
            Try again
          </button>
        </InlineAlert>
      ) : noteText(file.data) === null ? (
        <p className="text-muted-foreground">
          This note isn&apos;t text, so Mend can&apos;t show it here.
        </p>
      ) : (
        <pre className="max-h-[50dvh] overflow-auto rounded-lg bg-muted p-3 font-mono text-meta whitespace-pre-wrap">
          {noteText(file.data)}
        </pre>
      )}
    </Overlay>
  );
}

/**
 * Clear memory…: removes every note, each through the API's own remove (one router procedure; the
 * API has no route for all at once). A note it can't remove keeps the dialog open, naming it.
 */
function ClearMemoryDialog({
  project,
  count,
  open,
  onClose,
}: {
  readonly project: ProjectDto;
  readonly count: number;
  readonly open: boolean;
  readonly onClose: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const phone = usePhone();
  const [partial, setPartial] = useState<string | null>(null);
  const clear = useMutation(
    trpc.memory.clear.mutationOptions({
      onSuccess: async (result) => {
        await queryClient.invalidateQueries(trpc.memory.list.queryFilter({ id: project.id }));
        const { done, words } = clearedWords(result);
        if (done) {
          toast.add({ description: words });
          setPartial(null);
          onClose();
        } else {
          setPartial(words);
        }
      },
    }),
  );
  const close = () => {
    if (clear.isPending) return;
    clear.reset();
    setPartial(null);
    onClose();
  };
  const size = phone ? "touch" : "default";
  return (
    <Overlay
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      title="Clear memory?"
      description={clearLine(count, project.name)}
      size="sm"
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            size={size}
            disabled={clear.isPending}
            onClick={close}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            size={size}
            disabled={clear.isPending}
            onClick={() => clear.mutate({ id: project.id })}
          >
            {clear.isPending ? <Spinner aria-hidden /> : null}
            {clear.isPending ? "Clearing…" : "Clear memory"}
          </Button>
        </>
      }
    >
      {partial !== null ? (
        <InlineAlert title="Some notes are still there.">{partial}</InlineAlert>
      ) : clear.isError ? (
        <InlineAlert title="Mend didn't clear your memory.">
          {failureWords(clear.error, "Check your connection and try again.")}
        </InlineAlert>
      ) : null}
    </Overlay>
  );
}

// --- Doppler ------------------------------------------------------------------------------------

/**
 * The Doppler config this project uses for the person: Change… or Choose… opens the picker. With no
 * Doppler token, the row has no control and links to Connected apps, where the token lives.
 */
function DopplerSection({ project }: { readonly project: ProjectDto }) {
  const trpc = useTRPC();
  const phone = usePhone();
  const status = useSuspenseQuery(trpc.doppler.status.queryOptions()).data;
  const [choosing, setChoosing] = useState(false);
  const row = dopplerRow(status, project.id);
  const size = phone ? "touch" : "default";
  const appsLink = (
    <Link to="/settings/connected-apps" className={LINK}>
      Connected apps
    </Link>
  );
  return (
    <SettingSection
      title="Doppler"
      description={
        <>
          Mend sets up the Doppler CLI in your workspace with the config you pick here, so{" "}
          <code className="font-mono text-meta">doppler run --</code> … works for you and your
          agent. Mend never reads the secrets, and a session starts even when Doppler can&apos;t be
          reached.
        </>
      }
    >
      <SettingRow
        layout="stack"
        label="Doppler config"
        description={
          row.kind === "not-connected"
            ? "You haven't connected Doppler, so there's nothing to pick yet."
            : phone
              ? // The phone frame puts the config under the label, and Change… under it.
                row.kind === "picked"
                ? `${row.dopplerProject} / ${row.config}`
                : "None"
              : `The Doppler project and config for your sessions in ${project.name}.`
        }
        control={
          row.kind === "not-connected" ? undefined : (
            <>
              <span className="font-mono text-meta text-muted-foreground max-lg:hidden">
                {row.kind === "picked" ? (
                  `${row.dopplerProject} / ${row.config}`
                ) : (
                  <span className="font-sans text-row">None</span>
                )}
              </span>
              <Button type="button" variant="outline" size={size} onClick={() => setChoosing(true)}>
                {row.kind === "picked" ? "Change…" : "Choose…"}
              </Button>
            </>
          )
        }
      />
      <p className="pt-3 text-row text-muted-foreground max-lg:px-4">
        {row.kind === "not-connected" ? (
          <>
            Connect Doppler in {appsLink} to pick a config for {project.name}.
          </>
        ) : (
          <>Uses your Doppler token from {appsLink}.</>
        )}
      </p>
      {row.kind === "not-connected" ? null : (
        <DopplerConfigDialog
          // A fresh dialog each time it opens, starting from what is saved.
          key={choosing ? "open" : "closed"}
          project={project}
          saved={dopplerPick(status, project.id)}
          open={choosing}
          onClose={() => setChoosing(false)}
        />
      )}
    </SettingSection>
  );
}

/**
 * The Doppler config dialog: a Doppler project and a config from the lists Doppler gives the
 * person's token, or typed when it won't list them. Stop using Doppler here removes the pick.
 */
function DopplerConfigDialog({
  project,
  saved,
  open,
  onClose,
}: {
  readonly project: ProjectDto;
  readonly saved: { readonly dopplerProject: string; readonly config: string } | null;
  readonly open: boolean;
  readonly onClose: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const phone = usePhone();
  const [dopplerProject, setDopplerProject] = useState(saved?.dopplerProject ?? "");
  const [config, setConfig] = useState(saved?.config ?? "");
  const [problem, setProblem] = useState<string | null>(null);
  const projects = useQuery({
    ...trpc.doppler.projects.queryOptions(),
    enabled: open,
    retry: false,
  });
  const configs = useQuery({
    ...trpc.doppler.configs.queryOptions(
      dopplerProject === "" || projects.status !== "success"
        ? skipToken
        : { project: dopplerProject },
    ),
    enabled: open,
    retry: false,
  });
  const chooser = dopplerChooser(
    projects.status,
    dopplerProject === "" || projects.status !== "success" ? "idle" : configs.status,
  );
  const refresh = () => queryClient.invalidateQueries(trpc.doppler.status.queryFilter());
  const use = useMutation(
    trpc.doppler.use.mutationOptions({
      onSuccess: async (mapping) => {
        await refresh();
        toast.add({
          description: dopplerSavedWords(project.name, mapping.dopplerProject, mapping.config),
        });
        onClose();
      },
    }),
  );
  const stop = useMutation(
    trpc.doppler.removeMapping.mutationOptions({
      onSuccess: async () => {
        await refresh();
        toast.add({
          description: `Sessions you start in ${project.name} from now on don't use Doppler.`,
        });
        onClose();
      },
    }),
  );
  const pending = use.isPending || stop.isPending;
  const save = () => {
    const issue = dopplerSaveProblem(dopplerProject, config);
    setProblem(issue);
    if (issue !== null || pending) return;
    use.mutate({
      projectId: project.id,
      dopplerProject: dopplerProject.trim(),
      config: config.trim(),
    });
  };
  const size = phone ? "touch" : "default";
  const field = phone ? "h-11 text-base" : "";
  const typedProject = chooser.kind === "type-both";
  const typedConfig = chooser.kind === "type-both" || chooser.kind === "type-config";
  const failure = use.isError
    ? `Mend didn't save the config. ${failureWords(use.error, "Check your connection and try again.")}`
    : stop.isError
      ? `Mend didn't stop using Doppler here. ${failureWords(stop.error, "Check your connection and try again.")}`
      : problem;
  return (
    <Overlay
      open={open}
      onOpenChange={(next) => {
        if (!next && !pending) onClose();
      }}
      title="Doppler config"
      description={`This applies to sessions you start in ${project.name} from now on.`}
      size="md"
      footer={
        <>
          <Button type="button" variant="outline" size={size} disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="doppler-config" size={size} disabled={pending}>
            {use.isPending ? <Spinner aria-hidden /> : null}
            {use.isPending ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <form
        id="doppler-config"
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        {typedProject ? (
          <InlineAlert tone="info" title="Doppler didn't list your projects.">
            A service token may not be allowed to list them. Type the names instead.
          </InlineAlert>
        ) : chooser.kind === "type-config" ? (
          <InlineAlert tone="info" title="Doppler didn't list this project's configs.">
            Type the config&apos;s name instead.
          </InlineAlert>
        ) : null}
        {chooser.kind === "loading" ? (
          <p role="status" className="text-muted-foreground">
            Asking Doppler for your projects…
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-3 max-lg:grid-cols-1">
            <div className="grid gap-1.5">
              <Label htmlFor="doppler-project">Doppler project</Label>
              {typedProject ? (
                <Input
                  id="doppler-project"
                  value={dopplerProject}
                  placeholder="checkout"
                  autoComplete="off"
                  spellCheck={false}
                  className={`font-mono ${field}`}
                  onChange={(event) => {
                    setDopplerProject(event.target.value);
                    setProblem(null);
                  }}
                />
              ) : (
                <NativeSelect
                  id="doppler-project"
                  size="field"
                  className="w-full font-mono"
                  value={dopplerProject}
                  onChange={(event) => {
                    setDopplerProject(event.target.value);
                    setConfig("");
                    setProblem(null);
                  }}
                >
                  <NativeSelectOption value="">Choose a project</NativeSelectOption>
                  {(projects.data?.projects ?? []).map((entry) => (
                    <NativeSelectOption key={entry.id} value={entry.id}>
                      {entry.name}
                    </NativeSelectOption>
                  ))}
                  {saved !== null &&
                  !(projects.data?.projects ?? []).some(
                    (entry) => entry.id === saved.dopplerProject,
                  ) ? (
                    <NativeSelectOption value={saved.dopplerProject}>
                      {saved.dopplerProject}
                    </NativeSelectOption>
                  ) : null}
                </NativeSelect>
              )}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="doppler-config-name">Config</Label>
              {typedConfig ? (
                <Input
                  id="doppler-config-name"
                  value={config}
                  placeholder="dev"
                  autoComplete="off"
                  spellCheck={false}
                  className={`font-mono ${field}`}
                  onChange={(event) => {
                    setConfig(event.target.value);
                    setProblem(null);
                  }}
                />
              ) : (
                <NativeSelect
                  id="doppler-config-name"
                  size="field"
                  className="w-full font-mono"
                  value={config}
                  disabled={dopplerProject === "" || configs.status === "pending"}
                  onChange={(event) => {
                    setConfig(event.target.value);
                    setProblem(null);
                  }}
                >
                  <NativeSelectOption value="">
                    {configs.status === "pending" && dopplerProject !== ""
                      ? "Reading configs…"
                      : "Choose a config"}
                  </NativeSelectOption>
                  {(configs.data?.configs ?? []).map((entry) => (
                    <NativeSelectOption key={entry.name} value={entry.name}>
                      {entry.name}
                    </NativeSelectOption>
                  ))}
                  {saved !== null &&
                  saved.dopplerProject === dopplerProject &&
                  !(configs.data?.configs ?? []).some((entry) => entry.name === saved.config) ? (
                    <NativeSelectOption value={saved.config}>{saved.config}</NativeSelectOption>
                  ) : null}
                </NativeSelect>
              )}
            </div>
          </div>
        )}
        {chooser.kind === "pick" ? (
          <p className="text-row text-muted-foreground">
            These are the projects and configs your Doppler token can see.
          </p>
        ) : null}
        {saved === null ? null : (
          <div>
            <Button
              type="button"
              variant="link"
              disabled={pending}
              onClick={() => stop.mutate({ projectId: project.id })}
            >
              {stop.isPending ? "Stopping…" : "Stop using Doppler here"}
            </Button>
          </div>
        )}
        {failure === null ? null : (
          <p role="alert" className="text-row text-destructive">
            {failure}
          </p>
        )}
      </form>
    </Overlay>
  );
}
