import type { AccessKeyView, DeviceView, WorkspaceSshKey } from "@mend/api-contracts";
import { InlineAlert } from "@mend/ui/components/banner";
import { CopyField } from "@mend/ui/components/copy-field";
import { Segmented } from "@mend/ui/components/segmented";
import { Button } from "@mend/ui/components/ui/button";
import { Input } from "@mend/ui/components/ui/input";
import { toast } from "@mend/ui/components/ui/toast";
import { cn } from "@mend/ui/lib/utils";
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import {
  CodeIcon,
  InfoIcon,
  KeyRoundIcon,
  MonitorIcon,
  ServerIcon,
  SmartphoneIcon,
  TerminalIcon,
} from "lucide-react";
import { type ReactNode, useId, useState } from "react";

import {
  EXPIRY_OPTIONS,
  type Expiry,
  expiresCell,
  expiryDays,
  expiryLine,
  groupCode,
  lastUsed,
  pairingPayload,
  platformLabel,
  removalLine,
  shortDay,
  shownKeyLine,
} from "#/lib/devices";
import { requestFailure } from "#/lib/git-access";
import { pairingQrUrl } from "#/lib/pairing-qr";
import { usePhone } from "#/lib/phone";
import { useTRPC } from "#/lib/trpc";
import { useSecond } from "#/lib/use-second";

import { useOrigin } from "../agent-login-panels.tsx";
import { Overlay } from "../projects/overlay.tsx";
import { SettingSection } from "./setting-row.tsx";
import { SettingsPage } from "./settings-page.tsx";

const CONTROL = "max-lg:h-11 max-lg:text-base";

/**
 * Settings → Account → Devices and access keys (Doop "Settings · Account · Devices and access
 * keys"): pairing a phone, the devices signed in as the person, their access keys, and the SSH
 * keys that open a shell in their workspaces. Each is the person's own (docs/adr/0025). A secret
 * (a pairing code, a token, an access key) is shown once, in the dialog that made it, and gone
 * from the page when it closes.
 */
export function DevicesPage() {
  const phone = usePhone();
  return (
    <SettingsPage
      page="a-devices"
      intro="These phones, computers, editors and scripts can use Mend as you. When you revoke one, it stops working straight away."
    >
      {phone ? null : <PairSection />}
      <DevicesSection phone={phone} />
      <AccessKeysSection phone={phone} />
      <SshKeysSection phone={phone} />
    </SettingsPage>
  );
}

/** One row of a list: an icon, a name with a line under it, columns, and the row's button. */
function ListRow({
  icon,
  name,
  sub,
  cells,
  action,
}: {
  readonly icon: ReactNode;
  readonly name: string;
  readonly sub: ReactNode;
  /** The row's columns on the desk, each with the column's name as its key. */
  readonly cells: ReadonlyArray<{ readonly key: string; readonly node: ReactNode }>;
  readonly action: ReactNode;
}) {
  return (
    <li className="flex items-center gap-3 border-b border-border py-3 max-lg:px-4 [&_svg]:size-4 [&_svg]:shrink-0">
      <span aria-hidden className="text-muted-foreground max-lg:hidden">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{name}</p>
        <div className="truncate text-row text-muted-foreground">{sub}</div>
      </div>
      {cells.map((cell) => (
        <div key={cell.key} className="w-44 flex-none text-row max-lg:hidden">
          {cell.node}
        </div>
      ))}
      <div className="flex w-24 flex-none justify-end max-lg:w-auto">{action}</div>
    </li>
  );
}

/** Column heads over a list, on the desk only. */
function ListHead({ heads }: { readonly heads: ReadonlyArray<string> }) {
  const [first, ...rest] = heads;
  return (
    <div
      aria-hidden
      className="flex items-center gap-3 border-b border-border py-2 text-row text-muted-foreground max-lg:hidden"
    >
      <span className="w-4" />
      <span className="flex-1">{first}</span>
      {rest.map((head) => (
        <span key={head} className="w-44 flex-none">
          {head}
        </span>
      ))}
      <span className="w-24 flex-none" />
    </div>
  );
}

