import { Button, buttonVariants } from "@mend/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@mend/ui/components/ui/dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@mend/ui/components/ui/empty";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@mend/ui/components/ui/sheet";
import { Spinner } from "@mend/ui/components/ui/spinner";
import { Switch } from "@mend/ui/components/ui/switch";
import { toast } from "@mend/ui/components/ui/toast";
import { cn } from "@mend/ui/lib/utils";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { EllipsisIcon, LogOutIcon, PencilIcon, PlugIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import type { McpServerDto } from "#/lib/api";
import { secretsLine, stateWords, targetLine, TRANSPORT_WORDS } from "#/lib/mcp-servers";
import { usePhone } from "#/lib/phone";
import { failureWords } from "#/lib/refusal";
import { useTRPC } from "#/lib/trpc";

import { Overlay } from "../projects/overlay.tsx";
import { SheetHandle, SheetItem } from "../sheet-item.tsx";
import { ExecutorServicesSection } from "./executor-services.tsx";
import { McpServerDialog } from "./mcp-server-dialog.tsx";
import { SettingRow, SettingSection } from "./setting-row.tsx";
import { SettingsPage } from "./settings-page.tsx";

/** What a dialog on this page is open for, if any. */
type Open =
  | { readonly kind: "add" }
  | { readonly kind: "edit"; readonly server: McpServerDto }
  | { readonly kind: "remove"; readonly server: McpServerDto }
  | { readonly kind: "forget"; readonly server: McpServerDto };

/**
 * Settings → Account → MCP servers (Doop "Settings · Account · MCP servers"): the person's own
 * servers (docs/adr/0024), each turned on or off for the sessions they start, added, edited and
 * removed here, and below them the services they reach through their own Executor link. The
 * route's loader read the list before the page drew.
 */
export function McpServersPage() {
  const trpc = useTRPC();
  const phone = usePhone();
  const { servers, limits } = useSuspenseQuery(trpc.mcpServers.list.queryOptions()).data;
  const [open, setOpen] = useState<Open | null>(null);
  const full = servers.length >= limits.servers;
  const add = (
    <Button
      type="button"
      variant={servers.length === 0 ? "default" : "outline"}
      size={phone ? "touch" : "default"}
      disabled={full}
      onClick={() => setOpen({ kind: "add" })}
      className={cn(phone && servers.length > 0 && "w-full")}
    >
      Add server…
    </Button>
  );
  const close = () => setOpen(null);
  return (
    <SettingsPage
      page="a-mcp"
      intro="Your sessions get the servers you turn on here. Other people's sessions don't get them."
    >
      <SettingSection
        title="Your servers"
        description="A server you turn off stays here, but new sessions don't get it. Codex sessions don't get SSE servers. To sign in to a server, run /mcp in a Claude session; Mend keeps the sign-in for your next sessions."
        action={servers.length === 0 ? undefined : add}
      >
        {servers.length === 0 ? (
          <Empty className="py-10">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <PlugIcon aria-hidden />
              </EmptyMedia>
              <EmptyTitle>
                <h3>No MCP servers yet</h3>
              </EmptyTitle>
              <EmptyDescription>
                Add a server to give your sessions its tools, such as Linear's issues or Sentry's
                errors.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>{add}</EmptyContent>
          </Empty>
        ) : (
          servers.map((server) => (
            <ServerRow
              key={server.id}
              server={server}
              onEdit={() => setOpen({ kind: "edit", server })}
              onRemove={() => setOpen({ kind: "remove", server })}
              onForget={() => setOpen({ kind: "forget", server })}
            />
          ))
        )}
        {full ? (
          <p className="mt-3 text-row text-muted-foreground max-lg:px-4">
            You have {servers.length} servers, the most Mend keeps. Remove one to add another.
          </p>
        ) : null}
        {phone && servers.length > 0 ? <div className="mt-4 px-4">{add}</div> : null}
      </SettingSection>
      <ExecutorServicesSection />
      <McpServerDialog
        open={open?.kind === "add" || open?.kind === "edit"}
        saved={open?.kind === "edit" ? open.server : null}
        taken={servers.map((server) => server.name)}
        onClose={close}
      />
      <RemoveServer server={open?.kind === "remove" ? open.server : null} onClose={close} />
      <ForgetSignIn server={open?.kind === "forget" ? open.server : null} onClose={close} />
    </SettingsPage>
  );
}

/**
 * One server: its name, what it reaches and what Mend sends it, then its state, its switch and
 * its "…". The switch saves at once; while it saves it shows the new position, and if the save
 * fails it goes back and says so under the row.
 */
function ServerRow({
  server,
  onEdit,
  onRemove,
  onForget,
}: {
  readonly server: McpServerDto;
  readonly onEdit: () => void;
  readonly onRemove: () => void;
  readonly onForget: () => void;
}) {
  const trpc = useTRPC();
  const phone = usePhone();
  const toggle = useMutation(
    trpc.mcpServers.save.mutationOptions({
      onSuccess: (_saved, _variables, _result, { client }) =>
        client.invalidateQueries(trpc.mcpServers.list.queryFilter()),
    }),
  );
  const enabled = toggle.isPending ? toggle.variables.server.enabled === true : server.enabled;
  const turn = (next: boolean) =>
    toggle.mutate({ name: server.name, server: { transport: server.transport, enabled: next } });
  const state = stateWords(server);
  const secrets = secretsLine(server);
  const description = [
    `${targetLine(server.transport)}.`,
    ...(secrets === null ? [] : [secrets]),
    ...(phone && state !== null ? [`${state}.`] : []),
  ].join(" ");
  return (
    <SettingRow
      label={server.name}
      description={<span className="break-words">{description}</span>}
      note={
        toggle.isError ? (
          <span role="alert" className="text-destructive">
            Mend didn't turn {server.name} {toggle.variables.server.enabled === true ? "on" : "off"}
            . {failureWords(toggle.error, "Check your connection and try again.")}{" "}
            <button
              type="button"
              className="font-medium text-foreground underline underline-offset-2"
              onClick={() => turn(toggle.variables.server.enabled === true)}
            >
              Try again
            </button>
          </span>
        ) : null
      }
      control={
        <>
          {toggle.isPending ? (
            <span role="status" className="text-row whitespace-nowrap text-muted-foreground">
              Saving…
            </span>
          ) : state === null || phone ? null : (
            <span className="text-row whitespace-nowrap text-muted-foreground">{state}</span>
          )}
          <Switch
            aria-label={`Use ${server.name} in new sessions`}
            checked={enabled}
            disabled={toggle.isPending}
            onCheckedChange={turn}
          />
          {phone ? (
            <PhoneServerActions
              server={server}
              onEdit={onEdit}
              onRemove={onRemove}
              onForget={onForget}
            />
          ) : (
            <ServerMenu server={server} onEdit={onEdit} onRemove={onRemove} onForget={onForget} />
          )}
        </>
      }
    />
  );
}

/** The row's "…" on the desk (Doop "MCP servers · server menu"). */
function ServerMenu({
  server,
  onEdit,
  onRemove,
  onForget,
}: {
  readonly server: McpServerDto;
  readonly onEdit: () => void;
  readonly onRemove: () => void;
  readonly onForget: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Actions for ${server.name}`}
        className={cn(
          buttonVariants({ variant: "ghost", size: "icon-sm" }),
          "text-muted-foreground",
        )}
      >
        <EllipsisIcon aria-hidden className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width="lg">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="truncate">{server.name}</DropdownMenuLabel>
          <DropdownMenuItem onClick={onEdit}>
            <PencilIcon aria-hidden />
            Edit server…
          </DropdownMenuItem>
          {server.signIn === null ? null : (
            <DropdownMenuItem onClick={onForget}>
              <LogOutIcon aria-hidden />
              Forget sign-in…
            </DropdownMenuItem>
          )}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={onRemove}>
          <Trash2Icon aria-hidden />
          Remove server…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The row's 44px "…" on a phone, with its action sheet (Doop "Phone · MCP servers · server menu"). */
function PhoneServerActions({
  server,
  onEdit,
  onRemove,
  onForget,
}: {
  readonly server: McpServerDto;
  readonly onEdit: () => void;
  readonly onRemove: () => void;
  readonly onForget: () => void;
}) {
  const [open, setOpen] = useState(false);
  const act = (action: () => void) => {
    setOpen(false);
    action();
  };
  const signedIn =
    server.transport._tag === "stdio"
      ? null
      : server.signIn === null
        ? "Not signed in"
        : "Signed in";
  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Actions for ${server.name}`}
        onClick={() => setOpen(true)}
        className={cn(buttonVariants({ variant: "ghost", size: "icon-touch" }), "-mr-2")}
      >
        <EllipsisIcon aria-hidden className="size-5" />
      </button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="bottom"
          className="max-h-[85dvh] gap-0 rounded-t-pop-touch pb-[env(safe-area-inset-bottom)]"
        >
          <SheetHandle />
          <SheetHeader className="border-b border-border py-2.5 pr-12 pl-5">
            <SheetTitle className="truncate text-title font-semibold">{server.name}</SheetTitle>
            <p className="truncate text-prose text-muted-foreground">
              {TRANSPORT_WORDS[server.transport._tag]}
              {signedIn === null ? "" : ` · ${signedIn}`}
            </p>
          </SheetHeader>
          <div role="menu" aria-label={`Actions for ${server.name}`} className="py-1">
            <SheetItem icon={<PencilIcon aria-hidden />} onClick={() => act(onEdit)}>
              Edit server…
            </SheetItem>
            {server.signIn === null ? null : (
              <SheetItem icon={<LogOutIcon aria-hidden />} onClick={() => act(onForget)}>
                Forget sign-in…
              </SheetItem>
            )}
            <div className="my-1 border-t border-border" />
            <SheetItem
              icon={<Trash2Icon aria-hidden className="text-destructive!" />}
              className="text-destructive"
              onClick={() => act(onRemove)}
            >
              Remove server…
            </SheetItem>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

/** Remove a server (Doop "MCP servers · remove server confirmation"), with its values and sign-in. */
function RemoveServer({
  server,
  onClose,
}: {
  readonly server: McpServerDto | null;
  readonly onClose: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const remove = useMutation(trpc.mcpServers.remove.mutationOptions());
  // Kept while the dialog animates closed, so its words don't empty out.
  const [shown, setShown] = useState(server);
  if (server !== null && server !== shown) setShown(server);
  const name = shown?.name ?? "";
  const close = () => {
    if (remove.isPending) return;
    remove.reset();
    onClose();
  };
  const confirm = async () => {
    try {
      await remove.mutateAsync({ name });
      await queryClient.invalidateQueries(trpc.mcpServers.list.queryFilter());
      toast.add({ description: `Removed ${name}. New sessions won't get it.` });
      remove.reset();
      onClose();
    } catch {
      // Said in the dialog, from the mutation's error.
    }
  };
  const extras = [
    ...(shown !== null && shown.secretNames.length > 0 ? ["its saved values"] : []),
    ...(shown?.signIn === null || shown === null ? [] : [`your ${name} sign-in`]),
  ];
  return (
    <Overlay
      open={server !== null}
      onOpenChange={(next) => (next ? undefined : close())}
      size="sm"
      title={`Remove ${name}?`}
      description={`Sessions you start from now on don't get ${name}'s tools. Sessions that are already running keep them until they finish.${
        extras.length === 0 ? "" : ` Mend also deletes ${extras.join(" and ")}.`
      }`}
      footer={
        <>
          <Button type="button" variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={remove.isPending}
            onClick={() => void confirm()}
          >
            {remove.isPending ? <Spinner aria-hidden /> : null}
            {remove.isPending ? "Removing…" : "Remove server"}
          </Button>
        </>
      }
    >
      {remove.isError ? (
        <p role="alert" className="text-row text-destructive">
          Mend didn't remove {name}.{" "}
          {failureWords(remove.error, "Check your connection and try again.")}
        </p>
      ) : null}
    </Overlay>
  );
}

/** Forget the sign-in Mend keeps for a server (docs/adr/0024, decision 5). */
function ForgetSignIn({
  server,
  onClose,
}: {
  readonly server: McpServerDto | null;
  readonly onClose: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const forget = useMutation(trpc.mcpServers.forgetSignIn.mutationOptions());
  const [shown, setShown] = useState(server);
  if (server !== null && server !== shown) setShown(server);
  const name = shown?.name ?? "";
  const close = () => {
    if (forget.isPending) return;
    forget.reset();
    onClose();
  };
  const confirm = async () => {
    try {
      await forget.mutateAsync({ name });
      await queryClient.invalidateQueries(trpc.mcpServers.list.queryFilter());
      toast.add({ description: `Mend forgot your ${name} sign-in.` });
      forget.reset();
      onClose();
    } catch {
      // Said in the dialog, from the mutation's error.
    }
  };
  return (
    <Overlay
      open={server !== null}
      onOpenChange={(next) => (next ? undefined : close())}
      size="sm"
      title={`Forget your ${name} sign-in?`}
      description="Mend deletes the sign-in it keeps, and Claude sessions you start from now on don't get it. A session that is already running keeps its own until it stops. To sign in again, run /mcp in a Claude session."
      footer={
        <>
          <Button type="button" variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={forget.isPending}
            onClick={() => void confirm()}
          >
            {forget.isPending ? <Spinner aria-hidden /> : null}
            {forget.isPending ? "Forgetting…" : "Forget sign-in"}
          </Button>
        </>
      }
    >
      {forget.isError ? (
        <p role="alert" className="text-row text-destructive">
          Mend didn't forget the sign-in.{" "}
          {failureWords(forget.error, "Check your connection and try again.")}
        </p>
      ) : null}
    </Overlay>
  );
}
