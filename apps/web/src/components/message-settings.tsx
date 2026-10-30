import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";

import { OnOffSwitch } from "#/components/on-off-switch";
import { failureWords } from "#/lib/refusal";
import { orLogin, useTRPC, useTRPCClient } from "#/lib/trpc";

/** The person's own message setting: whether Send goes into their running turn. */
export function MessageSettingsPanel() {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  const settings = useSuspenseQuery(trpc.platform.messageSettings.queryOptions()).data;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = (sendSteersRunningTurn: boolean) => {
    if (settings.sendSteersRunningTurn === sendSteersRunningTurn) return;
    setPending(true);
    setError(null);
    void orLogin(client.platform.setMessageSettings.mutate({ sendSteersRunningTurn }))
      .then((saved) => queryClient.setQueryData(trpc.platform.messageSettings.queryKey(), saved))
      .catch((cause: unknown) => setError(failureWords(cause, "Not saved. Try again.")))
      .finally(() => setPending(false));
  };

  return (
    <section className="rounded-2xl bg-panel p-6 shadow-[var(--shadow-sm)]">
      <h2 className="font-sans text-sm font-semibold">Messages</h2>
      <div className="mt-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="font-sans text-sm font-medium text-foreground">
            Send steers the running turn
          </p>
          <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
            On: while your own turn runs in a conversation, Send adds your message to it. Off: Send
            always starts your next turn. Another person&apos;s turn is never steered.
          </p>
        </div>
        <OnOffSwitch value={settings.sendSteersRunningTurn} busy={pending} onChange={save} />
      </div>
      {error === null ? null : (
        <p className="mt-3 font-sans text-[12.5px] text-danger" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