/**
 * Pair a phone: a code minted on request (it works once, for a few minutes), shown as a QR and as
 * text for the Mend app to claim. A device that can't scan gets a token made by hand instead.
 */
function PairSection() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const origin = useOrigin();
  const now = useSecond();
  const [byHand, setByHand] = useState(false);
  const mint = useMutation(
    // The code is a credential: gone from the mutation cache once nothing shows it.
    trpc.devices.createPairing.mutationOptions({
      gcTime: 0,
      onSettled: () => queryClient.invalidateQueries(trpc.devices.list.queryFilter()),
    }),
  );
  const pairing = mint.data;
  const url = pairing === undefined ? origin : (pairing.urls[0] ?? origin);
  const qr = useQuery(
    queryOptions({
      queryKey: ["pairing-qr", pairing?.code ?? "", url],
      queryFn: () => pairingQrUrl(pairingPayload(url, pairing?.code ?? "")),
      enabled: pairing !== undefined,
      staleTime: Number.POSITIVE_INFINITY,
      gcTime: 0,
    }),
  );
  const expiresAt = pairing === undefined ? null : new Date(pairing.expiresAt);
  const expired = expiresAt !== null && expiresAt.getTime() <= now.getTime();
  const minutesLeft =
    expiresAt === null ? 0 : Math.max(1, Math.ceil((expiresAt.getTime() - now.getTime()) / 60_000));
  return (
    <SettingSection title="Pair a phone">
      <div className="flex items-start gap-4 border-b border-border py-4">
        <div
          role="img"
          aria-label={
            pairing === undefined ? "No pairing code yet" : `QR code for ${groupCode(pairing.code)}`
          }
          className={cn(
            "grid size-24 flex-none place-items-center overflow-hidden rounded-lg border border-border",
            pairing === undefined || expired ? "bg-muted" : "bg-white",
          )}
        >
          {pairing === undefined || expired ? (
            <SmartphoneIcon aria-hidden className="size-6 text-muted-foreground" />
          ) : qr.isPending ? (
            <span className="text-meta text-muted-foreground">Drawing…</span>
          ) : qr.isError ? (
            <span className="text-meta text-muted-foreground">No QR</span>
          ) : (
            <img src={qr.data} alt="" className="size-full" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-semibold">Scan this code with the Mend app</p>
          <p className="mt-0.5 text-row text-pretty text-muted-foreground">
            Open Mend on your phone, tap Pair with a server, and scan the code. If you can't scan
            it, type the code instead.
          </p>
          {pairing === undefined ? null : expired ? (
            <p className="mt-2 text-row text-muted-foreground">
              This code expired. Make a new one.
            </p>
          ) : (
            <>
              <p className="mt-2 font-mono text-title tracking-widest">{groupCode(pairing.code)}</p>
              <p className="mt-1 text-row text-muted-foreground">
                It works once and expires at{" "}
                {expiresAt?.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}, in{" "}
                {minutesLeft} {minutesLeft === 1 ? "minute" : "minutes"}. The phone reaches this
                server at {url}.
              </p>
            </>
          )}
          {mint.isError ? (
            <p role="alert" className="mt-2 text-row text-destructive">
              Mend didn't make a code. {requestFailure(mint.error)}
            </p>
          ) : null}
          <p className="mt-2 text-row text-muted-foreground">
            Can't scan a code on that device?{" "}
            <Button variant="link" className="h-auto p-0 text-row" onClick={() => setByHand(true)}>
              Make a token by hand
            </Button>
          </p>
        </div>
        <Button variant="outline" disabled={mint.isPending} onClick={() => mint.mutate()}>
          {mint.isPending
            ? "Making a code…"
            : pairing === undefined
              ? "Show a code"
              : "Make a new code"}
        </Button>
      </div>
      {byHand ? <TokenByHand onClose={() => setByHand(false)} /> : null}
    </SettingSection>
  );
}

/**
 * A device token made by hand, for a device that can't scan a code: named, then shown once with
 * the address to type beside it. Mend keeps only its hash; closing the dialog drops it.
 */
function TokenByHand({ onClose }: { readonly onClose: () => void }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const origin = useOrigin();
  const phone = usePhone();
  const formId = useId();
  const nameId = useId();
  const [name, setName] = useState("");
  const mint = useMutation(
    trpc.devices.create.mutationOptions({
      // It carries a credential: gone from the mutation cache once nothing shows it.
      gcTime: 0,
      onSuccess: () => queryClient.invalidateQueries(trpc.devices.list.queryFilter()),
    }),
  );
  const minted = mint.data;
  const close = () => {
    mint.reset();
    onClose();
  };
  return (
    <Overlay
      open
      onOpenChange={(next) => {
        if (!next && !mint.isPending) close();
      }}
      size="md"
      title={
        minted === undefined ? "Make a token by hand" : `Copy the token for ${minted.device.name}`
      }
      description={
        minted === undefined
          ? "For a device that can't scan a code. You type the token into the Mend app, and the device shows in your list like a paired one."
          : "This is the only time Mend shows it. In the Mend app, enter this server's address and the token by hand. Revoke the device to end it."
      }
      footer={
        minted === undefined ? (
          <>
            <Button variant="outline" className={CONTROL} disabled={mint.isPending} onClick={close}>
              Cancel
            </Button>
            <Button type="submit" form={formId} className={CONTROL} disabled={mint.isPending}>
              {mint.isPending ? "Making…" : "Make token"}
            </Button>
          </>
        ) : (
          <Button className={CONTROL} onClick={close}>
            Done
          </Button>
        )
      }
    >
      {minted === undefined ? (
        <form
          id={formId}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = name.trim();
            mint.mutate({
              name: trimmed === "" ? "Token made by hand" : trimmed,
              platform: "other",
            });
          }}
        >
          <label htmlFor={nameId} className="mb-2 block font-medium">
            Device name
          </label>
          <Input
            id={nameId}
            value={name}
            placeholder="Test iPhone"
            autoFocus
            className="h-9 max-lg:h-11 max-lg:text-base"
            onChange={(event) => setName(event.target.value)}
          />
          {mint.isError ? (
            <InlineAlert title="Mend didn't make the token." className="mt-3">
              {requestFailure(mint.error)}
            </InlineAlert>
          ) : null}
        </form>
      ) : (
        <div className="grid gap-3">
          <p className="font-medium">Server address</p>
          {(minted.urls.length === 0 ? [origin] : minted.urls).map((url) => (
            <CopyField
              key={url}
              value={url}
              label="Copy address"
              size={phone ? "touch" : "default"}
            />
          ))}
          <p className="font-medium">Token</p>
          <CopyField value={minted.token} label="Copy token" size={phone ? "touch" : "default"} />
        </div>
      )}
    </Overlay>
  );
}

