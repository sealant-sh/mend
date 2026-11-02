import { useQuery } from "@tanstack/react-query";

import { Button } from "#/components/kit/button";
import { Panel, SettingsSection } from "#/components/kit/section";
import { ErrorNote, errorText, StatusWord, type Tone } from "#/components/kit/status";
import { Facts } from "#/components/kit/tip";
import type { SealantConnectionDto } from "#/lib/api";
import { useTRPC, type TrpcProxy } from "#/lib/trpc";

/** The live round-trip to the control plane, read again every few minutes while the tab is open. */
export const sealantConnectionOptions = (trpc: TrpcProxy) =>
  trpc.platform.sealantConnection.queryOptions(undefined, {
    staleTime: 0,
    refetchInterval: 180_000,
  });

const STATUS: Record<
  SealantConnectionDto["status"],
  { readonly tone: Tone; readonly word: string }
> = {
  connected: { tone: "ok", word: "connected · observed" },
  unauthorized: { tone: "bad", word: "unauthorized · observed" },
  mismatched: { tone: "wait", word: "responded · surface mismatch" },
  unreachable: { tone: "bad", word: "unreachable · observed" },
};

/** Settings · Sealant: what this instance observed when it last asked its control plane. */
export function SealantSettings() {
  const trpc = useTRPC();
  const connection = useQuery(sealantConnectionOptions(trpc));
  const data = connection.data;
  return (
    <Panel>
      <SettingsSection
        title="Connection"
        why="Checked from this instance when you open this tab, and every few minutes while it is open."
      >
        {data === undefined ? (
          connection.isError ? (
            <ErrorNote>Could not ask: {errorText(connection.error)}</ErrorNote>
          ) : (
            <p className="font-mono text-[12px] text-faint">checking…</p>
          )
        ) : (
          <>
            <StatusWord tone={STATUS[data.status].tone}>{STATUS[data.status].word}</StatusWord>
            <div className="mt-3">
              <Facts
                rows={[
                  { term: "Control plane", value: data.baseUrl },
                  { term: "Checked", value: new Date(data.checkedAt).toLocaleTimeString() },
                  ...(data.detail === null ? [] : [{ term: "Observed", value: data.detail }]),
                ]}
              />
            </div>
            {connection.isError ? (
              <ErrorNote className="mt-3">
                The last check failed to ask: {errorText(connection.error)}
              </ErrorNote>
            ) : null}
          </>
        )}
        <Button
          size="sm"
          className="mt-3"
          disabled={connection.isFetching}
          onClick={() => void connection.refetch()}
        >
          {connection.isFetching ? "Checking…" : "Check again"}
        </Button>
      </SettingsSection>
    </Panel>
  );
}
