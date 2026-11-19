import type {
  ExecutorServiceConnection,
  ExecutorServiceDirectory,
  ExecutorServiceRequirement,
} from "@mend/domain/workbench";
import { Button, buttonVariants } from "@mend/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@mend/ui/components/ui/dropdown-menu";
import { Input } from "@mend/ui/components/ui/input";
import { Label } from "@mend/ui/components/ui/label";
import { Spinner } from "@mend/ui/components/ui/spinner";
import { toast } from "@mend/ui/components/ui/toast";
import { cn } from "@mend/ui/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { EllipsisIcon } from "lucide-react";
import { useState } from "react";

import { usePhone } from "#/lib/phone";
import { failureWords } from "#/lib/refusal";
import { useTRPC } from "#/lib/trpc";
import { useViewer } from "#/lib/use-viewer";

import { Overlay } from "../projects/overlay.tsx";
import { SettingRow, SettingSection } from "./setting-row.tsx";
import { settingsLink } from "./settings-links.tsx";

type Service = (typeof ExecutorServiceDirectory.Type.services)[number];
type Requirement = typeof ExecutorServiceRequirement.Type;
type Method = Requirement["methods"][number];
type Connection = typeof ExecutorServiceConnection.Type;
/** Whose services: a person's own link, or the organization's shared account (Mend's member). */
type Target = "person" | "member";

/** A control's height: 32px beside a row on the desk, a 44px touch target on a phone. */
const touch = (phone: boolean) => (phone ? "touch" : "default");

/**
 * The services a person reaches through their own Executor link (docs/adr/0022), below their own
 * MCP servers: added only for them, and signed in to with their own accounts. Signing in opens the
 * service's own page; Executor sends the browser back to `/executor/service-callback`, which
 * finishes the sign-in and returns here. Every Executor request goes through Mend's server.
 *
 * With no Executor set up for the organization there is nothing to show. Without the person's own
 * link, the section says where to link it; with an Executor of the organization's own, the person
 * manages their services there.
 */
export function ExecutorServicesSection() {
  const trpc = useTRPC();
  const personal = useQuery(trpc.executor.personal.queryOptions(undefined, { retry: false }));
  if (personal.isPending) return null;
  if (personal.isError) {
    return (
      <SettingSection title="Executor services">
        <SettingRow
          label="Your services"
          description={`Mend couldn't read your Executor link. ${failureWords(personal.error, "Try again.")}`}
          control={
            <Button type="button" variant="outline" onClick={() => void personal.refetch()}>
              Try again
            </Button>
          }
        />
      </SettingSection>
    );
  }
  const status = personal.data;
  if (!status.configured) return null;
  if (status.link.state !== "active") return <NotLinked />;
  if (status.url !== null) {
    return (
      <SettingSection title="Executor services">
        <SettingRow
          label="Your services"
          description="You add services and sign in to them in Executor itself. Your sessions use them through your Executor link."
          control={
            <a
              href={status.url}
              target="_blank"
              rel="noreferrer"
              className={buttonVariants({ variant: "outline" })}
            >
              Open Executor
            </a>
          }
        />
      </SettingSection>
    );
  }
  return <Directory target="person" />;
}

/**
 * The organization's shared services (docs/adr/0022), on Integrations: added once for everyone and
 * signed in to with the organization's shared accounts, through the Executor account Mend made for
 * it. An owner shares a service someone added only for the shared account with everyone.
 */
export function SharedExecutorServices() {
  return <Directory target="member" />;
}

function NotLinked() {
  const { organizationName } = useViewer();
  return (
    <SettingSection title="Executor services">
      <SettingRow
        layout="stack"
        label="Your services"
        description={`Link your own Executor account to add services only you see. Until then, your sessions use ${organizationName}'s shared Executor account.`}
        control={
          <Link {...settingsLink("a-apps")} className={buttonVariants({ variant: "outline" })}>
            Connected apps
          </Link>
        }
      />
    </SettingSection>
  );
}