const DEVICE_ICONS: Readonly<Record<string, ReactNode>> = {
  ios: <SmartphoneIcon />,
  android: <SmartphoneIcon />,
  cli: <TerminalIcon />,
  desktop: <MonitorIcon />,
  web: <MonitorIcon />,
  other: <ServerIcon />,
};

/** The devices signed in as the person, each with Revoke, which names it. */
function DevicesSection({ phone }: { readonly phone: boolean }) {
  const trpc = useTRPC();
  const devices = useSuspenseQuery(trpc.devices.list.queryOptions()).data;
  const now = useSecond();
  const [revoking, setRevoking] = useState<DeviceView | null>(null);
  return (
    <SettingSection
      title="Signed-in devices"
      description={
        <>
          The mend CLI and editors show up here after you run{" "}
          <code className="font-mono text-meta">mend login</code> or sign in from the editor.
        </>
      }
    >
      {devices.length === 0 ? (
        <p className="border-b border-border py-3 text-row text-muted-foreground max-lg:px-4">
          No device is signed in as you yet.
        </p>
      ) : (
        <>
          <ListHead heads={["Device", "Last used", "Added"]} />
          <ul aria-label="Signed-in devices">
            {devices.map((device) => (
              <ListRow
                key={device.id}
                icon={DEVICE_ICONS[device.platform] ?? <CodeIcon />}
                name={device.name}
                sub={
                  phone
                    ? `${platformLabel(device.platform)}. Used ${lastUsed(device.lastUsedAt, now, "never").toLowerCase()}, added ${shortDay(device.createdAt, now)}.`
                    : platformLabel(device.platform)
                }
                cells={[
                  { key: "used", node: lastUsed(device.lastUsedAt, now, "Not used yet") },
                  { key: "added", node: shortDay(device.createdAt, now) },
                ]}
                action={
                  <Button
                    variant="outline"
                    size={phone ? "touch" : "sm"}
                    aria-label={`Revoke ${device.name}`}
                    onClick={() => setRevoking(device)}
                  >
                    Revoke…
                  </Button>
                }
              />
            ))}
          </ul>
        </>
      )}
      {phone ? (
        <p className="flex gap-1.5 py-3 text-row text-muted-foreground max-lg:px-4 [&_svg]:mt-0.5 [&_svg]:size-3.5 [&_svg]:shrink-0">
          <InfoIcon aria-hidden />
          To pair a phone, open Devices and access keys in Mend on your computer and scan the code
          it shows.
        </p>
      ) : null}
      {revoking === null ? null : (
        <RevokeDevice device={revoking} onClose={() => setRevoking(null)} />
      )}
    </SettingSection>
  );
}

