/**
 * The conversation composer's pure parts: the images a message carries and where each one is on
 * its way to the session, whether the message can be sent, and how tall the text field is. The
 * native side (image-attach.ts, components/composer.tsx) feeds events in and renders what comes
 * out; nothing here touches React Native, so it runs under vitest.
 */

// ─── limits ─────────────────────────────────────────────────────────────────

/** The server's cap on one image (packages/sessions `PASTED_IMAGE_MAX_BYTES`). */
export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
/** What one message carries at most, as a Slack turn does. */
export const MAX_IMAGES_PER_MESSAGE = 10;

/**
 * How an image is shrunk before it goes up, tried in order until it fits the server's cap. Both
 * agents downscale past ~2000px anyway, so the first step loses nothing they would read; the
 * later ones only matter for an image the first cannot fit.
 */
export const PREPARE_STEPS: ReadonlyArray<{ readonly maxEdge: number; readonly quality: number }> =
  [
    { maxEdge: 2048, quality: 0.8 },
    { maxEdge: 1600, quality: 0.6 },
    { maxEdge: 1200, quality: 0.5 },
  ];

/** The size to scale to so the long edge fits `maxEdge`, or null when it already does. */
export const fitWithin = (
  width: number,
  height: number,
  maxEdge: number,
): { readonly width: number; readonly height: number } | null => {
  const long = Math.max(width, height);
  if (!(long > maxEdge) || width <= 0 || height <= 0) return null;
  const scale = maxEdge / long;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
};

/** The bytes a base64 string decodes to. */
export const base64ByteLength = (base64: string): number => {
  const trimmed = base64.replace(/\s/g, "");
  let padding = 0;
  if (trimmed.endsWith("==")) padding = 2;
  else if (trimmed.endsWith("=")) padding = 1;
  return Math.floor((trimmed.length * 3) / 4) - padding;
};

/**
 * The name an image goes up under: what the picker called it, as the JPEG it becomes (a HEIC from
 * the camera roll is converted), or `image <n>.jpg` when the picker gave none.
 */
export const imageName = (fileName: string | null | undefined, ordinal: number): string => {
  const base = (fileName ?? "").replace(/\.[A-Za-z0-9]+$/, "").trim();
  return `${base === "" ? `image ${ordinal}` : base}.jpg`;
};

// ─── attachments ────────────────────────────────────────────────────────────

export type AttachmentPhase =
  /** Being scaled and converted on the phone. */
  | { readonly kind: "preparing" }
  /** Going up; `sent` is the fraction the request has sent, 0 to 1. */
  | { readonly kind: "uploading"; readonly sent: number }
  /** Stored beside the session; `path` is what the turn names. */
  | { readonly kind: "stored"; readonly path: string; readonly bytes: number }
  | { readonly kind: "failed"; readonly message: string };

export interface Attachment {
  readonly id: string;
  /** A local URI the thumbnail shows. */
  readonly uri: string;
  readonly name: string;
  readonly phase: AttachmentPhase;
}

export type AttachmentEvent =
  | {
      readonly type: "added";
      readonly id: string;
      readonly uri: string;
      readonly name: string;
    }
  | { readonly type: "prepared"; readonly id: string }
  | { readonly type: "progress"; readonly id: string; readonly sent: number }
  | { readonly type: "stored"; readonly id: string; readonly path: string; readonly bytes: number }
  | { readonly type: "failed"; readonly id: string; readonly message: string }
  | { readonly type: "retried"; readonly id: string }
  | { readonly type: "removed"; readonly id: string }
  /** A message that did not send, put back into the composer with its stored images. */
  | { readonly type: "restored"; readonly attachments: ReadonlyArray<Attachment> }
  /** The message was sent: its images go with it. */
  | { readonly type: "cleared" };

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

const update = (
  attachments: ReadonlyArray<Attachment>,
  id: string,
  next: (attachment: Attachment) => AttachmentPhase | null,
): ReadonlyArray<Attachment> => {
  let changed = false;
  const updated = attachments.map((attachment) => {
    if (attachment.id !== id) return attachment;
    const phase = next(attachment);
    if (phase === null) return attachment;
    changed = true;
    return { ...attachment, phase };
  });
  return changed ? updated : attachments;
};

/**
 * One image's way to the session: preparing → uploading → stored, or failed from either and back
 * to preparing on a retry. An event that does not fit the image's phase is ignored — a late
 * progress report after the image was stored, or an upload that finishes after it was removed —
 * so the order callbacks land in cannot put an image in a phase it has left.
 */
