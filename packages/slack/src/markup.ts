/**
 * Slack's message markup (https://docs.slack.dev/messaging/formatting-message-text): the text of a
 * message arrives with `&`, `<` and `>` escaped, and with mentions, channels and links wrapped in
 * angle brackets. Mend reads that text as plain text: a prompt, a thread quoted to an agent, an
 * option value. What Mend writes back is escaped again.
 */

/** Names for the user ids a text mentions; an unknown id is written as itself. */
export type SlackUserNames = (userId: string) => string | undefined;

const noNames: SlackUserNames = () => undefined;

/** `<@U123>` or `<@U123|name>`, for one user id; the id is Slack's, so it needs no escaping. */
export const userMentionPattern = (userId: string): RegExp =>
  new RegExp(`<@${userId}(?:\\|[^>]*)?>`, "g");

const decodeEntities = (text: string): string =>
  text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

/**
 * The plain text of a Slack message. A link becomes its URL (a `mailto:` link its address), a
 * mention `@name`, a channel `#name`, and `&amp;`, `&lt;` and `&gt;` their characters.
 */
export const slackToPlain = (text: string, names: SlackUserNames = noNames): string =>
  decodeEntities(
    text.replaceAll(/<([^<>]*)>/g, (_whole, inner: string) => {
      const bar = inner.indexOf("|");
      const target = bar === -1 ? inner : inner.slice(0, bar);
      const label = bar === -1 ? null : inner.slice(bar + 1);
      if (target.startsWith("@")) {
        const id = target.slice(1);
        return `@${names(id) ?? label ?? id}`;
      }
      if (target.startsWith("#")) return `#${label ?? target.slice(1)}`;
      if (target.startsWith("!")) {
        // `<!here>`, `<!channel>`, `<!subteam^S1|@team>`, `<!date^…|fallback>`.
        if (label !== null) return label;
        const word = target.slice(1).split("^")[0] ?? "";
        return `@${word}`;
      }
      if (target.startsWith("mailto:")) return label ?? target.slice("mailto:".length);
      return target;
    }),
  );

/** Text escaped for a `mrkdwn` or `plain_text` field: Slack's three control characters. */
export const escapeSlack = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