function RevokeDevice({
  device,
  onClose,
}: {
  readonly device: DeviceView;
  readonly onClose: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const revoke = useMutation(
    trpc.devices.revoke.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries(trpc.devices.list.queryFilter());
        toast.add({ description: `Revoked ${device.name}.`, priority: "low" });
        onClose();
      },
    }),
  );
  const app = device.platform === "ios" || device.platform === "android";
  return (
    <Overlay
      open
      onOpenChange={(next) => {
        if (!next && !revoke.isPending) onClose();
      }}
      size="sm"
      title={`Revoke ${device.name}?`}
      description={
        app
          ? `The Mend app on ${device.name} signs out straight away and stops getting notifications. To use it again, pair it with a new code.`
          : `${device.name} stops working with Mend straight away. To use it again, sign it in again.`
      }
      footer={
        <>
          <Button
            variant="outline"
            className={CONTROL}
            disabled={revoke.isPending}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            className={CONTROL}
            disabled={revoke.isPending}
            onClick={() => revoke.mutate({ id: device.id })}
          >
            {revoke.isPending ? "Revoking…" : "Revoke device"}
          </Button>
        </>
      }
    >
      {revoke.isError ? (
        <InlineAlert title="Mend didn't revoke it.">{requestFailure(revoke.error)}</InlineAlert>
      ) : null}
    </Overlay>
  );
}

/** The person's access keys: created here, shown once, revoked here (ADR 0023). */
function AccessKeysSection({ phone }: { readonly phone: boolean }) {
  const trpc = useTRPC();
  const keys = useSuspenseQuery(trpc.accessKeys.list.queryOptions()).data;
  const now = useSecond();
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<AccessKeyView | null>(null);
  return (
    <SettingSection
      title="Access keys"
      description="Your scripts and tools use an access key to call Mend as you. A key can't change logins or keys, create invitations or open the server's operator pages."
      action={
        keys.length === 0 ? undefined : (
          <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
            Create access key…
          </Button>
        )
      }
    >
      {keys.length === 0 ? (
        <div className="flex flex-col items-center gap-1.5 border-b border-border px-4 py-12 text-center [&_svg]:size-5">
          <KeyRoundIcon aria-hidden className="text-muted-foreground" />
          <p className="font-semibold">No access keys yet</p>
          <p className="max-w-sm text-row text-pretty text-muted-foreground">
            Create one key for each script or tool, so you can revoke one without breaking the
            others.
          </p>
          <Button className={`mt-2 ${CONTROL}`} onClick={() => setCreating(true)}>
            Create access key…
          </Button>
        </div>
      ) : (
        <>
          <ListHead heads={["Key", "Last used", "Expires"]} />
          <ul aria-label="Access keys">
            {keys.map((key) => (
              <ListRow
                key={key.id}
                icon={<KeyRoundIcon />}
                name={key.name}
                sub={
                  phone
                    ? `Used ${lastUsed(key.lastUsedAt, now, "never").toLowerCase()}. Expires: ${expiresCell(key.expiresAt, now)}.`
                    : `Created ${shortDay(key.createdAt, now)}`
                }
                cells={[
                  { key: "used", node: lastUsed(key.lastUsedAt, now, "Not used yet") },
                  {
                    key: "expires",
                    node: (
                      <span
                        className={cn(
                          expiresCell(key.expiresAt, now) === "Expired" && "text-warning",
                        )}
                      >
                        {expiresCell(key.expiresAt, now)}
                      </span>
                    ),
                  },
                ]}
                action={
                  <Button
                    variant="outline"
                    size={phone ? "touch" : "sm"}
                    aria-label={`Revoke ${key.name}`}
                    onClick={() => setRevoking(key)}
                  >
                    Revoke…
                  </Button>
                }
              />
            ))}
          </ul>
        </>
      )}
      {/* On a phone the section's button sits under its list (the heading has no room). */}
      {phone && keys.length > 0 ? (
        <div className="px-4 py-3">
          <Button
            variant="outline"
            size="touch"
            className="w-full"
            onClick={() => setCreating(true)}
          >
            Create access key…
          </Button>
        </div>
      ) : null}
      {creating ? <CreateAccessKey onClose={() => setCreating(false)} /> : null}
      {revoking === null ? null : (
        <RevokeAccessKey target={revoking} onClose={() => setRevoking(null)} />
      )}
    </SettingSection>
  );
}

