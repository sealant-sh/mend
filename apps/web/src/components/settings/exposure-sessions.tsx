import {
  serverBoatLines,
  sessionRuntimesLine,
  type StatusLine,
  type StatusState,
} from "@mend/domain/workbench";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "#/components/kit/button";
import { SettingsSection } from "#/components/kit/section";
import { ErrorNote, StatusWord, type Tone, errorText } from "#/components/kit/status";
import { DataTable } from "#/components/kit/table";
import { useTRPC } from "#/lib/trpc";

const TONES: Readonly<Record<StatusState, Tone | null>> = {
  ok: "ok",
  info: null,
  todo: "wait",
  failed: "bad",
};

const WORDS: Readonly<Record<StatusState, string>> = {
  ok: "observed",
  info: "noted",
  todo: "act soon",
  failed: "needs action",
};

/**
 * Settings · Instance · Exposure, where sessions run (SLNT-799): what the server offers, and on a
 * server that offers Boat, the public addresses Boat VMs dial, the server's own Boat key, and
 * whether Sealant lists Boat, each as observed and when. The lines are `mend server status`'s and
 * `mend doctor`'s, from the same machine view.
 */
export function SessionsAndBoat({ now = new Date() }: { readonly now?: Date }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const machine = useQuery(trpc.platform.machine.queryOptions(undefined, { retry: false }));
  // The operator asks sealant to check the server's own key with Boat now (SLNT-822); the machine
  // view, read again, shows what it observed.
  const checkKey = useMutation(
    trpc.platform.checkServerBoatKey.mutationOptions({
      onSettled: () => queryClient.invalidateQueries(trpc.platform.machine.pathFilter()),
    }),
  );
  const view = machine.data;
  const serverKey = view?.boat?.serverKey.state;
  const lines: ReadonlyArray<StatusLine> =
    view?.sessionRuntimes === undefined
      ? []
      : [
          sessionRuntimesLine(view.sessionRuntimes),
          ...(view.boat === undefined
            ? []
            : serverBoatLines({ facts: view.boat, now, from: "the server" })),
        ];
  return (
    <SettingsSection
      title="Where sessions run"
      why="What this server offers organizations, and what it last observed about Boat: the addresses Boat VMs dial, its own Boat key, and whether a worker launches Boat."
    >
      {machine.isPending ? (
        <p role="status" className="font-mono text-[12px] text-faint">
          reading the machine view…
        </p>
      ) : machine.isError ? (
        <ErrorNote>Could not read the machine view: {errorText(machine.error)}</ErrorNote>
      ) : (
        <DataTable
          label="Where sessions run"
          columns={[
            { head: "Item", width: "0.9fr" },
            { head: "State", width: "0.8fr" },
            { head: "What Mend saw", width: "2.4fr" },
          ]}
          empty="Sealant picks where sessions run on this server"
          rows={lines.map((line, index) => ({
            key: `${line.label}-${index}`,
            cells: [
              <span key="label" className="font-mono text-[12px] break-words text-foreground">
                {line.label}
              </span>,
              <StatusWord key="state" tone={TONES[line.state]}>
                {WORDS[line.state]}
              </StatusWord>,
              <div key="detail" className="grid gap-1">
                <span className="text-[12.5px] leading-snug text-ink-2">{line.detail}</span>
                {line.fix === null ? null : (
                  <span className="font-mono text-[11px] leading-snug text-faint">{line.fix}</span>
                )}
              </div>,
            ],
          }))}
        />
      )}
      {serverKey === "held" ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={checkKey.isPending} onClick={() => checkKey.mutate()}>
            {checkKey.isPending ? "Checking with Boat…" : "Check the server's Boat key now"}
          </Button>
          <span className="text-[12.5px] text-muted-foreground">
            sealant asks Boat about the key now, read-only; otherwise it checks once a day.
          </span>
        </div>
      ) : null}
      {checkKey.error === null ? null : (
        <ErrorNote className="mt-3">{errorText(checkKey.error)}</ErrorNote>
      )}
    </SettingsSection>
  );
}
