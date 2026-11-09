import type { EndpointUrl } from "@mend/domain/endpoint-url";
import type { AgentEvent } from "@mend/domain/workbench";

const ENDPOINT_PLACEHOLDER = "<endpoint>";

const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A harness's words without its endpoint (docs/adr/0018, decision 11): every URL on the endpoint's
 * host, the endpoint's path and its host. Anyone who can see the session reads these words, and
 * only the person who added the login may see the host. Codex 0.160.1 ends the error of a turn
 * the endpoint refused with the request's full URL.
 */
const redactEndpoint = (text: string, baseUrl: EndpointUrl): string => {
  const url = new URL(baseUrl);
  const onHost = new RegExp(
    `\\b[a-z][a-z0-9+.-]*://${literal(url.hostname)}(?![\\w.-])[^\\s"'\`<>)]*`,
    "gi",
  );
  const host = new RegExp(
    `(?<![\\w.-])${literal(url.hostname)}(?::\\d+)?(?![\\w-]|\\.[\\w-])`,
    "gi",
  );
  const withoutUrls = text.replace(onHost, ENDPOINT_PLACEHOLDER);
  const withoutPath =
    url.pathname === "/" ? withoutUrls : withoutUrls.replaceAll(url.pathname, ENDPOINT_PLACEHOLDER);
  return withoutPath.replace(host, ENDPOINT_PLACEHOLDER);
};

/** An event as the adapter publishes it for a login on `baseUrl`: its error words redacted. */
export const withoutEndpoint = (
  event: AgentEvent,
  baseUrl: EndpointUrl | undefined,
): AgentEvent => {
  if (baseUrl === undefined) return event;
  switch (event._tag) {
    case "turn.completed":
      return event.error === null
        ? event
        : { ...event, error: redactEndpoint(event.error, baseUrl) };
    case "runtime.error":
    case "runtime.warning":
      return { ...event, message: redactEndpoint(event.message, baseUrl) };
    default:
      return event;
  }
};
