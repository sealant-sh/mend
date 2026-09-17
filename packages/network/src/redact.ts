/**
 * Query parameters that are credentials (docs/adr/0004, "Upgrade tickets"; MEND-08). Anything that
 * writes a request URL down, a log line, an error, an audit row, passes it through here first. An
 * upgrade ticket is dead thirty seconds after it was minted and a `?token=` is a long-lived bearer,
 * but a log should hold neither.
 */
export const CREDENTIAL_QUERY_PARAMETERS: ReadonlyArray<string> = ["token", "ticket", "code"];

/**
 * The URL (absolute, or a path with a query) with every credential parameter's value replaced.
 * Malformed input comes back with its whole query dropped: when in doubt, less.
 */
export const redactUrl = (url: string): string => {
  const at = url.indexOf("?");
  if (at === -1) return url;
  const path = url.slice(0, at);
  const hash = url.indexOf("#", at);
  const query = hash === -1 ? url.slice(at + 1) : url.slice(at + 1, hash);
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(query);
  } catch {
    return path;
  }
  const kept = [...params.entries()].map(([name, value]) =>
    CREDENTIAL_QUERY_PARAMETERS.includes(name.toLowerCase())
      ? `${encodeURIComponent(name)}=redacted`
      : `${encodeURIComponent(name)}=${encodeURIComponent(value)}`,
  );
  return kept.length === 0 ? path : `${path}?${kept.join("&")}`;
};