/**
 * Create an access key: a name and how long it works, then the key itself, shown once in this
 * dialog. Mend keeps only its hash; closing the dialog drops it from the page.
 */
function CreateAccessKey({ onClose }: { readonly onClose: () => void }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const phone = usePhone();
  const now = useSecond();
  const formId = useId();
  const nameId = useId();
  const [name, setName] = useState("");
  const [expiry, setExpiry] = useState<Expiry>("90");
  const create = useMutation(
    trpc.accessKeys.create.mutationOptions({
      // It carries the key: gone from the mutation cache once nothing shows it.
      gcTime: 0,
      onSuccess: () => queryClient.invalidateQueries(trpc.accessKeys.list.queryFilter()),
    }),
  );
  const created = create.data;
  const trimmed = name.trim();
  const close = () => {
    create.reset();
    onClose();
  };
  return (
    <Overlay
      open
      onOpenChange={(next) => {
        if (!next && !create.isPending) close();
      }}
      size="md"
      title={created === undefined ? "Create access key" : "Copy your access key"}
      description={
        created === undefined
          ? "The key acts as you until it expires or you revoke it."
          : `This is the only time Mend shows the key for ${created.key.name}. Copy it now and store it somewhere safe, such as your CI's secrets. You won't see it again after you close this.`
      }
      footer={
        created === undefined ? (
          <>
            <Button
              variant="outline"
              className={CONTROL}
              disabled={create.isPending}
              onClick={close}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              form={formId}
              className={CONTROL}
              disabled={create.isPending || trimmed === ""}
            >
              {create.isPending ? "Creating…" : "Create key"}
            </Button>
          </>
        ) : (
          <Button className={CONTROL} onClick={close}>
            Done
          </Button>
        )
      }
    >
      {created === undefined ? (
        <form
          id={formId}
          noValidate
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmed !== "") create.mutate({ name: trimmed, expiresInDays: expiryDays(expiry) });
          }}
        >
          <div>
            <label htmlFor={nameId} className="mb-2 block font-medium">
              Name
            </label>
            <Input
              id={nameId}
              value={name}
              maxLength={80}
              autoFocus
              aria-describedby={`${nameId}-help`}
              className="h-9 max-lg:h-11 max-lg:text-base"
              onChange={(event) => setName(event.target.value)}
            />
            <p id={`${nameId}-help`} className="mt-1.5 text-row text-muted-foreground">
              Name it after the script or tool that will use it.
            </p>
          </div>
          <div>
            <p className="mb-2 font-medium">Expires after</p>
            <Segmented
              aria-label="Expires after"
              value={expiry}
              options={EXPIRY_OPTIONS}
              size={phone ? "touch" : "default"}
              className="w-full"
              onValueChange={setExpiry}
            />
            <p className="mt-1.5 text-row text-muted-foreground">{expiryLine(expiry, now)}</p>
          </div>
          {create.isError ? (
            <InlineAlert title="Mend didn't create the key.">
              {requestFailure(create.error)}
            </InlineAlert>
          ) : null}
        </form>
      ) : (
        <div className="grid gap-2">
          <p className="font-medium">Access key</p>
          <CopyField value={created.secret} label="Copy key" size={phone ? "touch" : "default"} />
          <p className="text-row text-muted-foreground">
            {shownKeyLine(created.key.expiresAt, now)}
          </p>
        </div>
      )}
    </Overlay>
  );
}

