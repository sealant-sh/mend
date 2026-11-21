/**
 * Server reachability probe used before switching servers and during background reconnects.
 *
 * Calls `${url}/api/health` with a short timeout. A 2xx response means Mend answered directly; a
 * 3xx/401/403 response means a reverse proxy or access gate is answering in front of the server, so
 * loading it in the window can still proceed to sign-in. Network errors, timeouts, and 5xx answers
 * report a plain-English failure reason.
 */

export type ProbeResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

const DEFAULT_TIMEOUT_MS = 5_000;

const describeFetchError = (error: unknown, timedOut: boolean): string => {
  if (timedOut) return "The server didn't answer in time.";
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error && "cause" in error ? error.cause : undefined;
  const code =
    typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
      ? cause.code
      : "";

  if (code === "ECONNREFUSED" || message.includes("ECONNREFUSED")) {
    return "Connection refused. Check that Mend is running at this address.";
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || message.includes("ENOTFOUND")) {
    return "Couldn't resolve that hostname. Check the address and your network.";
  }
  if (
    code.startsWith("ERR_TLS") ||
    code.includes("CERT") ||
    message.toLowerCase().includes("certificate")
  ) {
    return "The server's TLS certificate wasn't trusted.";
  }
  return "Couldn't reach this server. Check the address and your connection.";
};

export const probeServer = async (
  serverUrl: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ProbeResult> => {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetchImpl(`${serverUrl}/api/health`, {
      method: "GET",
      redirect: "manual",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });

    if (response.status >= 500) {
      return {
        ok: false,
        reason: `The server answered with HTTP ${response.status}. Try again in a moment.`,
      };
    }

    if (response.status === 404) {
      return {
        ok: false,
        reason: "Nothing answered at /api/health. Check that this address points to a Mend server.",
      };
    }

    return { ok: true };
  } catch (error) {
    return { ok: false, reason: describeFetchError(error, timedOut) };
  } finally {
    clearTimeout(timer);
  }
};
