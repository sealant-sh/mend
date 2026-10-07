import { Button } from "@mend/ui/components/ui/button";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { DesktopWorkbench } from "#/components/desktop-workbench";
import { runService } from "#/lib/api";
import { useTRPC } from "#/lib/trpc";

/** Start the image's desktop as an ordinary recorded Service through the existing API. */
export function SessionDesktop({
  sessionId,
  enabled,
  canRun,
  live,
}: {
  readonly sessionId: string;
  readonly enabled: boolean;
  readonly canRun: boolean;
  readonly live: boolean;
}) {
  if (!enabled) return null;
  return <LiveSessionDesktop sessionId={sessionId} canRun={canRun} live={live} />;
}

function LiveSessionDesktop({
  sessionId,
  canRun,
  live,
}: {
  readonly sessionId: string;
  readonly canRun: boolean;
  readonly live: boolean;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const services = useQuery({
    ...trpc.services.list.queryOptions({ all: true }),
    refetchInterval: 2000,
  });
  const desktop = services.data?.find(
    (entry) => entry.service.sessionId === sessionId && entry.service.name === "desktop",
  );
  const url = `/api/sessions/${encodeURIComponent(sessionId)}/desktop`;
  const attempt = desktop?.attempts.find((entry) => entry.id === desktop.service.currentAttemptId);
  const stopped = !!desktop && (!attempt || attempt.exitedAt !== null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = async () => {
    setPending(true);
    setError(null);
    try {
      await runService(sessionId, {
        argv: [
          "env",
          `MEND_DESKTOP_SESSION_ID=${sessionId}`,
          `CODEX_HOME=/home/mend-desktop-${sessionId}/.codex`,
          `CLAUDE_CONFIG_DIR=/home/mend-desktop-${sessionId}/.claude`,
          "/opt/mend-desktop/start",
        ],
        port: 6090,
        name: "desktop",
        browserScheme: "http",
      });
      await queryClient.invalidateQueries(trpc.services.pathFilter());
      await queryClient.invalidateQueries({ queryKey: ["desktop", url] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Desktop could not start.");
    } finally {
      setPending(false);
    }
  };
  return (
    <section id="desktop" className="min-w-0 scroll-mt-6 space-y-3">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-xs font-medium text-label">Desktop</h2>
        </div>
        {(!desktop || stopped) && canRun && live ? (
          <Button disabled={pending} onClick={() => void start()}>
            {pending ? "Starting desktop…" : desktop ? "Restart desktop" : "Start desktop"}
          </Button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      {desktop && canRun ? (
        <DesktopWorkbench baseUrl={url} layout="stacked" />
      ) : desktop ? (
        <p className="text-sm text-muted-foreground">The session owner controls this desktop.</p>
      ) : (
        <p className="text-sm text-muted-foreground">
          Start the desktop in a live workspace built from the experimental image.
        </p>
      )}
    </section>
  );
}
