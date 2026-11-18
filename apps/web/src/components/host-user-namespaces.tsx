import { hostUserNamespacesFix } from "@mend/domain/workbench";
import { Banner } from "@mend/ui/components/banner";
import { CopyField } from "@mend/ui/components/copy-field";
import { useQuery } from "@tanstack/react-query";

import { useTRPC } from "#/lib/trpc";

/**
 * A host whose kernel refuses unprivileged user namespaces (Ubuntu 23.10 and later, by default)
 * stops every workspace's rootless Docker service, so no session can start there. The server
 * reports it on its machine view (`userNamespaces`), as `mend doctor` does. This band says so with
 * the command that allows them. Nothing shows while the host allows them, while the read is
 * pending, or when it failed: the composer still works, and a start reports the refusal itself.
 */
export function WorkspacesRefusedBanner({ layout }: { readonly layout: "inline" | "stacked" }) {
  const trpc = useTRPC();
  const machine = useQuery(
    trpc.platform.machine.queryOptions(undefined, { staleTime: 30_000, refetchInterval: 30_000 }),
  );
  if (machine.isPending || machine.isError) return null;
  const observed = machine.data.userNamespaces;
  if (observed === undefined || observed.allowed) return null;
  const command = observed.setting === null ? null : hostUserNamespacesFix(observed.setting);
  return (
    <Banner tone="error" layout={layout} title="No session can start on this server.">
      Its host refuses user namespaces, and every workspace's Docker service needs them.{" "}
      {command === null ? (
        <>
          Run <code className="font-mono">mend server setup --allow-userns</code> on the host to
          allow them.
        </>
      ) : (
        <>
          Run <code className="font-mono">mend server setup --allow-userns</code> on the host, or
          this command there. The next session reads the host again; nothing needs a restart.
          <CopyField value={command} className="mt-2" />
        </>
      )}
    </Banner>
  );
}
