import { Button } from "@mend/ui/components/ui/button";
import { Input } from "@mend/ui/components/ui/input";
import { Label } from "@mend/ui/components/ui/label";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";

import { Titlebar } from "#/components/titlebar";
import { useConnection } from "#/lib/connection";
import { queryClient } from "#/lib/queries";

import type { SignOutResult } from "../../../shared/bridge";

/**
 * Where the desktop points, and who it is. Signing in is `mend login`'s walk: the app opens an
 * authorize request, the browser shows the code, someone signed in there approves it, and this
 * machine becomes a listed device (Settings → Devices on the web) with its own revocable token.
 * The token and its device id land in the credential file the CLI shares, so either side signs
 * both in. A pasted token is the fallback for a server without a browser in reach.
 */

interface ConnectSearch {
  readonly reason?: "signed-out" | "unauthorized";
}

type Authorize =
  | { readonly kind: "idle" }
  | { readonly kind: "opening" }
  | {
      readonly kind: "waiting";
      readonly code: string;
      readonly authorizeUrl: string;
      readonly expiresAt: string;
    };

const expiryLine = (expiresAt: string): string => {
  const at = Date.parse(expiresAt);
  return Number.isNaN(at) ? "" : ` · open until ${new Date(at).toLocaleTimeString()}`;
};

const revokeLine = (revoke: SignOutResult["revoke"]): string =>
  revoke === "revoked"
    ? "Signed out · the device was revoked on the server."
    : revoke === "not-revoked"
      ? "Signed out here · the server did not revoke the device; end it under Settings → Devices on the web."
      : revoke === "environment"
        ? "Still signed in · MEND_TOKEN supplies this app's token. Unset it and restart to sign out; the credential file was left as it was."
        : "Signed out · the token was removed from the credential file.";

export const Route = createFileRoute("/connect")({
  validateSearch: (search: Record<string, unknown>): ConnectSearch => {
    const reason = search["reason"];
    return reason === "signed-out" || reason === "unauthorized" ? { reason } : {};
  },
  component: Connect,
});

/* Sign-in scale: the ui Input at form height, on the panel ground. */
const field = "no-drag h-10 bg-panel text-[14px]";

