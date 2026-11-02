import { useSecondTick } from "@mend/ui/hooks/use-second-tick";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";

import { Button } from "#/components/kit/button";
import { CodeBox } from "#/components/kit/code-box";
import { Field, TextInput } from "#/components/kit/field";
import { ModalDialog } from "#/components/kit/modal";
import { Panel, SettingsSection } from "#/components/kit/section";
import { Segment } from "#/components/kit/segment";
import { ErrorNote, errorText, StatusWord } from "#/components/kit/status";
import { DataTable } from "#/components/kit/table";
import {
  countdown,
  formatDay,
  formatLastUsed,
  groupCode,
  pairingPayload,
  pairingUrls,
  renderPairingSvg,
} from "#/components/pairing-qr";
import type { DeviceDto, PairingDto } from "#/lib/api";
import { useTRPC, type TrpcProxy } from "#/lib/trpc";

/** The device list, read on its own clock: a phone that just paired shows up on the next read. */
export const devicesOptions = (trpc: TrpcProxy) =>
  trpc.devices.list.queryOptions(undefined, { staleTime: 30_000 });

const RECENT_SECONDS = 14 * 86_400;

/** The pairing code being shown: minted when Pair a phone is pressed, forgotten on close. */
const usePairingMint = () => {
  const trpc = useTRPC();
  return useMutation(trpc.devices.createPairing.mutationOptions());
};
type PairingMint = ReturnType<typeof usePairingMint>;

/** Settings · Devices: phones and terminals holding a token of their own, and how to add one. */
export function DevicesSettings() {
  const trpc = useTRPC();
  const devices = useQuery(devicesOptions(trpc));
  const now = useSecondTick();
  const [revoking, setRevoking] = useState<DeviceDto | null>(null);
  const [pairing, setPairing] = useState(false);
  const pair = usePairingMint();
  const [minting, setMinting] = useState(false);

  return (
    <Panel>
      <SettingsSection
        title="Devices"
        why={
          <>
            A paired phone or a signed-in terminal (
            <span className="font-mono text-[12px]">mend login</span>) holds a token of its own.
            Revoking ends that token.
          </>
        }
      >
        {devices.data === undefined ? (
          devices.isError ? (
            <ErrorNote>Could not read your devices: {errorText(devices.error)}</ErrorNote>
          ) : (
            <p className="font-mono text-[12px] text-faint">reading devices…</p>
          )
        ) : (
          <DataTable
            label="Devices"
            columns={[
              { head: "Device", width: "1.5fr" },
              { head: "Paired", width: "0.7fr" },
              { head: "Last used", width: "0.8fr" },
              { head: "", width: "auto" },
            ]}
            empty="no devices paired"
            rows={devices.data.map((device) => {
              const used =
                device.lastUsedAt === null
                  ? null
                  : now - Math.floor(new Date(device.lastUsedAt).getTime() / 1000);
              return {
                key: device.id,
                cells: [
                  <span key="name" className="flex min-w-0 items-baseline gap-2">
                    <StatusWord
                      tone={used !== null && used < RECENT_SECONDS ? "ok" : "off"}
                      className="text-[12px] text-foreground"
                    >
                      {device.name}
                    </StatusWord>
                    <span className="font-mono text-[11px] text-faint">{device.platform}</span>
                  </span>,
                  <span key="paired" className="font-mono text-[12px] text-muted-foreground">
                    {formatDay(device.createdAt)}
                  </span>,
                  <span key="used" className="font-mono text-[12px] text-muted-foreground">
                    {formatLastUsed(device.lastUsedAt, now)}
                  </span>,
                  <Button
                    key="revoke"
                    size="sm"
                    variant="ghost"
                    aria-label={`Revoke ${device.name}`}
                    onClick={() => setRevoking(device)}
                  >
                    Revoke
                  </Button>,
                ],
              };
            })}
          />
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              setPairing(true);
              pair.mutate();
            }}
          >
            Pair a phone
          </Button>
          <Button size="sm" onClick={() => setMinting(true)}>
            Mint a token by hand
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={devices.isFetching}
            onClick={() => void devices.refetch()}
          >
            {devices.isFetching ? "Refreshing…" : "Refresh"}
          </Button>
        </div>
      </SettingsSection>
      {revoking === null ? null : (
        <RevokeDialog device={revoking} onClose={() => setRevoking(null)} />
      )}
      {pairing ? <PairDialog mint={pair} onClose={() => setPairing(false)} /> : null}
      {minting ? <MintDialog onClose={() => setMinting(false)} /> : null}
    </Panel>
  );
}