/** What there is to do: sign in to a requirement, or use an account already in Executor. */
type Opened =
  | { readonly kind: "add" }
  | {
      readonly kind: "sign-in";
      readonly service: Service;
      readonly requirement: Requirement;
      readonly method: Method;
    }
  | {
      readonly kind: "disconnect";
      readonly service: Service;
      readonly requirement: Requirement;
      readonly account: Requirement["accounts"][number];
    };

function Directory({ target }: { readonly target: Target }) {
  const trpc = useTRPC();
  const phone = usePhone();
  const { organizationName } = useViewer();
  const directory = useQuery(trpc.executor.directory.queryOptions({ target }, { retry: false }));
  const [opened, setOpened] = useState<Opened | null>(null);
  const add = (
    <Button
      type="button"
      variant="outline"
      size={touch(phone)}
      className={cn(phone && "w-full")}
      onClick={() => setOpened({ kind: "add" })}
    >
      Add service…
    </Button>
  );
  return (
    <SettingSection
      title={target === "person" ? "Executor services" : "Shared services"}
      description={
        target === "person"
          ? "Services only you see, which your sessions reach through your Executor link. Each one uses the account you sign in with here."
          : `Services everyone in ${organizationName} reaches when they have no Executor link of their own. Accounts you sign in with here are shared with everyone.`
      }
      action={add}
    >
      {directory.isPending ? (
        <p role="status" className="py-3.5 text-row text-muted-foreground max-lg:px-4">
          {target === "person"
            ? "Reading your services from Executor…"
            : "Reading the shared services from Executor…"}
        </p>
      ) : directory.isError ? (
        <p role="alert" className="py-3.5 text-row text-destructive max-lg:px-4">
          Executor didn't list {target === "person" ? "your" : "the shared"} services.{" "}
          {failureWords(directory.error, "Try again.")}{" "}
          <button
            type="button"
            className="font-medium text-foreground underline underline-offset-2"
            onClick={() => void directory.refetch()}
          >
            Try again
          </button>
        </p>
      ) : directory.data.services.length === 0 ? (
        <p className="py-3.5 text-row text-muted-foreground max-lg:px-4">
          {target === "person"
            ? "No services yet. Add one to give your sessions its tools through Executor."
            : "No shared services yet. Mend adds none by itself; add one to give everyone's sessions its tools."}
        </p>
      ) : (
        directory.data.services.map((service) => (
          <ServiceRow key={service.id} target={target} service={service} onOpen={setOpened} />
        ))
      )}
      {phone ? <div className="mt-4 px-4">{add}</div> : null}
      <AddService target={target} open={opened?.kind === "add"} onClose={() => setOpened(null)} />
      <SignIn
        target={target}
        opened={opened?.kind === "sign-in" ? opened : null}
        onClose={() => setOpened(null)}
      />
      <Disconnect
        target={target}
        opened={opened?.kind === "disconnect" ? opened : null}
        onClose={() => setOpened(null)}
      />
    </SettingSection>
  );
}

const usable = (requirement: Requirement): ReadonlyArray<Method> =>
  requirement.methods.filter((method) => method.kind !== "unsupported");

/** What one requirement stands at, in a sentence. */
const requirementWords = (requirement: Requirement, many: boolean): string => {
  const linked = requirement.accounts.find((account) => account.linked);
  const what = many ? ` for ${requirement.name}` : "";
  if (linked !== undefined) return `Signed in${what} as ${linked.label || "your account"}.`;
  if (usable(requirement).length === 0)
    return `Mend can't sign you in${what}. Sign in in Executor.`;
  return `Not signed in${what}.`;
};

