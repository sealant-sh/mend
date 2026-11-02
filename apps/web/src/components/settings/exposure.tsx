import { useQuery } from "@tanstack/react-query";

import { Button } from "#/components/kit/button";
import { Panel, SettingsSection } from "#/components/kit/section";
import { ErrorNote, StatusWord, errorText } from "#/components/kit/status";
import { DataTable } from "#/components/kit/table";
import { useTRPC } from "#/lib/trpc";

import {
  DECLARED_WORDS,
  establishedTone,
  exposureCounts,
  refusesPublicStart,
} from "./exposure-model";

const time = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/**
 * Settings · Instance · Exposure (O10): what the operator declared beside every public exposure
 * gate item with how Mend established it. An item neither observed nor declared is open. Check
 * again reads the report afresh.
 */
export function Exposure() {
  const trpc = useTRPC();
  const report = useQuery(trpc.platform.exposure.queryOptions(undefined, { retry: false }));
  const data = report.data;
  return (
    <Panel>
      <SettingsSection
        title="Exposure"
        why="How people reach this instance, as you declare it. Mend reports what it observes beside what you declared."
      >
        <p className="font-sans text-[12.5px] font-medium text-ink-2">Declared</p>
        <p className="mt-1.5 font-mono text-[13px] text-foreground">
          {data === undefined ? "…" : DECLARED_WORDS[data.declared]}
        </p>
        <p className="mt-1.5 text-[13px] text-muted-foreground">
          Declared with <code className="font-mono text-[12px]">MEND_EXPOSURE</code> when the server
          starts (<code className="font-mono text-[12px]">mend server setup</code>). Items you
          checked from outside are declared with{" "}
          <code className="font-mono text-[12px]">MEND_EXPOSURE_DECLARED</code>.
        </p>
      </SettingsSection>
      <SettingsSection
        title="Declared and observed"
        why={
          data === undefined
            ? "Anything neither observed nor declared is open."
            : `Read at ${time(report.dataUpdatedAt)} from this server. Anything neither observed nor declared is open.`
        }
      >
        {report.isPending ? (
          <p role="status" className="font-mono text-[12px] text-faint">
            reading the exposure report…
          </p>
        ) : report.isError ? (
          <ErrorNote>Could not read the exposure report: {errorText(report.error)}</ErrorNote>
        ) : (
          <>
            <p className="mb-2 font-mono text-[12px] text-muted-foreground">
              {exposureCounts(report.data.items)}
            </p>
            <DataTable
              label="Exposure items"
              columns={[
                { head: "Item", width: "0.9fr" },
                { head: "Established", width: "0.8fr" },
                { head: "What Mend saw", width: "2.4fr" },
              ]}
              empty="no items reported"
              rows={report.data.items.map((item) => ({
                key: item.id,
                cells: [
                  <span key="id" className="font-mono text-[12px] break-words text-foreground">
                    {item.id}
                  </span>,
                  <span key="established" className="grid justify-items-start gap-0.5">
                    <StatusWord tone={establishedTone(item)}>{item.established}</StatusWord>
                    {refusesPublicStart(item) ? (
                      <span className="pl-[13px] font-mono text-[11px] leading-snug text-danger">
                        refuses a public start
                      </span>
                    ) : null}
                  </span>,
                  <div key="detail" className="grid gap-1">
                    <span className="text-[12.5px] leading-snug text-ink-2">{item.detail}</span>
                    {item.fix === null ? null : (
                      <span className="font-mono text-[11px] leading-snug text-faint">
                        {item.fix}
                      </span>
                    )}
                  </div>,
                ],
              }))}
            />
          </>
        )}
        <div className="mt-2.5 flex gap-2">
          <Button size="sm" disabled={report.isFetching} onClick={() => void report.refetch()}>
            {report.isFetching ? "Checking…" : "Check again"}
          </Button>
        </div>
      </SettingsSection>
    </Panel>
  );
}