function RevokeAccessKey({
  target: accessKey,
  onClose,
}: {
  readonly target: AccessKeyView;
  readonly onClose: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const revoke = useMutation(
    trpc.accessKeys.revoke.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries(trpc.accessKeys.list.queryFilter());
        toast.add({ description: `Revoked ${accessKey.name}.`, priority: "low" });
        onClose();
      },
    }),
  );
  return (
    <Overlay
      open
      onOpenChange={(next) => {
        if (!next && !revoke.isPending) onClose();
      }}
      size="sm"
      title={`Revoke ${accessKey.name}?`}
      description="The next request with this key is refused. Whatever uses it stops until you give it a new key."
      footer={
        <>
          <Button
            variant="outline"
            className={CONTROL}
            disabled={revoke.isPending}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            className={CONTROL}
            disabled={revoke.isPending}
            onClick={() => revoke.mutate({ id: accessKey.id })}
          >
            {revoke.isPending ? "Revoking…" : "Revoke key"}
          </Button>
        </>
      }
    >
      {revoke.isError ? (
        <InlineAlert title="Mend didn't revoke it.">{requestFailure(revoke.error)}</InlineAlert>
      ) : null}
    </Overlay>
  );
}

/**
 * Workspace SSH keys (docs/WORKSPACE-SSH.md): the keys that open a shell in the person's
 * workspaces. A computer adds its key with `mend ssh setup`; the web lists and removes them. Read
 * on its own, so a platform that can't answer leaves the rest of the page standing.
 */
function SshKeysSection({ phone }: { readonly phone: boolean }) {
  const trpc = useTRPC();
  const view = useQuery(trpc.platform.workspaceSsh.queryOptions());
  const now = useSecond();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<WorkspaceSshKey | null>(null);
  const [removed, setRemoved] = useState<string | null>(null);
  return (
    <SettingSection
      title="Workspace SSH keys"
      description={
        <>
          These keys open a shell in your workspaces, from VS Code Remote-SSH or plain ssh. A
          computer adds its key when you run{" "}
          <code className="font-mono text-meta">mend ssh setup</code> on it.
        </>
      }
      action={
        view.data?.gateway === null ? undefined : (
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
            Add SSH key…
          </Button>
        )
      }
    >
      {view.isPending ? (
        <p
          role="status"
          className="border-b border-border py-3 text-row text-muted-foreground max-lg:px-4"
        >
          Reading your keys…
        </p>
      ) : view.isError ? (
        <div className="border-b border-border py-3 max-lg:px-4">
          <InlineAlert
            title="Mend couldn't read your SSH keys."
            actions={
              <Button variant="outline" size="sm" onClick={() => void view.refetch()}>
                Try again
              </Button>
            }
          >
            {requestFailure(view.error)}
          </InlineAlert>
        </div>
      ) : view.data.keys.length === 0 && view.data.gateway !== null ? (
        <p className="border-b border-border py-3 text-row text-muted-foreground max-lg:px-4">
          No SSH keys yet. Add one from the computer you want to connect from.
        </p>
      ) : (
        <>
          {view.data.gateway === null ? (
            <div className="border-b border-border py-3 max-lg:px-4">
              <InlineAlert tone="info" title="This server has no workspace SSH gateway.">
                Your workspaces can't be reached over SSH here, and{" "}
                <code className="font-mono text-meta">mend ssh setup</code> stops with an error. Ask
                the server's operator if you need SSH access.
              </InlineAlert>
            </div>
          ) : null}
          {view.data.keys.length === 0 ? null : <ListHead heads={["Key", "Added"]} />}
          <ul aria-label="Workspace SSH keys">
            {view.data.keys.map((key) => (
              <ListRow
                key={key.sshKeyId}
                icon={<KeyRoundIcon />}
                name={key.name}
                sub={
                  <span className="font-mono text-meta">
                    {key.algorithm} · {key.fingerprint}
                  </span>
                }
                cells={[{ key: "added", node: shortDay(key.createdAt, now) }]}
                action={
                  <Button
                    variant="outline"
                    size={phone ? "touch" : "sm"}
                    aria-label={`Remove ${key.name}`}
                    onClick={() => setRemoving(key)}
                  >
                    Remove…
                  </Button>
                }
              />
            ))}
          </ul>
        </>
      )}
      {removed === null ? null : (
        <p role="status" className="py-3 text-row text-muted-foreground max-lg:px-4">
          {removed}
        </p>
      )}
      {phone && view.isSuccess && view.data.gateway !== null ? (
        <div className="px-4 py-3">
          <Button variant="outline" size="touch" className="w-full" onClick={() => setAdding(true)}>
            Add SSH key…
          </Button>
        </div>
      ) : null}
      {adding ? <AddSshKey onClose={() => setAdding(false)} /> : null}
      {removing === null ? null : (
        <RemoveSshKey
          sshKey={removing}
          onClose={() => setRemoving(null)}
          onRemoved={(line) => {
            setRemoved(line);
            setRemoving(null);
          }}
        />
      )}
    </SettingSection>
  );
}