function ServiceRow({
  target,
  service,
  onOpen,
}: {
  readonly target: Target;
  readonly service: Service;
  readonly onOpen: (opened: Opened) => void;
}) {
  const trpc = useTRPC();
  const phone = usePhone();
  const queryClient = useQueryClient();
  const useAccount = useMutation(
    trpc.executor.useServiceAccount.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries(trpc.executor.pathFilter()),
      onError: (error) =>
        toast.add({
          description: `Executor didn't switch the account for ${service.name}. ${failureWords(error, "Try again.")}`,
          priority: "high",
        }),
    }),
  );
  const share = useMutation(
    trpc.executor.shareService.mutationOptions({
      onSuccess: () => {
        toast.add({ description: `Shared ${service.name} with everyone.` });
        return queryClient.invalidateQueries(trpc.executor.pathFilter());
      },
      onError: (error) =>
        toast.add({
          description: `Executor didn't share ${service.name}. ${failureWords(error, "Try again.")}`,
          priority: "high",
        }),
    }),
  );
  const many = service.requirements.length > 1;
  const accounts =
    service.requirements.length === 0
      ? "No account needed."
      : service.requirements.map((requirement) => requirementWords(requirement, many)).join(" ");
  const description =
    target === "member"
      ? `${service.shared ? "Shared with everyone." : "Only the shared account has it."} ${accounts}`
      : accounts;
  // The first requirement nobody is signed in to, and how to sign in to it, is the row's button.
  const pending = service.requirements.find(
    (requirement) =>
      !requirement.accounts.some((account) => account.linked) && usable(requirement).length > 0,
  );
  const method = pending === undefined ? undefined : usable(pending)[0];
  const menu = service.requirements.flatMap((requirement) => [
    ...requirement.accounts
      .filter((account) => !account.linked)
      .map((account) => ({
        key: `use-${requirement.name}-${account.id}`,
        label: `Use ${account.label || "another account"}`,
        act: () =>
          useAccount.mutate({
            target,
            service: service.id,
            requirement: requirement.name,
            account: account.id,
          }),
      })),
    ...usable(requirement)
      .filter((other) => requirement !== pending || other !== method)
      .map((other) => ({
        key: `method-${requirement.name}-${other.name}`,
        label: `Sign in with ${other.label}…`,
        act: () => onOpen({ kind: "sign-in", service, requirement, method: other }),
      })),
    ...requirement.accounts
      .filter((account) => account.canDisconnect)
      .map((account) => ({
        key: `disconnect-${requirement.name}-${account.id}`,
        label: `Disconnect ${account.label || "this account"}…`,
        act: () => onOpen({ kind: "disconnect", service, requirement, account }),
      })),
  ]);
  return (
    <SettingRow
      label={service.name}
      description={description}
      control={
        <>
          {target === "member" && !service.shared ? (
            <Button
              type="button"
              variant="outline"
              size={phone ? "touch" : "sm"}
              disabled={share.isPending}
              aria-label={`Share ${service.name} with everyone`}
              onClick={() => share.mutate({ service: service.id })}
            >
              {share.isPending ? <Spinner aria-hidden /> : null}
              Share with everyone
            </Button>
          ) : null}
          {pending === undefined || method === undefined ? null : (
            <Button
              type="button"
              variant="outline"
              size={phone ? "touch" : "sm"}
              onClick={() => onOpen({ kind: "sign-in", service, requirement: pending, method })}
            >
              Sign in…
            </Button>
          )}
          {menu.length === 0 ? null : (
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label={`Actions for ${service.name}`}
                disabled={useAccount.isPending}
                className={cn(
                  buttonVariants({ variant: "ghost", size: phone ? "icon-touch" : "icon-sm" }),
                  "text-muted-foreground",
                )}
              >
                {useAccount.isPending ? (
                  <Spinner aria-hidden />
                ) : (
                  <EllipsisIcon aria-hidden className="size-4" />
                )}
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" width="lg">
                {menu.map((item) => (
                  <DropdownMenuItem key={item.key} onClick={item.act}>
                    {item.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </>
      }
    />
  );
}

/**
 * Sign in to a service (Doop "MCP servers · sign in dialog"). An OAuth sign-in opens the service's
 * page in this tab, and Executor brings the browser back here; a sign-in by fields asks for them
 * here and sends them to Executor through Mend's server, which never returns them.
 */
function SignIn({
  target,
  opened,
  onClose,
}: {
  readonly target: Target;
  readonly opened: Extract<Opened, { kind: "sign-in" }> | null;
  readonly onClose: () => void;
}) {
  const [shown, setShown] = useState(opened);
  if (opened !== null && opened !== shown) setShown(opened);
  const name = shown?.service.name ?? "";
  return (
    <Overlay
      open={opened !== null}
      onOpenChange={(next) => (next ? undefined : onClose())}
      size="sm"
      title={`Sign in to ${name}`}
      description={
        shown?.method.kind === "fields"
          ? `Fill in what ${name} asks for. Mend sends it to Executor and never shows it again.`
          : `Mend opens ${name}'s sign-in page. When you're done, it brings you back here.`
      }
      footer={null}
    >
      {opened === null ? null : (
        <SignInBody
          key={`${opened.service.id}-${opened.method.name}`}
          target={target}
          opened={opened}
          onClose={onClose}
        />
      )}
    </Overlay>
  );
}

function SignInBody({
  target,
  opened: { service, requirement, method },
  onClose,
}: {
  readonly target: Target;
  readonly opened: Extract<Opened, { kind: "sign-in" }>;
  readonly onClose: () => void;
}) {
  const trpc = useTRPC();
  const phone = usePhone();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<Connection | null>(null);
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  const connect = useMutation(trpc.executor.connectService.mutationOptions({ gcTime: 0 }));
  const submit = useMutation(trpc.executor.submitService.mutationOptions({ gcTime: 0 }));
  const done = async () => {
    await queryClient.invalidateQueries(trpc.executor.pathFilter());
    toast.add({
      description:
        target === "person"
          ? `Signed in to ${service.name}. Your new sessions can use its tools.`
          : `Signed in to ${service.name} with the shared account. Everyone's new sessions can use its tools.`,
    });
    onClose();
  };
  const start = async () => {
    try {
      const result = await connect.mutateAsync({
        target,
        service: service.id,
        requirement: requirement.name,
        method: method.name,
      });
      if (result.url !== null) window.location.assign(result.url);
      else if (result.completed) await done();
      else setForm(result);
    } catch {
      // Said in the dialog, from the mutation's error.
    }
  };
  const send = async () => {
    if (form?.id === null || form === null) return;
    try {
      await submit.mutateAsync({ id: form.id, fields: values });
      setValues({});
      await done();
    } catch {
      // Said in the dialog, from the mutation's error.
    }
  };
  const busy = connect.isPending || submit.isPending;
  const error = connect.error ?? submit.error;
  return (
    <form
      noValidate
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void (form === null ? start() : send());
      }}
    >
      {form === null ? (
        method.kind === "oauth" ? (
          <ol className="grid list-decimal gap-2 pl-5 text-prose">
            <li>Sign in with the account your sessions should use.</li>
            <li>Approve the access {service.name} asks for.</li>
            <li>
              {target === "person"
                ? "Executor keeps the sign-in for your link. Only your sessions use it."
                : "Executor keeps the sign-in for the shared account. Everyone's sessions use it."}
            </li>
          </ol>
        ) : null
      ) : (
        form.fields.map((field) => (
          <div key={field.name} className="grid gap-1.5">
            <Label htmlFor={`executor-field-${field.name}`}>{field.label}</Label>
            <Input
              id={`executor-field-${field.name}`}
              type={field.secret ? "password" : "text"}
              autoComplete="off"
              required={field.required}
              value={values[field.name] ?? ""}
              className="h-9 max-lg:h-11 max-lg:text-base"
              onChange={(event) => setValues({ ...values, [field.name]: event.target.value })}
            />
          </div>
        ))
      )}
      {error === null ? null : (
        <p role="alert" className="text-row text-destructive">
          Mend didn't sign you in to {service.name}. {failureWords(error, "Try again.")}
        </p>
      )}
      <div className="flex justify-end gap-2.5 pt-1 max-lg:*:flex-1">
        <Button
          type="button"
          variant="outline"
          size={touch(phone)}
          disabled={busy}
          onClick={onClose}
        >
          Cancel
        </Button>
        <Button type="submit" size={touch(phone)} disabled={busy}>
          {busy ? <Spinner aria-hidden /> : null}
          {form !== null ? "Sign in" : method.kind === "oauth" ? "Open sign-in page" : "Continue"}
        </Button>
      </div>
    </form>
  );
}

function Disconnect({
  target,
  opened,
  onClose,
}: {
  readonly target: Target;
  readonly opened: Extract<Opened, { kind: "disconnect" }> | null;
  readonly onClose: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const disconnect = useMutation(trpc.executor.disconnectService.mutationOptions());
  const [shown, setShown] = useState(opened);
  if (opened !== null && opened !== shown) setShown(opened);
  const service = shown?.service.name ?? "";
  const account = shown?.account.label || "this account";
  const close = () => {
    if (disconnect.isPending) return;
    disconnect.reset();
    onClose();
  };
  const confirm = async () => {
    if (shown === null) return;
    try {
      await disconnect.mutateAsync({
        target,
        service: shown.service.id,
        requirement: shown.requirement.name,
        account: shown.account.id,
      });
      await queryClient.invalidateQueries(trpc.executor.pathFilter());
      toast.add({ description: `Disconnected ${account} from ${service}.` });
      disconnect.reset();
      onClose();
    } catch {
      // Said in the dialog, from the mutation's error.
    }
  };
  return (
    <Overlay
      open={opened !== null}
      onOpenChange={(next) => (next ? undefined : close())}
      size="sm"
      title={`Disconnect ${account}?`}
      description={`Executor deletes this sign-in. Every service that uses ${account} loses it, ${service} included.`}
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
          Executor didn't disconnect it. {failureWords(disconnect.error, "Try again.")}
        </p>
      ) : null}
    </Overlay>
  );
}

/** Add a service, by its MCP address: only this person's, or shared with everyone. */
function AddService({
  target,
  open,
  onClose,
}: {
  readonly target: Target;
  readonly open: boolean;
  readonly onClose: () => void;
}) {
  return (
    <Overlay
      open={open}
      onOpenChange={(next) => (next ? undefined : onClose())}
      size="md"
      title="Add service"
      description={
        target === "person"
          ? "A service only you see, reached through your Executor link. It must allow anyone to connect or offer a sign-in."
          : "A service everyone reaches through the shared account. It must allow anyone to connect or offer a sign-in."
      }
      footer={null}
    >
      {open ? <AddServiceForm target={target} onClose={onClose} /> : null}
    </Overlay>
  );
}

function AddServiceForm({
  target,
  onClose,
}: {
  readonly target: Target;
  readonly onClose: () => void;
}) {
  const trpc = useTRPC();
  const phone = usePhone();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const add = useMutation(trpc.executor.addService.mutationOptions());
  const ready = name.trim() !== "" && url.trim() !== "";
  const submit = async () => {
    if (!ready) return;
    try {
      await add.mutateAsync({ target, name: name.trim(), url: url.trim() });
      await queryClient.invalidateQueries(trpc.executor.pathFilter());
      toast.add({ description: `Added ${name.trim()}. Sign in to it if it asks.` });
      onClose();
    } catch {
      // Said under the form, from the mutation's error.
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
        <Label htmlFor="executor-service-name">Name</Label>
        <Input
          id="executor-service-name"
          value={name}
          maxLength={120}
          autoComplete="off"
          placeholder="Sentry"
          className="h-9 max-lg:h-11 max-lg:text-base"
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="executor-service-url">MCP address</Label>
        <Input
          id="executor-service-url"
          type="url"
          value={url}
          spellCheck={false}
          autoComplete="off"
          placeholder="https://mcp.sentry.dev/mcp"
          className="h-9 font-mono max-lg:h-11 max-lg:text-base"
          onChange={(event) => setUrl(event.target.value)}
        />
      </div>
      {add.isError ? (
        <p role="alert" className="text-row text-destructive">
          Executor didn't add the service.{" "}
          {failureWords(add.error, "Check the address and try again.")}
        </p>
      ) : null}
      <div className="flex justify-end gap-2.5 pt-1 max-lg:*:flex-1">
        <Button
          type="button"
          variant="outline"
          size={touch(phone)}
          disabled={add.isPending}
          onClick={onClose}
        >
          Cancel
        </Button>
        <Button type="submit" size={touch(phone)} disabled={add.isPending || !ready}>
          {add.isPending ? <Spinner aria-hidden /> : null}
          {add.isPending ? "Adding…" : "Add service"}
        </Button>
      </div>
    </form>
  );
}
