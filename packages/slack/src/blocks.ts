/**
 * The Block Kit Mend writes (https://docs.slack.dev/reference/block-kit), as plain types: only the
 * blocks and elements Mend uses, with Slack's field names. The limits Mend relies on are noted
 * where they bind.
 */

export interface PlainText {
  readonly type: "plain_text";
  /** 1 to 3,000 characters; 75 in a button or an option. */
  readonly text: string;
  readonly emoji?: boolean;
}

export interface MrkdwnText {
  readonly type: "mrkdwn";
  /** 1 to 3,000 characters. */
  readonly text: string;
}

export interface ButtonElement {
  readonly type: "button";
  readonly action_id: string;
  readonly text: PlainText;
  /** Up to 2,000 characters, sent back with the interaction. */
  readonly value?: string;
  /** Opened in the browser; Slack still sends an interaction, which the runner acknowledges. */
  readonly url?: string;
  readonly style?: "primary" | "danger";
}

export interface SelectOption {
  readonly text: PlainText;
  /** Up to 75 characters. */
  readonly value: string;
}

export interface StaticSelectElement {
  readonly type: "static_select";
  readonly action_id: string;
  readonly placeholder: PlainText;
  /** Up to 100 options. */
  readonly options: ReadonlyArray<SelectOption>;
}

export interface SectionBlock {
  readonly type: "section";
  readonly block_id?: string;
  readonly text: MrkdwnText;
  readonly accessory?: ButtonElement;
}

export interface ContextBlock {
  readonly type: "context";
  readonly block_id?: string;
  /** Up to 10 elements. */
  readonly elements: ReadonlyArray<MrkdwnText>;
}

export interface ActionsBlock {
  readonly type: "actions";
  /** Up to 255 characters; sent back with every interaction on its elements. */
  readonly block_id?: string;
  /** Up to 25 elements. */
  readonly elements: ReadonlyArray<ButtonElement | StaticSelectElement>;
}

/** Standard Markdown, rendered by Slack; up to 12,000 characters. */
export interface MarkdownBlock {
  readonly type: "markdown";
  readonly block_id?: string;
  readonly text: string;
}

export type SlackBlock = SectionBlock | ContextBlock | ActionsBlock | MarkdownBlock;

/**
 * A message as `chat.postMessage`, `chat.update` and `chat.postEphemeral` take it: `text` is the
 * fallback Slack shows in notifications and to screen readers.
 */
export interface SlackMessage {
  readonly text: string;
  readonly blocks: ReadonlyArray<SlackBlock>;
}
