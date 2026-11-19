import { dopplerTokenIssue } from "@mend/domain/workbench";
import { Button } from "@mend/ui/components/ui/button";
import { Input } from "@mend/ui/components/ui/input";
import { Label } from "@mend/ui/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@mend/ui/components/ui/native-select";
import { Spinner } from "@mend/ui/components/ui/spinner";
import { toast } from "@mend/ui/components/ui/toast";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { InfoIcon, WorkflowIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { disconnectDopplerWords, dopplerLine, executorLine, slackLine } from "#/lib/connected-apps";
import { usePhone } from "#/lib/phone";
import { failureWords } from "#/lib/refusal";
import { useTRPC } from "#/lib/trpc";
import { useViewer } from "#/lib/use-viewer";

import { Overlay } from "../projects/overlay.tsx";
import { DopplerMark, SlackMark } from "./brand-marks.tsx";
import { SettingsPage } from "./settings-page.tsx";

/** A control's size: 32px beside a row on the desk, a 44px touch target on a phone. */
const touch = (phone: boolean) => (phone ? "touch" : "default");

/**
 * Settings → Account → Connected apps (Doop "Settings · Account · Connected apps"): the person's
 * own link to their organization's Slack and Executor, and their Doppler token (docs/adr/0025,
 * ADR 0014). The organization's apps themselves are its owners', in Integrations. No part of the
 * Doppler token is ever shown. The route's loader read all three before the page drew.
 */
export function ConnectedAppsPage() {
  const { organizationName } = useViewer();
  return (
    <SettingsPage
      page="a-apps"
      intro={`Link your own accounts so your sessions can use them as you. ${organizationName}'s owners connect the apps themselves in Integrations.`}
    >
      <div className="border-t border-border">
        <SlackRow />
        <ExecutorRow />
        <DopplerRow />
      </div>
    </SettingsPage>
  );
}

/** One app: its mark, its name and what stands, a note under that, and its buttons. */
function AppRow({
  mark,
  name,
  description,
  note,
  children,
  control,
}: {
  readonly mark: ReactNode;
  readonly name: string;
  readonly description: string;
  readonly note?: ReactNode;
  readonly children?: ReactNode;
  readonly control?: ReactNode;
}) {
  return (
    <section
      aria-label={name}
      data-slot="app-row"
      className="flex items-start gap-3 border-b border-border py-3.5 max-lg:flex-wrap max-lg:px-4"
    >
      <span className="mt-0.5 flex size-5 flex-none items-center justify-center text-foreground [&_svg]:size-4.5">
        {mark}
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="font-semibold">{name}</h2>
        <p className="mt-0.5 text-row text-pretty text-muted-foreground">{description}</p>
        {note === undefined || note === null ? null : (
          <p className="mt-1.5 flex gap-1.5 text-meta text-muted-foreground [&_svg]:mt-0.5 [&_svg]:size-3.5 [&_svg]:shrink-0">
            <InfoIcon aria-hidden />
            <span>{note}</span>
          </p>
        )}
        {children}
      </div>
      {control === undefined ? null : (
        <div className="flex flex-none items-center gap-2 max-lg:w-full max-lg:pl-8 max-lg:*:flex-1">
          {control}
        </div>
      )}
    </section>
  );
}

/** A failure under a row, in a sentence. */
function Failed({ children }: { readonly children: ReactNode }) {
  return (
    <p role="alert" className="mt-1.5 text-row text-destructive">
      {children}
    </p>
  );
}

// --- Slack ----------------------------------------------------------------------------------------

function SlackRow() {
  const trpc = useTRPC();
  const phone = usePhone();
  const { organizationName } = useViewer();
  const me = useSuspenseQuery(trpc.slack.me.queryOptions()).data;
  const [unlinking, setUnlinking] = useState(false);
  return (
    <AppRow
      mark={<SlackMark />}
      name="Slack"
      description={slackLine(me, organizationName)}
      control={
        me.link === null ? undefined : (
          <Button
            type="button"
            variant="outline"
            size={touch(phone)}
            onClick={() => setUnlinking(true)}
          >
            Unlink…
          </Button>
        )
      }
    >
      {me.link === null ? null : <DefaultProject current={me.defaultProjectId} />}
      <UnlinkSlack open={unlinking} onClose={() => setUnlinking(false)} />
    </AppRow>
  );
}

/** The project a mention runs in when it names none (slack.md `slack-default-project`). */
function DefaultProject({ current }: { readonly current: string | null }) {
  const trpc = useTRPC();
  const phone = usePhone();
  const queryClient = useQueryClient();
  const projects = useQuery(trpc.projects.list.queryOptions());
  const save = useMutation(
    trpc.slack.setDefaultProject.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries(trpc.slack.me.queryFilter()),
    }),
  );
  if (projects.isPending) return null;
  if (projects.isError) {
    return <Failed>Mend couldn't list your projects for Slack's default project.</Failed>;
  }
  const choices = projects.data.toSorted((a, b) => a.name.localeCompare(b.name));
  const value = save.isPending ? (save.variables.projectId ?? "") : (current ?? "");
  return (
    <div className="mt-3 grid gap-1.5">
      <Label htmlFor="slack-default-project" className="text-row font-medium">
        Your default project
      </Label>
      <NativeSelect
        id="slack-default-project"
        size={phone ? "field" : "default"}
        value={value}
        disabled={save.isPending}
        className="w-72 max-lg:w-full"
        onChange={(event) =>
          save.mutate({ projectId: event.target.value === "" ? null : event.target.value })
        }
      >
        <NativeSelectOption value="">None: Mend asks which project</NativeSelectOption>
        {choices.map((project) => (
          <NativeSelectOption key={project.id} value={project.id}>
            {project.visibility === "private"
              ? `${project.name} (private: direct messages only)`
              : project.name}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <p className="text-meta text-muted-foreground">
        {save.isPending
          ? "Saving…"
          : "A mention that names no project, and whose channel has none, runs here."}
      </p>
      {save.isError ? (
        <Failed>
          Mend didn't save your default project.{" "}
          {failureWords(save.error, "Check your connection and try again.")}
        </Failed>
      ) : null}
    </div>
  );
}

function UnlinkSlack({ open, onClose }: { readonly open: boolean; readonly onClose: () => void }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const unlink = useMutation(trpc.slack.unlink.mutationOptions());
  const close = () => {
    if (unlink.isPending) return;
    unlink.reset();
    onClose();
  };
  const confirm = async () => {
    try {
      await unlink.mutateAsync();
      await queryClient.invalidateQueries(trpc.slack.me.queryFilter());
      toast.add({ description: "Unlinked Slack." });
      unlink.reset();
      onClose();
    } catch {
      // Said in the dialog, from the mutation's error.
    }
  };
  return (
    <Overlay
      open={open}
      onOpenChange={(next) => (next ? undefined : close())}
      size="sm"
      title="Unlink Slack?"
      description="Slack stops acting as your Mend account. A mention from you in Slack gets a new link to confirm. Sessions you already started from Slack keep running."
      footer={
        <>
          <Button type="button" variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={unlink.isPending}
            onClick={() => void confirm()}
          >
            {unlink.isPending ? <Spinner aria-hidden /> : null}
            {unlink.isPending ? "Unlinking…" : "Unlink"}
          </Button>
        </>
      }
    >
      {unlink.isError ? (
        <p role="alert" className="text-row text-destructive">
          Mend didn't unlink Slack.{" "}
          {failureWords(unlink.error, "Check your connection and try again.")}
        </p>
      ) : null}
    </Overlay>
  );
}

// --- Executor -------------------------------------------------------------------------------------

/**
 * Your own Executor link (docs/adr/0022). Linking opens Executor's consent page; Executor sends the
 * browser back to `/executor/callback`, which finishes the link and returns here. Your link is
 * used before the organization's shared Executor account (docs/adr/0025, decision 3).
 */
function ExecutorRow() {
  const trpc = useTRPC();
  const phone = usePhone();
  const { organizationName } = useViewer();
  const status = useSuspenseQuery(trpc.executor.personal.queryOptions()).data;
  const [unlinking, setUnlinking] = useState(false);
  const begin = useMutation(
    trpc.executor.begin.mutationOptions({
      gcTime: 0,
      onSuccess: (result) => window.location.assign(result.url),
    }),
  );
  if (!status.configured) {
    return (
      <AppRow
        mark={<WorkflowIcon aria-hidden />}
        name="Executor"
        description={`${organizationName} hasn't set up Executor. An owner sets it up in Integrations.`}
      />
    );
  }
  const linked = status.link.state === "active";
  return (
    <AppRow
      mark={<WorkflowIcon aria-hidden />}
      name="Executor"
      description={executorLine(status.link.state, organizationName)}
      note={`Mend uses your link before ${organizationName}'s shared Executor account.`}
      control={
        linked ? (
          <Button
            type="button"
            variant="outline"
            size={touch(phone)}
            onClick={() => setUnlinking(true)}
          >
            Unlink…
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            size={touch(phone)}
            disabled={begin.isPending}
            onClick={() => begin.mutate({ target: "person" })}
          >
            {begin.isPending ? <Spinner aria-hidden /> : null}
            {status.link.state === "refused" ? "Link again" : "Link"}
          </Button>
        )
      }
    >
      {begin.isError ? (
        <Failed>Executor didn't start the link. {failureWords(begin.error, "Try again.")}</Failed>
      ) : null}
      <UnlinkExecutor open={unlinking} onClose={() => setUnlinking(false)} />
    </AppRow>
  );
}

function UnlinkExecutor({
  open,
  onClose,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { organizationName } = useViewer();
  const unlink = useMutation(trpc.executor.unlink.mutationOptions());
  const close = () => {
    if (unlink.isPending) return;
    unlink.reset();
    onClose();
  };
  const confirm = async () => {
    try {
      await unlink.mutateAsync({ target: "person" });
      await queryClient.invalidateQueries(trpc.executor.pathFilter());
      toast.add({ description: "Unlinked Executor." });
      unlink.reset();
      onClose();
    } catch {
      // Said in the dialog, from the mutation's error.
    }
  };
  return (
    <Overlay
      open={open}
      onOpenChange={(next) => (next ? undefined : close())}
      size="sm"
      title="Unlink Executor?"
      description={`Your sessions use ${organizationName}'s shared Executor account from now on. Services only you added stay in Executor until you link again.`}
      footer={
        <>
          <Button type="button" variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={unlink.isPending}
            onClick={() => void confirm()}
          >
            {unlink.isPending ? <Spinner aria-hidden /> : null}
            {unlink.isPending ? "Unlinking…" : "Unlink"}
          </Button>
        </>
      }
    >
      {unlink.isError ? (
        <p role="alert" className="text-row text-destructive">
          Mend didn't unlink Executor. {failureWords(unlink.error, "Try again.")}
        </p>
      ) : null}
    </Overlay>
  );
}

// --- Doppler --------------------------------------------------------------------------------------

/**
 * The person's one Doppler token (ADR 0014): connect, replace, disconnect. The token is never
 * shown, and Mend doesn't check it when it is saved. The config is picked per project, under
 * "Only you" in that project's settings.
 */
function DopplerRow() {
  const trpc = useTRPC();
  const phone = usePhone();
  const status = useSuspenseQuery(trpc.doppler.status.queryOptions()).data;
  const [open, setOpen] = useState<"connect" | "replace" | "disconnect" | null>(null);
  return (
    <AppRow
      mark={<DopplerMark />}
      name="Doppler"
      description={dopplerLine(status)}
      note={
        status.connected
          ? "You pick the config for each project in that project's settings, under Only you."
          : null
      }
      control={
        status.connected ? (
          <>
            <Button
              type="button"
              variant="outline"
              size={touch(phone)}
              onClick={() => setOpen("replace")}
            >
              Replace token…
            </Button>
            <Button
              type="button"
              variant="ghost"
              size={touch(phone)}
              onClick={() => setOpen("disconnect")}
            >
              Disconnect…
            </Button>
          </>
        ) : (
          <Button
            type="button"
            variant="outline"
            size={touch(phone)}
            onClick={() => setOpen("connect")}
          >
            Connect…
          </Button>
        )
      }
    >
      <DopplerToken
        mode={open === "connect" || open === "replace" ? open : null}
        onClose={() => setOpen(null)}
      />
      <DisconnectDoppler
        open={open === "disconnect"}
        picked={status.mappings.length}
        onClose={() => setOpen(null)}
      />
    </AppRow>
  );
}

/** Connect Doppler, or replace its token: one field, never filled in, emptied when it closes. */
function DopplerToken({
  mode,
  onClose,
}: {
  readonly mode: "connect" | "replace" | null;
  readonly onClose: () => void;
}) {
  const [shown, setShown] = useState(mode);
  if (mode !== null && mode !== shown) setShown(mode);
  return (
    <Overlay
      open={mode !== null}
      onOpenChange={(next) => (next ? undefined : onClose())}
      size="md"
      title={shown === "replace" ? "Replace Doppler token" : "Connect Doppler"}
      description={
        shown === "replace"
          ? "This applies to sessions you start from now on."
          : "Your sessions get the Doppler CLI in each project where you pick a config."
      }
      footer={null}
    >
      {mode === null ? null : <TokenForm replacing={mode === "replace"} onClose={onClose} />}
    </Overlay>
  );
}

function TokenForm({
  replacing,
  onClose,
}: {
  readonly replacing: boolean;
  readonly onClose: () => void;
}) {
  const trpc = useTRPC();
  const phone = usePhone();
  const queryClient = useQueryClient();
  const [token, setToken] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  // It carries the token: gone from the mutation cache once nothing shows its result.
  const connect = useMutation(trpc.doppler.connect.mutationOptions({ gcTime: 0 }));
  const submit = async () => {
    const issue = dopplerTokenIssue(token);
    if (issue !== null) {
      setProblem("Paste a Doppler token, with no spaces or line breaks.");
      return;
    }
    try {
      await connect.mutateAsync({ token });
      setToken("");
      await queryClient.invalidateQueries(trpc.doppler.status.queryFilter());
      toast.add({ description: replacing ? "Replaced your Doppler token." : "Connected Doppler." });
      onClose();
    } catch {
      // Said under the field, from the mutation's error.
    }
  };
  return (
    <form
      noValidate
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor="doppler-token">Doppler token</Label>
        <Input
          id="doppler-token"
          type="password"
          value={token}
          placeholder="dp.ct.… or dp.st.…"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={problem !== null}
          className="h-9 font-mono max-lg:h-11 max-lg:text-base"
          onChange={(event) => {
            setToken(event.target.value);
            setProblem(null);
          }}
        />
        <p className="text-meta text-muted-foreground">
          A personal token or a service token. Mend encrypts it and never shows it again.
        </p>
      </div>
      {problem === null ? null : (
        <p role="alert" className="text-row text-destructive">
          {problem}
        </p>
      )}
      {connect.isError ? (
        <p role="alert" className="text-row text-destructive">
          Mend didn't save the token.{" "}
          {failureWords(connect.error, "Check your connection and try again.")}
        </p>
      ) : null}
      <div className="flex justify-end gap-2.5 pt-1 max-lg:*:flex-1">
        <Button
          type="button"
          variant="outline"
          size={touch(phone)}
          disabled={connect.isPending}
          onClick={onClose}
        >
          Cancel
        </Button>
        <Button type="submit" size={touch(phone)} disabled={connect.isPending || token === ""}>
          {connect.isPending ? <Spinner aria-hidden /> : null}
          {replacing ? "Replace token" : "Connect"}
        </Button>
      </div>
    </form>
  );
}

function DisconnectDoppler({
  open,
  picked,
  onClose,
}: {
  readonly open: boolean;
  readonly picked: number;
  readonly onClose: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const disconnect = useMutation(trpc.doppler.disconnect.mutationOptions());
  // Counted when the dialog opened, so the words don't change as it closes.
  const [count, setCount] = useState(picked);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setCount(picked);
  }
  const close = () => {
    if (disconnect.isPending) return;
    disconnect.reset();
    onClose();
  };
  const confirm = async () => {
    try {
      await disconnect.mutateAsync();
      await queryClient.invalidateQueries(trpc.doppler.status.queryFilter());
      toast.add({ description: "Disconnected Doppler." });
      disconnect.reset();
      onClose();
    } catch {
      // Said in the dialog, from the mutation's error.
    }
  };
  return (
    <Overlay
      open={open}
      onOpenChange={(next) => (next ? undefined : close())}
      size="sm"
      title="Disconnect Doppler?"
      description={disconnectDopplerWords(count)}
      footer={
        <>
          <Button type="button" variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={disconnect.isPending}
            onClick={() => void confirm()}
          >
            {disconnect.isPending ? <Spinner aria-hidden /> : null}
            {disconnect.isPending ? "Disconnecting…" : "Disconnect"}
          </Button>
        </>
      }
    >
      {disconnect.isError ? (
        <p role="alert" className="text-row text-destructive">
          Mend didn't disconnect Doppler. {failureWords(disconnect.error, "Try again.")}
        </p>
      ) : null}
    </Overlay>
  );
}
