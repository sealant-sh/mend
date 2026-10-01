/**
 * Images into the conversation composer: pick from the library, take a photo, or paste the
 * clipboard's image; shrink each on the phone (HEIC and oversized photos become a JPEG whose long
 * edge fits 2048px, under the server's 8 MB cap); upload it beside the session the moment it is
 * attached. The turn then names each stored image's path (turn-input.ts). The phases and their
 * rules are composer.ts; this module is the native side that drives them.
 *
 * Images are prepared and uploaded one at a time: a 48-megapixel photo decoded several times over
 * at once is how a phone runs out of memory.
 */

import * as Clipboard from "expo-clipboard";
import { ImageManipulator, SaveFormat, type ImageRef } from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import { useReducer, useRef } from "react";

import {
  IMAGE_MAX_BYTES,
  MAX_IMAGES_PER_MESSAGE,
  PREPARE_STEPS,
  attachmentsReducer,
  base64ByteLength,
  fitWithin,
  imageName,
  type Attachment,
} from "@/data/composer";
import { uploadSessionImage, type ImageUpload } from "@/data/live";

/** An image the person chose, before it is prepared. */
export interface ChosenImage {
  readonly uri: string;
  readonly name: string;
}

const errorText = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message !== "" ? error.message : fallback;

/**
 * The image as a JPEG under the server's cap, base64-encoded for the upload. Each step of
 * `PREPARE_STEPS` shrinks further; the first that fits is sent.
 */
export const prepareImage = async (uri: string): Promise<string> => {
  const original: ImageRef = await ImageManipulator.manipulate(uri).renderAsync();
  try {
    for (const step of PREPARE_STEPS) {
      const context = ImageManipulator.manipulate(original);
      const size = fitWithin(original.width, original.height, step.maxEdge);
      if (size !== null) context.resize(size);
      const rendered = await context.renderAsync();
      try {
        const saved = await rendered.saveAsync({
          base64: true,
          compress: step.quality,
          format: SaveFormat.JPEG,
        });
        if (saved.base64 !== undefined && base64ByteLength(saved.base64) <= IMAGE_MAX_BYTES) {
          return saved.base64;
        }
      } finally {
        rendered.release();
        context.release();
      }
    }
  } finally {
    original.release();
  }
  throw new Error(`The image is over the ${IMAGE_MAX_BYTES / 1024 / 1024} MB limit, even shrunk.`);
};

// ─── choosing ───────────────────────────────────────────────────────────────

const chosenFrom = (
  result: ImagePicker.ImagePickerResult,
  firstOrdinal: number,
): ReadonlyArray<ChosenImage> =>
  result.canceled
    ? []
    : result.assets.map((asset, index) => ({
        uri: asset.uri,
        name: imageName(asset.fileName, firstOrdinal + index),
      }));

/** Up to `room` images from the photo library. The system picker needs no library permission. */
export const chooseFromLibrary = async (
  room: number,
  firstOrdinal: number,
): Promise<ReadonlyArray<ChosenImage>> =>
  chosenFrom(
    await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsMultipleSelection: room > 1,
      selectionLimit: room,
      orderedSelection: true,
      quality: 1,
      exif: false,
      // A JPEG where the library holds a HEIC, when iOS can hand one over.
      preferredAssetRepresentationMode:
        ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
    }),
    firstOrdinal,
  );

export type CameraOutcome =
  | { readonly kind: "taken"; readonly images: ReadonlyArray<ChosenImage> }
  | { readonly kind: "denied"; readonly canAskAgain: boolean };

export const takePhoto = async (firstOrdinal: number): Promise<CameraOutcome> => {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) return { kind: "denied", canAskAgain: permission.canAskAgain };
  return {
    kind: "taken",
    images: chosenFrom(
      await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 1, exif: false }),
      firstOrdinal,
    ),
  };
};

export const clipboardHasImage = (): Promise<boolean> =>
  Clipboard.hasImageAsync().catch(() => false);

