import { InlineAlert } from "@mend/ui/components/banner";
import { CopyField } from "@mend/ui/components/copy-field";
import { Button } from "@mend/ui/components/ui/button";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { failureWords } from "#/lib/refusal";
import { useTRPC } from "#/lib/trpc";

/** Whether a clone of this address signs with a key (SSH or SCP-style), where Mend's key matters. */
export const signsWithKey = (source: string | null): boolean =>
  source !== null && /^(ssh:\/\/|[^/@:]+@[^/:]+:)/.test(source.trim());

/**
 * After a failed clone over SSH: "Show Mend's key", then the key to add to the repository or a
 * GitHub account that can read it. Nothing for an address that doesn't sign with a key.
 */
export function MendKeyHelp({
  source,
  touch,
}: {
  readonly source: string | null;
  /** On a phone the controls are 44px touch targets. */
  readonly touch: boolean;
}) {
  const trpc = useTRPC();
  const [showKey, setShowKey] = useState(false);
  const access = useQuery({ ...trpc.git.access.queryOptions(), enabled: showKey });
  const size = touch ? "touch" : "default";
  if (!signsWithKey(source)) return null;
  if (!showKey)
    return (
      <Button variant="link" className="self-start" onClick={() => setShowKey(true)}>
        Show Mend's key
      </Button>
    );
  if (access.isPending)
    return (
      <p role="status" className="text-row text-muted-foreground">
        Reading Mend's key…
      </p>
    );
  if (access.isError)
    return (
      <InlineAlert size={size} title="Mend's key couldn't be read.">
        {failureWords(access.error, "The Mend server didn't answer.")}
      </InlineAlert>
    );
  if (access.data.key.publicKey === null)
    return (
      <p className="text-row text-muted-foreground">
        You have no Mend key yet. Make one in Settings under Git access.
      </p>
    );
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-row text-muted-foreground">
        Add this key to the repository as a deploy key, or to a GitHub account that can read it.
        Then try again.
      </p>
      <CopyField value={access.data.key.publicKey} label="Copy key" size={size} />
    </div>
  );
}
