import {
  HOST_USER_NAMESPACES_REFUSED,
  hostUserNamespacesFix,
  hostUserNamespacesRefusalParts,
} from "@mend/domain/workbench";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { useTRPC } from "#/lib/trpc";

/**
 * A host whose kernel refuses unprivileged user namespaces (Ubuntu 23.10 and later, by default)
 * stops every workspace's rootless Docker service, so no session can start there. The server
 * reports it on its machine view (`userNamespaces`), as `mend doctor` does; these show it in the
 * same words, with the command that allows them.
 */

function CopyCommand({ command }: { readonly command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(command).then(() => setCopied(true));
      }}
      className="shrink-0 font-sans text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

/**
 * Undefined while nothing refuses them (or nothing was observed); else the setting that allows
 * them, null when the server did not name one.
 */
function useRefusedSetting(): string | null | undefined {
  const trpc = useTRPC();
  const observed = useQuery(
    trpc.platform.machine.queryOptions(undefined, { staleTime: 30_000, refetchInterval: 30_000 }),
  ).data?.userNamespaces;
  if (observed === undefined || observed.allowed) return undefined;
  return observed.setting;
}

/** The finding, with the command to run on the server's host. Nothing while the host allows them. */
export function WorkspacesRefusedNotice() {
  const setting = useRefusedSetting();
  if (setting === undefined) return null;
  const command = setting === null ? null : hostUserNamespacesFix(setting);
  return (
    <div className="mt-6 max-w-[760px] border-l-2 border-[var(--sw-red)] pl-3">
      <p className="text-[13px] leading-relaxed text-danger">{HOST_USER_NAMESPACES_REFUSED}</p>
      {command === null ? null : (
        <>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-2">
            Every workspace runs a rootless Docker service, which needs them. Run this on the
            server&apos;s host; the next launch reads the host again, no restart.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <code className="rounded-md bg-[var(--sw-sunken)] px-1.5 py-0.5 font-mono text-[12px] break-all text-ink-2 select-all">
              {command}
            </code>
            <CopyCommand command={command} />
          </div>
        </>
      )}
    </div>
  );
}

/** The sidebar's line for the same finding: short, its whole sentence on hover. */
export function WorkspacesRefusedLine() {
  const setting = useRefusedSetting();
  if (setting === undefined) return null;
  return (
    <p className="font-mono text-[11.5px] text-danger" title={HOST_USER_NAMESPACES_REFUSED}>
      workspaces · refused by the host
    </p>
  );
}

/** A session line as the server wrote it, with the refusal's command set apart when it has one. */
export function SummaryText({ summary }: { readonly summary: string }) {
  const parts = hostUserNamespacesRefusalParts(summary);
  if (parts === null) return <>{summary}</>;
  return (
    <>
      {parts.lead}
      <code className="rounded-md bg-[var(--sw-sunken)] px-1.5 py-0.5 font-mono text-[12px] break-all text-ink-2">
        {parts.command}
      </code>
      {parts.rest}
    </>
  );
}
