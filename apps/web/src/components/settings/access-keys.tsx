import { ACCESS_KEY_NAME_MAX } from "@mend/api-contracts";
import { useSecondTick } from "@mend/ui/hooks/use-second-tick";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";

import { Button } from "#/components/kit/button";
import { CodeBox } from "#/components/kit/code-box";
import { Field, GroupField, TextInput } from "#/components/kit/field";
import { ModalDialog } from "#/components/kit/modal";
import { Panel, SettingsSection } from "#/components/kit/section";
import { Segment } from "#/components/kit/segment";
import { ErrorNote, errorText, StatusWord } from "#/components/kit/status";
import { DataTable } from "#/components/kit/table";
import { formatDay, formatLastUsed } from "#/components/pairing-qr";
import type { AccessKeyDto } from "#/lib/api";
import { useTRPC, type TrpcProxy } from "#/lib/trpc";

export const accessKeysOptions = (trpc: TrpcProxy) =>
  trpc.accessKeys.list.queryOptions(undefined, { staleTime: 30_000 });

export const ACCESS_KEYS_DOCS = "https://docs.mend.run/guides/automation/";

/** What Settings offers (ADR 0023, decision 5), as the days the server is asked for. */
const EXPIRY_DAYS = { "30": 30, "90": 90, "365": 365, never: null } as const;
type Expiry = keyof typeof EXPIRY_DAYS;
const EXPIRY_OPTIONS: ReadonlyArray<{ readonly value: Expiry; readonly label: string }> = [
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "1 year" },
  { value: "never", label: "No expiry" },
];

/** The key rides a header, never the URL (ADR 0023, decision 4). */
export const curlLine = (origin: string): string =>
  `curl -H "Authorization: Bearer $MEND_ACCESS_KEY" ${origin}/api/projects`;

function Expires({ at, now }: { readonly at: string | null; readonly now: number }) {
  if (at === null) return <span className="font-mono text-[12px] text-faint">no expiry</span>;
  if (new Date(at).getTime() / 1000 <= now)
    return (
      <StatusWord tone="off" className="text-[12px]">
        expired
      </StatusWord>
    );
  return <span className="font-mono text-[12px] text-muted-foreground">{formatDay(at)}</span>;
}

