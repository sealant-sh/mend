import type { PageRef } from "@mend/domain/workbench";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight } from "lucide-react";
import { useState } from "react";

import { useTRPC } from "#/lib/trpc";

import { PageDialog } from "./page-frame.tsx";

export function SessionPages({
  sessionId,
  listed,
}: {
  readonly sessionId: string;
  readonly listed: boolean;
}) {
  const [open, setOpen] = useState<PageRef | null>(null);
  return (
    <>
      {listed ? <PagesList sessionId={sessionId} onOpen={setOpen} /> : null}
      {open !== null && <PageDialog page={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function PagesList({
  sessionId,
  onOpen,
}: {
  readonly sessionId: string;
  readonly onOpen: (page: PageRef) => void;
}) {
  const trpc = useTRPC();
  const pages = useQuery(trpc.sessions.pages.queryOptions({ id: sessionId }));
  return (
    <section aria-label="Pages" className="grid gap-2.5">
      <h2 className="font-mono text-[10.5px] leading-[1.3] font-medium tracking-[0.06em] text-label uppercase">
        Pages
      </h2>
      <div className="overflow-hidden rounded-xl border border-rule bg-panel">
        {pages.isPending ? (
          <p role="status" className="p-3 text-[12.5px] text-muted-foreground">
            Reading pages…
          </p>
        ) : pages.isError ? (
          <div role="status" className="p-3 text-[12.5px] text-ink-2">
            <p>The pages list could not be read.</p>
            <button
              type="button"
              onClick={() => void pages.refetch()}
              className="mt-2 text-info hover:underline"
            >
              Try again
            </button>
          </div>
        ) : pages.data.length === 0 ? (
          <p className="p-3 font-mono text-[11.5px] text-faint">none yet</p>
        ) : (
          <ul className="max-h-64 divide-y divide-rule-faint overflow-y-auto">
            {pages.data.map((page, index) => (
              <li key={page.id}>
                <button
                  type="button"
                  onClick={() => onOpen(page)}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-secondary focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                >
                  <span className="font-mono text-xs text-faint">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="min-w-0 flex-1 break-words text-[12.5px] text-foreground">
                    {page.title}
                  </span>
                  <ArrowUpRight
                    aria-hidden="true"
                    className="size-4 shrink-0 text-muted-foreground"
                  />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