/** Add SSH key: the server takes keys only from `mend ssh setup`, so the dialog shows that. */
function AddSshKey({ onClose }: { readonly onClose: () => void }) {
  const phone = usePhone();
  return (
    <Overlay
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      size="md"
      title="Add an SSH key"
      description="Run this on the computer you want to connect from. It makes a key if the computer has none, adds the key here, and sets up ~/.ssh/config so ssh and VS Code can reach your workspaces."
      footer={
        <Button className={CONTROL} onClick={onClose}>
          Done
        </Button>
      }
    >
      <CopyField value="mend ssh setup" label="Copy command" size={phone ? "touch" : "default"} />
      <p className="text-row text-pretty text-muted-foreground">
        In VS Code, run <code className="font-mono text-meta">Mend: Set up workspace SSH</code> from
        the command palette instead. The key shows up in this list once it's added.
      </p>
    </Overlay>
  );
}

function RemoveSshKey({
  sshKey,
  onClose,
  onRemoved,
}: {
  readonly sshKey: WorkspaceSshKey;
  readonly onClose: () => void;
  readonly onRemoved: (line: string) => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const remove = useMutation(
    trpc.platform.removeWorkspaceSshKey.mutationOptions({
      onSuccess: async (result) => {
        await queryClient.invalidateQueries(trpc.platform.workspaceSsh.queryFilter());
        onRemoved(removalLine(result));
      },
    }),
  );
  return (
    <Overlay
      open
      onOpenChange={(next) => {
        if (!next && !remove.isPending) onClose();
      }}
      size="sm"
      title={`Remove ${sshKey.name}?`}
      description="Your workspaces refuse this key from the next connection. Connections already open with it end within a minute."
      footer={
        <>
          <Button
            variant="outline"
            className={CONTROL}
            disabled={remove.isPending}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            className={CONTROL}
            disabled={remove.isPending}
            onClick={() => remove.mutate({ sshKeyId: sshKey.sshKeyId })}
          >
            {remove.isPending ? "Removing…" : "Remove key"}
          </Button>
        </>
      }
    >
      <p className="rounded-lg bg-muted px-3 py-2.5 font-mono text-meta break-all">
        {sshKey.algorithm} {sshKey.fingerprint}
      </p>
      {remove.isError ? (
        <InlineAlert title="Mend didn't remove it.">{requestFailure(remove.error)}</InlineAlert>
      ) : null}
    </Overlay>
  );
}