function Connect() {
  const { reason } = Route.useSearch();
  const navigate = useNavigate();
  const connection = useConnection();
  const [url, setUrl] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [mode, setMode] = useState<"browser" | "token">("browser");
  const [authorize, setAuthorize] = useState<Authorize>({ kind: "idle" });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Bumped per walk and on cancel: an answer for an abandoned walk changes nothing. */
  const walk = useRef(0);

  const serverUrl = url ?? connection?.url ?? "";

  const finish = async () => {
    queryClient.clear();
    await navigate({ to: "/" });
  };

  const signInWithBrowser = async () => {
    walk.current += 1;
    const mine = walk.current;
    setAuthorize({ kind: "opening" });
    const opened = await window.mend.connection.authorize(serverUrl);
    if (mine !== walk.current) return;
    if (!opened.ok) {
      setAuthorize({ kind: "idle" });
      setError(opened.reason);
      return;
    }
    setUrl(opened.url);
    setAuthorize({
      kind: "waiting",
      code: opened.code,
      authorizeUrl: opened.authorizeUrl,
      expiresAt: opened.expiresAt,
    });
    const result = await window.mend.connection.awaitAuthorize();
    if (mine !== walk.current) return;
    setAuthorize({ kind: "idle" });
    if (!result.ok) {
      setError(result.reason);
      return;
    }
    await finish();
  };

  const submit = async () => {
    setError(null);
    setNotice(null);
    if (mode === "browser") {
      await signInWithBrowser();
      return;
    }
    if (token.trim() === "") {
      setError("paste the token first");
      return;
    }
    setPending(true);
    try {
      await window.mend.connection.setToken({ url: serverUrl, token });
      await finish();
    } finally {
      setPending(false);
    }
  };

  const note =
    reason === "unauthorized"
      ? "The saved token was rejected — sign in again."
      : reason === "signed-out"
        ? "Not signed in to a Mend server yet."
        : null;

  const busy = pending || authorize.kind !== "idle";

  return (
    <>
      <Titlebar liveCount={null} />
      <main className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto bg-canvas px-6 py-16">
        <form
          className="w-full max-w-[440px] rounded-2xl border border-rule bg-panel p-6 shadow-sm"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <p className="font-mono text-[11px] tracking-[0.57px] text-muted-foreground">
            MEND / CONNECT
          </p>
          <h1 className="mt-1.5 font-display text-[24px] leading-tight font-medium text-foreground">
            Connect to your Mend server
          </h1>
          {note !== null && <p className="mt-2 font-sans text-[13.5px] text-warning">{note}</p>}

          <div className="mt-5 grid gap-1.5">
            <Label htmlFor="connect-url">Server URL</Label>
            <Input
              id="connect-url"
              className={`${field} font-mono text-[13.5px]`}
              value={serverUrl}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="http://localhost:3105"
              spellCheck={false}
              autoCapitalize="off"
              disabled={authorize.kind !== "idle"}
            />
          </div>

          {mode === "browser" ? (
            authorize.kind === "waiting" ? (
              <div className="mt-4 rounded-xl border border-rule bg-canvas px-4 py-3">
                <p className="font-sans text-[12.5px] text-label">
                  Approve in the browser if it shows this code
                </p>
                <p className="mt-1 font-mono text-[22px] tracking-[0.12em] text-foreground">
                  {authorize.code}
                </p>
                <p className="mt-2 font-mono text-[11.5px] break-all text-label">
                  <button
                    type="button"
                    className="text-left text-primary underline-offset-2 hover:underline"
                    onClick={() => void window.mend.shell.openExternal(authorize.authorizeUrl)}
                  >
                    {authorize.authorizeUrl}
                  </button>
                </p>
                <p className="mt-2 font-mono text-[11.5px] text-muted-foreground">
                  waiting for approval{expiryLine(authorize.expiresAt)} · nothing is granted until
                  someone approves
                </p>
              </div>
            ) : (
              <p className="mt-4 font-sans text-[13px] leading-relaxed text-label">
                Your browser opens on the server&apos;s approve page. Sign in there if asked, check
                the code matches, and approve. This machine is then a device you can revoke under
                Settings → Devices.
              </p>
            )
          ) : (
            <div className="mt-4 grid gap-1.5">
              <Label htmlFor="connect-token">Bearer token</Label>
              <Input
                id="connect-token"
                className={`${field} font-mono text-[13.5px]`}
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder="the token mend login saved, or MEND_AUTH_STATIC_TOKEN in dev"
                spellCheck={false}
                autoCapitalize="off"
                autoFocus
              />
            </div>
          )}

          {error !== null && <p className="mt-3 font-sans text-[12.5px] text-danger">{error}</p>}

          {notice !== null && <p className="mt-3 font-sans text-[12.5px] text-label">{notice}</p>}

          <div className="mt-6 flex items-center gap-3">
            {authorize.kind === "waiting" ? (
              <Button
                key="cancel"
                type="button"
                variant="outline"
                size="lg"
                onClick={(event) => {
                  // The submit button takes this spot on the same render: keep the click from
                  // submitting the form it lands in.
                  event.preventDefault();
                  walk.current += 1;
                  setAuthorize({ kind: "idle" });
                  void window.mend.connection.cancelAuthorize();
                }}
              >
                Cancel
              </Button>
            ) : (
              <Button key="submit" type="submit" size="lg" disabled={busy || serverUrl === ""}>
                {mode === "token"
                  ? pending
                    ? "Saving…"
                    : "Use this token"
                  : authorize.kind === "opening"
                    ? "Opening…"
                    : "Sign in with the browser"}
              </Button>
            )}
            {authorize.kind === "idle" && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setError(null);
                  setMode(mode === "browser" ? "token" : "browser");
                }}
              >
                {mode === "browser" ? "Paste a token instead" : "Sign in with the browser"}
              </Button>
            )}
            <span className="flex-1" />
            {connection?.signedIn === true && authorize.kind === "idle" && (
              <Button type="button" variant="ghost" onClick={() => void finish()}>
                Back to the cockpit
              </Button>
            )}
          </div>

          <p className="mt-6 font-sans text-[12.5px] leading-relaxed text-label">
            {connection === null
              ? ""
              : `credential file · ${connection.configPath} — shared with the mend CLI; mend login and mend logout land here too.`}
          </p>
          {connection?.signedIn === true && (
            <Button
              type="button"
              variant="destructive"
              size="sm"
              className="mt-2"
              onClick={() => {
                void window.mend.connection.signOut().then((result) => {
                  if (result.revoke !== "environment") queryClient.clear();
                  setNotice(revokeLine(result.revoke));
                  return null;
                });
              }}
            >
              sign out · revokes this device when it is one, removes the token
            </Button>
          )}
        </form>
      </main>
    </>
  );
}
