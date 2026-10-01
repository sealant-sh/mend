import { Agent, setGlobalDispatcher } from "undici";

/**
 * Every request and WebSocket this CLI makes goes over HTTP/1.1.
 *
 * Node 26's built-in `fetch` (undici 8) negotiates HTTP/2 with any server that offers it, and
 * multiplexes the whole process onto one connection: the dashboard's and the tunnels'
 * `/api/events` streams, every API call, and the attempt to open a terminal. On alpha
 * (2026-10-01) that connection wedged after the events stream opened: the next request was
 * created and never sent, and every request after it queued behind it. A dashboard launch sat at
 * "starting" for 11 minutes, and `mend attach` timed out on its upgrade ticket. The same process
 * on HTTP/1.1 attached in about a second. One request per connection cannot wedge another.
 *
 * `connect` exists for tests (a private CA); the CLI itself uses the defaults.
 */
export const cliDispatcher = (connect?: Agent.Options["connect"]): Agent =>
  new Agent({ allowH2: false, ...(connect === undefined ? {} : { connect }) });

/** Install the HTTP/1.1 dispatcher for the global `fetch` and `WebSocket`, before any request. */
export const useHttp1 = (): void => {
  setGlobalDispatcher(cliDispatcher());
};
