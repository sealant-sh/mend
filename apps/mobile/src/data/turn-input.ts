/**
 * The text of a turn that carries images. The phone uploads each image beside the session first
 * (`POST /sessions/:id/images`, the same store the terminal's paste and Slack use) and the turn
 * names the path the workspace sees it at, in the shape Slack's opening turn uses: a heading, one
 * `[image: name · path]` line per image, and a line telling the agent to open them. A protocol
 * turn is plain text; the agent reads the file at the path.
 *
 * `parseTurnInput` reads that shape back off a recorded turn, so the conversation shows the
 * message and its images rather than the paths. Anything else stays text, untouched.
 */

export interface TurnImageRef {
  /** What the person picked, as the agent and the conversation name it. */
  readonly name: string;
  /** The file as the workspace sees it. */
  readonly path: string;
}

export const ATTACHED_HEADING = "Attached to the request:";
export const ATTACHED_IMAGES_NOTE =
  "Images from the phone are saved as files in the workspace, at the paths shown. Open a path to see the image.";
/** The request when a message is only images. */
export const IMAGES_ONLY_REQUEST = "The request is in the images attached to it.";

const LINE = /^\[image: ([^·\n]+) · ([^\]\n]+)\]$/;

/** Name characters that would break the line the agent and `parseTurnInput` read. */
export const cleanImageName = (name: string): string =>
  name
    .replace(/[[\]\n\r·]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export const imageLine = (image: TurnImageRef): string =>
  `[image: ${cleanImageName(image.name) || "image"} · ${image.path}]`;

/** The turn to submit: the message, then the images it carries. Text only when there are none. */
export const composeTurnInput = (text: string, images: ReadonlyArray<TurnImageRef>): string => {
  const message = text.trim();
  if (images.length === 0) return message;
  return [
    message === "" ? IMAGES_ONLY_REQUEST : message,
    [ATTACHED_HEADING, ...images.map(imageLine)].join("\n"),
    ATTACHED_IMAGES_NOTE,
  ].join("\n\n");
};

export interface ParsedTurnInput {
  readonly text: string;
  readonly images: ReadonlyArray<TurnImageRef>;
}

/** A recorded turn read back as its message and images; a turn in any other shape is all text. */
export const parseTurnInput = (input: string): ParsedTurnInput => {
  const plain: ParsedTurnInput = { text: input, images: [] };
  const suffix = `\n\n${ATTACHED_IMAGES_NOTE}`;
  if (!input.endsWith(suffix)) return plain;
  const body = input.slice(0, -suffix.length);
  const at = body.lastIndexOf(`\n\n${ATTACHED_HEADING}\n`);
  if (at === -1) return plain;
  const lines = body.slice(at + 2 + ATTACHED_HEADING.length + 1).split("\n");
  const images: Array<TurnImageRef> = [];
  for (const line of lines) {
    const match = LINE.exec(line);
    if (match === null || match[1] === undefined || match[2] === undefined) return plain;
    images.push({ name: match[1], path: match[2] });
  }
  const text = body.slice(0, at);
  return { text: text === IMAGES_ONLY_REQUEST ? "" : text, images };
};