function RevokeDialog({
  device,
  onClose,
}: {
  readonly device: DeviceDto;
  readonly onClose: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const revoke = useMutation(
    trpc.devices.revoke.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries(trpc.devices.list.queryFilter());
        onClose();
      },
    }),
  );
  return (
    <ModalDialog
      open
      onOpenChange={(open) => {
        if (!open && !revoke.isPending) onClose();
      }}
      title={`Revoke ${device.name}?`}
      description="Its token stops working at once. To use it again, pair it with a new code."
      width={460}
      footer={
        <>
          <Button variant="ghost" disabled={revoke.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={revoke.isPending}
            onClick={() => revoke.mutate({ id: device.id })}
          >
            {revoke.isPending ? "Revoking…" : "Revoke"}
          </Button>
        </>
      }
    >
      {revoke.isError ? <ErrorNote>Not revoked: {errorText(revoke.error)}</ErrorNote> : null}
    </ModalDialog>
  );
}

/**
 * N7b: a code for the phone to trade for a token of its own, shown as a QR and as text. The code
 * is minted when the dialog opens and forgotten when it closes.
 */
function PairDialog({
  mint,
  onClose,
}: {
  readonly mint: PairingMint;
  readonly onClose: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const close = () => {
    mint.reset();
    void queryClient.invalidateQueries(trpc.devices.list.queryFilter());
    onClose();
  };
  return (
    <ModalDialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title="Pair a phone"
      width={440}
      className="justify-items-center text-center"
      footer={<Button onClick={close}>Done</Button>}
    >
      {mint.data === undefined ? (
        mint.isError ? (
          <div className="grid justify-items-center gap-3">
            <ErrorNote>Could not make a code: {errorText(mint.error)}</ErrorNote>
            <Button size="sm" onClick={() => mint.mutate()}>
              Try again
            </Button>
          </div>
        ) : (
          <p role="status" className="font-mono text-[12px] text-faint">
            making a code…
          </p>
        )
      ) : (
        <PairingCode
          key={mint.data.code}
          pairing={mint.data}
          onRenew={() => mint.mutate()}
          renewing={mint.isPending}
        />
      )}
    </ModalDialog>
  );
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

function PairingCode({
  pairing,
  onRenew,
  renewing,
}: {
  readonly pairing: PairingDto;
  readonly onRenew: () => void;
  readonly renewing: boolean;
}) {
  const configured = pairingUrls(pairing);
  // With no public origin configured, the phone reaches this server where this page is open.
  const urls = configured.length === 0 ? [window.location.origin] : configured;
  const [picked, setPicked] = useState<string | null>(null);
  const url = picked !== null && urls.includes(picked) ? picked : (urls[0] ?? "");
  const remaining = countdown(pairing.expiresAt, useSecondTick());
  // Drawing the QR is local work, not server state; the query only keeps it off the render path.
  const qr = useQuery({
    queryKey: ["pairing-qr", pairing.code, url],
    queryFn: () => renderPairingSvg(pairingPayload(url, pairing.code)),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
  });
  return (
    <div className="grid justify-items-center gap-3">
      <div
        role="img"
        aria-label={`QR code for pairing code ${groupCode(pairing.code)}`}
        className="grid size-[180px] place-items-center rounded-[14px] bg-panel p-3 text-foreground shadow-[0_0_0_1px_var(--sw-rule)] [&>div>svg]:h-auto [&>div>svg]:w-full"
      >
        {qr.data === undefined ? (
          <span className="font-mono text-[11px] text-faint">
            {qr.isError ? "the QR could not be drawn" : "drawing…"}
          </span>
        ) : (
          // The markup is this page's own render of the payload, made just above.
          <div className="w-full" dangerouslySetInnerHTML={{ __html: qr.data }} />
        )}
      </div>
      <p className="font-mono text-[18px] tracking-[0.1em]">{groupCode(pairing.code)}</p>
      <p className="text-[13px] text-muted-foreground">
        Scan with the Mend app, or type the code.{" "}
        {remaining === null ? "This code expired." : `Expires in ${remaining}.`}
      </p>
      {remaining === null ? (
        <Button size="sm" disabled={renewing} onClick={onRenew}>
          {renewing ? "Making a code…" : "New code"}
        </Button>
      ) : null}
      {urls.length > 1 ? (
        <Field label="Address the phone uses" className="justify-items-center">
          {() => (
            <Segment
              label="Address the phone uses"
              value={url}
              options={urls.map((candidate) => ({ value: candidate, label: hostOf(candidate) }))}
              onChange={setPicked}
            />
          )}
        </Field>
      ) : (
        <p className="font-mono text-[12px] break-all text-muted-foreground">
          {configured.length === 0
            ? `no public address configured · ${hostOf(url)}`
            : `the phone uses ${hostOf(url)}`}
        </p>
      )}
    </div>
  );
}

/**
 * A token for a device that cannot scan a code, shown once inside this dialog. Mend keeps only
 * its hash; closing the dialog drops it from this page as well.
 */
function MintDialog({ onClose }: { readonly onClose: () => void }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const formId = useId();
  const mint = useMutation(
    trpc.devices.create.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries(trpc.devices.list.queryFilter()),
    }),
  );
  const close = () => {
    mint.reset();
    onClose();
  };
  const minted = mint.data;
  return (
    <ModalDialog
      open
      onOpenChange={(open) => {
        if (!open && !mint.isPending) close();
      }}
      title={minted === undefined ? "Mint a token by hand" : `A token for ${minted.device.name}`}
      description={
        minted === undefined
          ? "For a device that cannot scan a code. The token is shown once and typed into the app by hand; the device then appears in your list like any paired one."
          : "In the app: Settings → Advanced → server URL and bearer token. Mend keeps only this token's hash, so once this closes it cannot be shown again. Revoke the device to end it."
      }
      width={520}
      footer={
        minted === undefined ? (
          <>
            <Button variant="ghost" disabled={mint.isPending} onClick={close}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" form={formId} disabled={mint.isPending}>
              {mint.isPending ? "Minting…" : "Mint"}
            </Button>
          </>
        ) : (
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        )
      }
    >
      {minted === undefined ? (
        <form
          id={formId}
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = name.trim();
            mint.mutate({ name: trimmed === "" ? "by hand" : trimmed, platform: "other" });
          }}
        >
          <Field label="Device name">
            {(id) => (
              <TextInput
                id={id}
                sans
                value={name}
                placeholder="App Review iPhone"
                disabled={mint.isPending}
                onChange={(event) => setName(event.target.value)}
              />
            )}
          </Field>
          {mint.isError ? (
            <ErrorNote className="mt-3">Not minted: {errorText(mint.error)}</ErrorNote>
          ) : null}
        </form>
      ) : (
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <p className="font-sans text-[12.5px] font-medium text-ink-2">Server URL</p>
            {(minted.urls.length === 0 ? [window.location.origin] : minted.urls).map((url) => (
              <CodeBox key={url} copy={url} label="the server URL">
                {url}
              </CodeBox>
            ))}
          </div>
          <div className="grid gap-1.5">
            <p className="font-sans text-[12.5px] font-medium text-ink-2">Token · shown once</p>
            <CodeBox copy={minted.token} label="the token">
              {minted.token}
            </CodeBox>
          </div>
        </div>
      )}
    </ModalDialog>
  );
}