export const attachmentsReducer = (
  attachments: ReadonlyArray<Attachment>,
  event: AttachmentEvent,
): ReadonlyArray<Attachment> => {
  switch (event.type) {
    case "added":
      if (
        attachments.length >= MAX_IMAGES_PER_MESSAGE ||
        attachments.some((attachment) => attachment.id === event.id)
      ) {
        return attachments;
      }
      return [
        ...attachments,
        { id: event.id, uri: event.uri, name: event.name, phase: { kind: "preparing" } },
      ];
    case "prepared":
      return update(attachments, event.id, ({ phase }) =>
        phase.kind === "preparing" ? { kind: "uploading", sent: 0 } : null,
      );
    case "progress":
      return update(attachments, event.id, ({ phase }) => {
        if (phase.kind !== "uploading") return null;
        const sent = clamp01(event.sent);
        return sent > phase.sent ? { kind: "uploading", sent } : null;
      });
    case "stored":
      return update(attachments, event.id, ({ phase }) =>
        phase.kind === "uploading"
          ? { kind: "stored", path: event.path, bytes: event.bytes }
          : null,
      );
    case "failed":
      return update(attachments, event.id, ({ phase }) =>
        phase.kind === "preparing" || phase.kind === "uploading"
          ? { kind: "failed", message: event.message }
          : null,
      );
    case "retried":
      return update(attachments, event.id, ({ phase }) =>
        phase.kind === "failed" ? { kind: "preparing" } : null,
      );
    case "removed": {
      const kept = attachments.filter((attachment) => attachment.id !== event.id);
      return kept.length === attachments.length ? attachments : kept;
    }
    case "restored": {
      const held = new Set(attachments.map((attachment) => attachment.id));
      const room = MAX_IMAGES_PER_MESSAGE - attachments.length;
      const back = event.attachments.filter((attachment) => !held.has(attachment.id));
      return back.length === 0
        ? attachments
        : [...attachments, ...back.slice(0, Math.max(0, room))];
    }
    case "cleared":
      return attachments.length === 0 ? attachments : [];
  }
};

/** The images a message sends, in the order they were attached. */
export const storedImages = (
  attachments: ReadonlyArray<Attachment>,
): ReadonlyArray<{ readonly name: string; readonly path: string; readonly uri: string }> =>
  attachments.flatMap((attachment) =>
    attachment.phase.kind === "stored"
      ? [{ name: attachment.name, path: attachment.phase.path, uri: attachment.uri }]
      : [],
  );

// ─── can it send ────────────────────────────────────────────────────────────

export type ComposerReadiness =
  | { readonly canSend: true }
  | {
      readonly canSend: false;
      /**
       * `empty`: nothing typed, nothing attached. `preparing`/`uploading`: an image is still on its
       * way. `failed`: an image did not make it, and sending would drop it silently.
       * `starting`: the agent is not ready for a message yet.
       */
      readonly reason: "empty" | "preparing" | "uploading" | "failed" | "starting";
    };

export const composerReadiness = (input: {
  readonly draft: string;
  readonly attachments: ReadonlyArray<Attachment>;
  readonly starting: boolean;
}): ComposerReadiness => {
  if (input.starting) return { canSend: false, reason: "starting" };
  const phases = input.attachments.map((attachment) => attachment.phase.kind);
  if (phases.includes("failed")) return { canSend: false, reason: "failed" };
  if (phases.includes("uploading")) return { canSend: false, reason: "uploading" };
  if (phases.includes("preparing")) return { canSend: false, reason: "preparing" };
  if (input.draft.trim() === "" && input.attachments.length === 0) {
    return { canSend: false, reason: "empty" };
  }
  return { canSend: true };
};

/** The line under the composer while it cannot send for a reason worth saying, else null. */
export const readinessHint = (readiness: ComposerReadiness, count: number): string | null => {
  if (readiness.canSend) return null;
  const images = count === 1 ? "the image" : "the images";
  switch (readiness.reason) {
    case "failed":
      return "an image did not upload · tap it to retry, or remove it";
    case "uploading":
      return `uploading ${images}…`;
    case "preparing":
      return `preparing ${images}…`;
    case "empty":
    case "starting":
      return null;
  }
};

// ─── the text field ─────────────────────────────────────────────────────────

/** One line of the composer's text, in points. The field sets this line height. */
export const COMPOSER_LINE_HEIGHT = 20;
/** The field grows to this many lines, then scrolls inside. */
export const COMPOSER_MAX_LINES = 6;

/**
 * How tall the text field is. It follows the text's measured height between one line and the
 * maximum, and an empty field is always one line: iOS can report the height of the text that was
 * just cleared after the field is emptied, which left the composer tall after a send.
 */
export const composerInputHeight = (draft: string, contentHeight: number): number => {
  if (draft === "" || !Number.isFinite(contentHeight)) return COMPOSER_LINE_HEIGHT;
  return Math.min(
    COMPOSER_LINE_HEIGHT * COMPOSER_MAX_LINES,
    Math.max(COMPOSER_LINE_HEIGHT, Math.ceil(contentHeight)),
  );
};

/** Past the maximum the field scrolls its own text. */
export const composerInputScrolls = (draft: string, contentHeight: number): boolean =>
  draft !== "" && contentHeight > COMPOSER_LINE_HEIGHT * COMPOSER_MAX_LINES;
