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
    <section aria-label="Pages" className="mb-6">
      <p className="text-xs font-medium text-label">Pages</p>
      <div className="mt-3 overflow-hidden rounded-2xl bg-card shadow-sm">
        {pages.isPending ? (
          <p role="status" className="p-4 text-[13px] text-muted-foreground">
            Reading pages…
          </p>
        ) : pages.isError ? (
          <div role="status" className="p-4 text-[13px] text-ink-2">
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
          <p className="p-4 font-mono text-xs text-faint">none yet</p>
        ) : (
          <ul className="max-h-80 divide-y divide-rule-faint overflow-y-auto">
            {pages.data.map((page, index) => (
              <li key={page.id}>
                <button
                  type="button"
                  onClick={() => onOpen(page)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-secondary focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                >
                  <span className="font-mono text-xs text-faint">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="min-w-0 flex-1 break-words text-[13px] text-foreground">
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