/** The clipboard's image as a data URI the manipulator reads, or null when there is none. */
export const pasteFromClipboard = async (ordinal: number): Promise<ChosenImage | null> => {
  const image = await Clipboard.getImageAsync({ format: "jpeg", jpegQuality: 0.9 });
  return image === null ? null : { uri: image.data, name: `pasted image ${ordinal}.jpg` };
};

// ─── the composer's images ──────────────────────────────────────────────────

export interface ComposerAttachments {
  readonly attachments: ReadonlyArray<Attachment>;
  /** How many more images this message can carry. */
  readonly room: number;
  readonly attach: (images: ReadonlyArray<ChosenImage>) => void;
  readonly remove: (id: string) => void;
  readonly retry: (id: string) => void;
  /** The message went: forget its images here (they stay stored beside the session). */
  readonly clear: () => void;
  /** A message that did not send comes back with its stored images. */
  readonly restore: (attachments: ReadonlyArray<Attachment>) => void;
}

export const useComposerAttachments = (sessionId: string): ComposerAttachments => {
  const [attachments, dispatch] = useReducer(attachmentsReducer, []);
  // Live ids, prepared bytes (a retry after a failed upload skips preparing again), the upload
  // in flight, and the one-at-a-time queue. Refs: the queue outlives the render that started it.
  const live = useRef(new Set<string>());
  const prepared = useRef(new Map<string, string>());
  const uploads = useRef(new Map<string, ImageUpload>());
  const queue = useRef<Promise<void>>(Promise.resolve());
  const seq = useRef(0);

  const work = async (id: string, uri: string): Promise<void> => {
    if (!live.current.has(id)) return;
    let base64 = prepared.current.get(id);
    if (base64 === undefined) {
      try {
        base64 = await prepareImage(uri);
      } catch (error) {
        dispatch({ type: "failed", id, message: errorText(error, "The image could not be read.") });
        return;
      }
      if (!live.current.has(id)) return;
      prepared.current.set(id, base64);
    }
    dispatch({ type: "prepared", id });
    const upload = uploadSessionImage(sessionId, base64, (sent) =>
      dispatch({ type: "progress", id, sent }),
    );
    uploads.current.set(id, upload);
    try {
      const stored = await upload.result;
      prepared.current.delete(id);
      dispatch({ type: "stored", id, path: stored.path, bytes: stored.bytes });
    } catch (error) {
      if (live.current.has(id)) {
        dispatch({ type: "failed", id, message: errorText(error, "The image was not stored.") });
      }
    } finally {
      uploads.current.delete(id);
    }
  };
  const enqueue = (id: string, uri: string) => {
    queue.current = queue.current.then(() => work(id, uri));
  };

  const forget = (id: string) => {
    live.current.delete(id);
    prepared.current.delete(id);
    uploads.current.get(id)?.abort();
    uploads.current.delete(id);
  };

  return {
    attachments,
    room: Math.max(0, MAX_IMAGES_PER_MESSAGE - attachments.length),
    attach: (images) => {
      for (const image of images.slice(0, MAX_IMAGES_PER_MESSAGE - live.current.size)) {
        seq.current += 1;
        const id = `a${Date.now().toString(36)}-${seq.current}`;
        live.current.add(id);
        dispatch({ type: "added", id, uri: image.uri, name: image.name });
        enqueue(id, image.uri);
      }
    },
    remove: (id) => {
      forget(id);
      dispatch({ type: "removed", id });
    },
    retry: (id) => {
      const attachment = attachments.find((candidate) => candidate.id === id);
      if (attachment === undefined || attachment.phase.kind !== "failed") return;
      dispatch({ type: "retried", id });
      enqueue(id, attachment.uri);
    },
    clear: () => {
      for (const id of live.current) forget(id);
      dispatch({ type: "cleared" });
    },
    restore: (restored) => {
      const room = MAX_IMAGES_PER_MESSAGE - live.current.size;
      const back = restored.filter((attachment) => !live.current.has(attachment.id)).slice(0, room);
      for (const attachment of back) live.current.add(attachment.id);
      dispatch({ type: "restored", attachments: back });
    },
  };
};