export function AccessKeysSettings() {
  const trpc = useTRPC();
  const keys = useQuery(accessKeysOptions(trpc));
  const now = useSecondTick();
  const [revoking, setRevoking] = useState<AccessKeyDto | null>(null);
  const [creating, setCreating] = useState(false);

  return (
    <Panel>
      <SettingsSection
        title="Access keys"
        why={
          <>
            An access key lets your own automation, such as a CI job or a Slack bot, call Mend’s API
            as you, in this organization. A key cannot create keys or pair devices.{" "}
            <a href={ACCESS_KEYS_DOCS} className="text-info underline">
              Using an access key
            </a>
          </>
        }
      >
        {keys.data === undefined ? (
          keys.isError ? (
            <ErrorNote>Could not read your access keys: {errorText(keys.error)}</ErrorNote>
          ) : (
            <p className="font-mono text-[12px] text-faint">reading access keys…</p>
          )
        ) : (
          <DataTable
            label="Access keys"
            columns={[
              { head: "Name", width: "1.5fr" },
              { head: "Last used", width: "0.8fr" },
              { head: "Expires", width: "0.7fr" },
              { head: "", width: "auto" },
            ]}
            empty="no access keys"
            rows={keys.data.map((key) => ({
              key: key.id,
              cells: [
                <span key="name" className="flex min-w-0 flex-col">
                  <span className="break-words text-[13px] text-foreground">{key.name}</span>
                  <span className="font-mono text-[11px] text-faint" title={key.id}>
                    {key.id.slice(0, 8)} · created {formatDay(key.createdAt)}
                  </span>
                </span>,
                <span key="used" className="font-mono text-[12px] text-muted-foreground">
                  {formatLastUsed(key.lastUsedAt, now)}
                </span>,
                <Expires key="expires" at={key.expiresAt} now={now} />,
                <Button
                  key="revoke"
                  size="sm"
                  variant="ghost"
                  aria-label={`Revoke ${key.name}`}
                  onClick={() => setRevoking(key)}
                >
                  Revoke
                </Button>,
              ],
            }))}
          />
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
            Create an access key
          </Button>
        </div>
      </SettingsSection>
      {revoking === null ? null : (
        <RevokeDialog accessKey={revoking} onClose={() => setRevoking(null)} />
      )}
      {creating ? <CreateDialog onClose={() => setCreating(false)} /> : null}
    </Panel>
  );
}

function RevokeDialog({
  accessKey,
  onClose,
}: {
  readonly accessKey: AccessKeyDto;
  readonly onClose: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const revoke = useMutation(
    trpc.accessKeys.revoke.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries(trpc.accessKeys.list.queryFilter());
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
      title={`Revoke ${accessKey.name}?`}
      description="The next request with this key is refused. Automation that uses it stops until you give it a new key."
      width={460}
      footer={
        <>
          <Button variant="ghost" disabled={revoke.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={revoke.isPending}
            onClick={() => revoke.mutate({ id: accessKey.id })}
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
 * A new key, its secret shown once inside this dialog. Mend keeps only the secret's hash; closing
 * the dialog drops it from this page as well.
 */
function CreateDialog({ onClose }: { readonly onClose: () => void }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [expiry, setExpiry] = useState<Expiry>("90");
  const formId = useId();
  const create = useMutation(
    trpc.accessKeys.create.mutationOptions({
      // It carries a credential: gone from the mutation cache once nothing shows its result.
      gcTime: 0,
      onSuccess: () => queryClient.invalidateQueries(trpc.accessKeys.list.queryFilter()),
    }),
  );
  const close = () => {
    create.reset();
    onClose();
  };
  const created = create.data;
  const trimmed = name.trim();
  return (
    <ModalDialog
      open
      onOpenChange={(open) => {
        if (!open && !create.isPending) close();
      }}
      title={created === undefined ? "Create an access key" : `Access key ${created.key.name}`}
      description={
        created === undefined
          ? "Name it after what will use it. It acts as you, in this organization, until it expires or you revoke it."
          : "Mend keeps only this key’s hash, so once this closes it cannot be shown again. Revoke the key to end it."
      }
      width={560}
      footer={
        created === undefined ? (
          <>
            <Button variant="ghost" disabled={create.isPending} onClick={close}>
              Cancel
            </Button>
            <Button
              variant="primary"
              type="submit"
              form={formId}
              disabled={create.isPending || trimmed === ""}
            >
              {create.isPending ? "Creating…" : "Create"}
            </Button>
          </>
        ) : (
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        )
      }
    >
      {created === undefined ? (
        <form
          id={formId}
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmed === "") return;
            create.mutate({ name: trimmed, expiresInDays: EXPIRY_DAYS[expiry] });
          }}
        >
          <Field label="Name">
            {(id) => (
              <TextInput
                id={id}
                sans
                required
                value={name}
                maxLength={ACCESS_KEY_NAME_MAX}
                placeholder="ci-bot"
                disabled={create.isPending}
                onChange={(event) => setName(event.target.value)}
              />
            )}
          </Field>
          <GroupField label="Expires">
            <Segment
              label="Expires"
              value={expiry}
              options={EXPIRY_OPTIONS}
              disabled={create.isPending}
              onChange={setExpiry}
            />
          </GroupField>
          {create.isError ? (
            <ErrorNote className="mt-3">Not created: {errorText(create.error)}</ErrorNote>
          ) : null}
        </form>
      ) : (
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <p className="font-sans text-[12.5px] font-medium text-ink-2">
              Access key · shown once
            </p>
            <CodeBox copy={created.secret} label="the access key">
              {created.secret}
            </CodeBox>
            <p className="font-mono text-[12px] text-muted-foreground">
              {created.key.expiresAt === null
                ? "no expiry"
                : `expires ${formatDay(created.key.expiresAt)}`}
            </p>
          </div>
          <div className="grid gap-1.5">
            <p className="font-sans text-[12.5px] font-medium text-ink-2">
              Try it, with the key in MEND_ACCESS_KEY
            </p>
            <CodeBox copy={curlLine(window.location.origin)} label="the curl command">
              {curlLine(window.location.origin)}
            </CodeBox>
          </div>
        </div>
      )}
    </ModalDialog>
  );
}
