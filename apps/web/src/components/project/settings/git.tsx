import { useQuery, useQueryClient } from "@tanstack/react-query";

import { githubRepoOf } from "#/components/git-key-card";
import { CodeBox } from "#/components/kit/code-box";
import { Panel, SettingsSection } from "#/components/kit/section";
import { Segment } from "#/components/kit/segment";
import { StatusWord } from "#/components/kit/status";
import { type ProjectDetailDto } from "#/lib/api";
import { useProjectSetting } from "#/lib/project-settings";
import { useTRPC } from "#/lib/trpc";

import type { SettingsReads } from "./reads";

/** What the Git tab reads before it shows: the key, so the public half shows at once. */
export const gitReads: SettingsReads = ({ queryClient, trpc }) => [
  queryClient.prefetchQuery(trpc.git.key.queryOptions()),
];

/**
 * Project settings · Git (screen L5): how sessions here push and fetch (docs/GIT-ACCESS.md). The
 * Mend key is the caller's own key on the server, added to their git account once; Bridge signs
 * through the ssh-agent on their own machine while `mend keys share` runs there. Both sign SSH
 * remotes, so a private repository needs its SSH URL.
 */
export function GitSettings({ detail }: { readonly detail: ProjectDetailDto }) {
  const { project, capabilities } = detail;
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  // Choosing the Mend key creates it when it does not exist yet.
  const access = useProjectSetting(project.id, "gitAuthMode", {
    onSaved: () => queryClient.invalidateQueries(trpc.git.key.queryFilter()),
  });

  return (
    <Panel>
      <SettingsSection
        title="Git access"
        why="How sessions push and fetch. New projects start from your choice in Settings › Git access."
      >
        <Segment
          label="Git access"
          value={project.gitAuthMode}
          disabled={!capabilities.manage}
          onChange={(value) => access.mutate(value)}
          options={[
            { value: "mend-key", label: "Mend key" },
            { value: "bridge", label: "Bridge" },
          ]}
        />
        <p role="alert" className="mt-2 font-mono text-[11.5px] text-danger empty:hidden">
          {access.isError
            ? `Not saved: ${access.error instanceof Error ? access.error.message : String(access.error)}. Git access is back as it was.`
            : ""}
        </p>
        <div className="mt-3">
          {project.gitAuthMode === "mend-key" ? (
            <MendKey originUrl={project.originUrl} />
          ) : (
            <BridgePresence />
          )}
        </div>
      </SettingsSection>
    </Panel>
  );
}

function MendKey({ originUrl }: { readonly originUrl: string | null }) {
  const trpc = useTRPC();
  const key = useQuery(trpc.git.key.queryOptions());
  if (key.isPending)
    return (
      <p role="status" className="font-mono text-[12px] text-muted-foreground">
        Reading your Mend key…
      </p>
    );
  if (key.isError)
    return (
      <p role="alert" className="font-mono text-[12px] text-danger">
        Your Mend key did not load: {key.error.message}
      </p>
    );
  const publicKey = key.data.publicKey;
  if (publicKey === null)
    return <StatusWord tone="off">no Mend key yet · choosing Mend key creates it</StatusWord>;
  const repo = githubRepoOf(originUrl);
  return (
    <div className="grid gap-2">
      <CodeBox copy={publicKey} label="your Mend public key">
        {publicKey}
      </CodeBox>
      {key.data.fingerprint === null ? null : (
        <p className="font-mono text-[11px] text-faint">{key.data.fingerprint}</p>
      )}
      <p className="text-[12.5px] text-muted-foreground">
        Add it to your git account&apos;s SSH keys (
        <a
          href="https://github.com/settings/ssh/new"
          target="_blank"
          rel="noreferrer"
          className="text-ink-2 underline underline-offset-2"
        >
          GitHub
        </a>
        ), or as a deploy key with write access on{" "}
        {repo === null ? (
          "this repository"
        ) : (
          <a
            href={`https://github.com/${repo}/settings/keys/new`}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-[12px] text-ink-2 underline underline-offset-2"
          >
            {repo}
          </a>
        )}{" "}
        for this project only.
      </p>
    </div>
  );
}

function BridgePresence() {
  const trpc = useTRPC();
  const bridge = useQuery(
    trpc.git.bridgeStatus.queryOptions(undefined, { refetchInterval: 5_000 }),
  );
  if (bridge.isPending)
    return (
      <p role="status" className="font-mono text-[12px] text-muted-foreground">
        Looking for a connected signer…
      </p>
    );
  if (bridge.isError)
    return (
      <p role="alert" className="font-mono text-[12px] text-danger">
        The bridge did not answer: {bridge.error.message}
      </p>
    );
  return bridge.data.connected ? (
    <StatusWord tone="ok">
      signer connected · {bridge.data.clientName ?? "unknown machine"} · observed
    </StatusWord>
  ) : (
    <div className="grid gap-1.5">
      <StatusWord tone="off">no signer connected · observed</StatusWord>
      <p className="max-w-[60ch] text-[12.5px] text-muted-foreground">
        Run <span className="font-mono text-[12px]">mend keys share</span> on the machine that holds
        your key. Until a signer connects, this project&apos;s SSH git operations fail with a reason
        instead of waiting.
      </p>
    </div>
  );
}
