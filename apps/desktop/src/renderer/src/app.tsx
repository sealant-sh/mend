import { InlineAlert } from "@mend/ui/components/banner";
import { Button } from "@mend/ui/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@mend/ui/components/ui/field";
import { Input } from "@mend/ui/components/ui/input";
import { cn } from "@mend/ui/lib/utils";
import { ArrowRight, X } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";

import type { ShellState } from "../../shared/bridge.ts";

const THEME_KEY = "mend-theme";

const applyTheme = (): void => {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    const dark =
      saved === "dark" ||
      ((saved === null || saved === "system") &&
        window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
  } catch {
    // Ignore storage access errors.
  }
};

const useSystemThemeSync = (): void => {
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => applyTheme();
    media.addEventListener("change", sync);
    window.addEventListener("storage", sync);
    return () => {
      media.removeEventListener("change", sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
};

export function App() {
  useSystemThemeSync();
  const [state, setState] = useState<ShellState | null>(null);

  useEffect(() => {
    const shell = window.mendShell;
    if (shell === undefined) return;
    let active = true;
    const loadInitial = async (): Promise<void> => {
      const initial = await shell.getState();
      if (active) setState(initial);
    };
    void loadInitial();
    const unsubscribe = shell.onStateChange((next) => {
      if (active) setState(next);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  if (state === null) {
    return <div className="min-h-dvh bg-canvas" />;
  }

  return (
    <ShellFrame
      platform={state.platform}
      subtitle={state.mode === "offline" ? state.serverUrl : null}
    >
      {state.mode === "offline" ? (
        <OfflineScreen state={state} />
      ) : (
        <ConnectScreen key={state.suggestedUrl ?? "empty"} state={state} onStateChange={setState} />
      )}
    </ShellFrame>
  );
}

function ShellFrame({
  platform,
  subtitle,
  children,
}: {
  readonly platform: ShellState["platform"];
  readonly subtitle: string | null;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-dvh bg-background lg:bg-canvas lg:p-sheet-inset">
      <div
        className={cn(
          "desktop-drag hidden w-sidebar shrink-0 flex-col gap-6 px-3 lg:flex",
          platform === "darwin" ? "pt-12" : "pt-3",
        )}
      >
        <div>
          <p className="text-lead font-semibold text-foreground">Mend</p>
          <p className="truncate font-mono text-meta text-muted-foreground">
            {subtitle ?? "Desktop"}
          </p>
        </div>
      </div>
      <main className="flex min-w-0 flex-1 flex-col bg-background lg:overflow-hidden lg:rounded-xl lg:border lg:border-sheet-border lg:shadow-sheet">
        <div className="mx-auto w-full max-w-140 flex-1 px-5 pt-12 pb-16 lg:pt-16">{children}</div>
      </main>
    </div>
  );
}

function ConnectScreen({
  state,
  onStateChange,
}: {
  readonly state: ShellState;
  readonly onStateChange: (next: ShellState) => void;
}) {
  const [url, setUrl] = useState(state.suggestedUrl ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connectTo = async (target: string) => {
    const shell = window.mendShell;
    if (shell === undefined || pending) return;
    setPending(true);
    setError(null);
    const result = await shell.connect(target);
    if (!result.ok) {
      setPending(false);
      setError(result.reason);
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void connectTo(url);
  };

  const handleRemoveRecent = async (target: string) => {
    const shell = window.mendShell;
    if (shell === undefined) return;
    const next = await shell.removeRecent(target);
    onStateChange(next);
  };

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-page font-semibold tracking-tight text-foreground">
          Connect to a Mend server
        </h1>
        <p className="mt-2 text-prose text-pretty text-muted-foreground">
          Enter the address of your Mend server. Sign in happens on the server itself.
        </p>
      </header>

      <form aria-label="Connect to a Mend server" onSubmit={handleSubmit}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="mend-server-address">Server address</FieldLabel>
            <Input
              id="mend-server-address"
              type="text"
              inputMode="url"
              autoComplete="url"
              autoFocus
              spellCheck={false}
              placeholder="https://mend.example.com"
              value={url}
              disabled={pending}
              onChange={(event) => {
                setUrl(event.target.value);
                if (error !== null) setError(null);
              }}
              className="font-mono text-row"
            />
            <FieldDescription>
              Use your server&apos;s address, such as{" "}
              <code className="font-mono text-meta text-foreground">http://localhost:3105</code> or{" "}
              <code className="font-mono text-meta text-foreground">https://mend.example.com</code>.
            </FieldDescription>
          </Field>
        </FieldGroup>

        {error === null ? null : (
          <div className="mt-6">
            <InlineAlert tone="error" title="Couldn't connect.">
              {error}
            </InlineAlert>
          </div>
        )}

        <div className="mt-8 flex items-center justify-between gap-4 border-t pt-7">
          {state.canCancelSwitch ? (
            <Button
              type="button"
              variant="secondary"
              disabled={pending}
              onClick={() => void window.mendShell?.cancelSwitch()}
            >
              Back
            </Button>
          ) : (
            <span />
          )}
          <Button type="submit" disabled={pending}>
            {pending ? "Connecting…" : "Connect"}
          </Button>
        </div>
      </form>

      {state.recentServers.length > 0 ? (
        <section aria-label="Recent servers" className="mt-10 border-t pt-6">
          <h2 className="mb-3 text-lead font-semibold text-foreground">Recent servers</h2>
          <ul className="divide-y divide-border">
            {state.recentServers.map((recent) => (
              <li key={recent} className="flex items-center justify-between gap-2 py-2">
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    setUrl(recent);
                    void connectTo(recent);
                  }}
                  className="flex min-w-0 flex-1 items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left font-mono text-row text-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50"
                >
                  <span className="truncate">{recent}</span>
                  <ArrowRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                </button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  aria-label={`Remove ${recent} from recent servers`}
                  onClick={() => void handleRemoveRecent(recent)}
                >
                  <X aria-hidden className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function OfflineScreen({ state }: { readonly state: ShellState }) {
  const [pending, setPending] = useState(false);

  const handleRetry = async () => {
    const shell = window.mendShell;
    if (shell === undefined || pending) return;
    setPending(true);
    const result = await shell.retry();
    if (!result.ok) {
      setPending(false);
    }
  };

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-page font-semibold tracking-tight text-foreground">
          Can&apos;t reach Mend
        </h1>
        <p className="mt-2 text-prose text-pretty text-muted-foreground">
          {state.offlineReason ?? "The Mend server didn't answer."}
        </p>
      </header>

      {state.serverUrl === null ? null : (
        <div className="mb-6 rounded-lg border bg-muted/50 px-3.5 py-2.5 font-mono text-row break-all text-foreground">
          {state.serverUrl}
        </div>
      )}

      <p role="status" className="text-row text-muted-foreground">
        {pending
          ? "Checking server…"
          : state.reconnecting
            ? "Reconnecting… Mend will reload as soon as the server answers."
            : "Waiting to reconnect."}
      </p>

      <div className="mt-8 flex items-center justify-between gap-4 border-t pt-7">
        <Button
          type="button"
          variant="secondary"
          disabled={pending}
          onClick={() => void window.mendDesktop?.switchServer()}
        >
          Switch server
        </Button>
        <Button type="button" disabled={pending} onClick={() => void handleRetry()}>
          {pending ? "Checking…" : "Try again"}
        </Button>
      </div>
    </div>
  );
}
