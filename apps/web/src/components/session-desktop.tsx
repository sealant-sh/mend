import { isLoopbackHostname, serviceReach } from "@mend/domain/workbench";
import { Button } from "@mend/ui/components/ui/button";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, useSyncExternalStore } from "react";

import { DesktopWorkbench } from "#/components/desktop-workbench";
import { runService } from "#/lib/api";
import { useTRPC } from "#/lib/trpc";

const noSubscription = () => () => {};

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
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const services = useQuery(trpc.services.list.queryOptions({ all: true }));
  const local = useSyncExternalStore(
    noSubscription,
    () => isLoopbackHostname(window.location.hostname),
    () => false,
  );
  const desktop = services.data?.find(
    (service) =>
      service.service.sessionId === sessionId &&
      service.service.name === "desktop" &&
      service.currentForward?.state === "bound",
  );
  const reach = desktop ? serviceReach(desktop.endpoints, local) : null;
  const url = reach?.kind === "direct" ? reach.browserUrl : null;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!import.meta.env.DEV || (!enabled && !desktop)) return null;
  const start = async () => {
    setPending(true);
    setError(null);
    try {
      await runService(sessionId, {
        argv: [
          "env",
          `MEND_DESKTOP_APP_ORIGIN=${window.location.origin}`,
          "/opt/mend-desktop/start",
        ],
        port: 6090,
        name: "desktop",
        browserScheme: "http",
      });
      await queryClient.invalidateQueries(trpc.services.pathFilter());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Desktop could not start.");
    } finally {
      setPending(false);
    }
  };
  return (
    <section className="mt-6 space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-medium">Desktop experiment</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            The Service's network boundary protects this prototype; its forwarded port has no Mend
            sign-in.
          </p>
        </div>
        {!desktop && canRun && live ? (
          <Button disabled={pending} onClick={() => void start()}>
            {pending ? "Starting desktop…" : "Start desktop"}
          </Button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      {url && canRun ? (
        <>
          <a href={url + "/viewer"} target="_blank" rel="noreferrer" className="text-sm text-info">
            Open desktop viewer
          </a>
          <DesktopWorkbench baseUrl={url.replace(/\/$/, "")} />
        </>
      ) : desktop ? (
        <p className="text-sm text-muted-foreground">
          {canRun
            ? "Tunnel the desktop Service to this machine with mend service connect desktop."
            : "The session owner controls this desktop."}
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          Start the desktop in a live workspace built from the experimental image.
        </p>
      )}
    </section>
  );
}
