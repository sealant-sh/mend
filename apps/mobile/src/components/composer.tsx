// The conversation composer's parts: the text field that grows with what is typed and returns to
// one line on send, the attach button, and the strip of images going up with the message. The
// rules live in data/composer.ts; this is how they read on the phone.

import { Image } from "expo-image";
import { ImagePlus, X } from "lucide-react-native";
import { useState, type ReactNode } from "react";
import {
  ActionSheetIOS,
  Alert,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from "react-native";

import { MonoText } from "@/components/typography";
import {
  COMPOSER_LINE_HEIGHT,
  composerInputHeight,
  composerInputScrolls,
  type Attachment,
} from "@/data/composer";
import {
  chooseFromLibrary,
  clipboardHasImage,
  pasteFromClipboard,
  takePhoto,
  type ChosenImage,
} from "@/data/image-attach";
import { radius, useEvidenceTheme } from "@/theme/evidence";

/**
 * A multiline field whose height the composer owns. Letting the native view size itself left it
 * tall after a send on iOS: the field was emptied but kept the height of the text it had held.
 * Here the height follows the measured text between one line and six, an empty field is one line
 * whatever iOS last reported, and past six lines the text scrolls inside the field.
 */
export function ComposerTextInput({
  value,
  onChangeText,
  placeholder,
  editable = true,
}: {
  readonly value: string;
  readonly onChangeText: (text: string) => void;
  readonly placeholder: string;
  readonly editable?: boolean;
}) {
  const { colors } = useEvidenceTheme();
  const [contentHeight, setContentHeight] = useState(COMPOSER_LINE_HEIGHT);
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      onContentSizeChange={(event) => setContentHeight(event.nativeEvent.contentSize.height)}
      placeholder={placeholder}
      placeholderTextColor={colors.faint}
      editable={editable}
      multiline
      scrollEnabled={composerInputScrolls(value, contentHeight)}
      textAlignVertical="top"
      style={{
        height: composerInputHeight(value, contentHeight),
        padding: 0,
        margin: 0,
        color: colors.ink,
        fontSize: 15,
        lineHeight: COMPOSER_LINE_HEIGHT,
      }}
    />
  );
}

/** The rounded field the text and the image strip sit in. */
export function ComposerField({ children }: { readonly children: ReactNode }) {
  const { colors } = useEvidenceTheme();
  return (
    <View
      style={{
        flex: 1,
        gap: 8,
        backgroundColor: colors.bg,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colors.rule,
        borderRadius: radius.lg,
        paddingHorizontal: 13,
        paddingVertical: 10,
      }}
    >
      {children}
    </View>
  );
}

// ─── attach ─────────────────────────────────────────────────────────────────

const openSettings = () => void Linking.openSettings();

const cameraRefused = (canAskAgain: boolean) =>
  Alert.alert(
    "Camera access is off",
    "Mend takes a photo only when you ask. Turn on camera access for Mend in Settings.",
    canAskAgain
      ? [{ text: "OK" }]
      : [
          { text: "Cancel", style: "cancel" },
          { text: "Open Settings", onPress: openSettings },
        ],
  );

const failedToChoose = (error: unknown) =>
  Alert.alert(
    "No image attached",
    error instanceof Error && error.message !== "" ? error.message : "The image could not be read.",
  );

/**
 * The button left of the field: photo library, camera, and — when the clipboard holds one — the
 * clipboard's image. iOS shows an action sheet; Android an alert with the same choices.
 */
export function AttachButton({
  room,
  held,
  disabled,
  onChosen,
}: {
  /** How many more images the message can carry. */
  readonly room: number;
  /** How many it carries now, to number unnamed images. */
  readonly held: number;
  readonly disabled: boolean;
  readonly onChosen: (images: ReadonlyArray<ChosenImage>) => void;
}) {
  const { colors } = useEvidenceTheme();
  const ordinal = held + 1;

  const library = () => void chooseFromLibrary(room, ordinal).then(onChosen, failedToChoose);
  const camera = () =>
    void takePhoto(ordinal).then(
      (outcome) =>
        outcome.kind === "denied" ? cameraRefused(outcome.canAskAgain) : onChosen(outcome.images),
      failedToChoose,
    );
  const paste = () =>
    void pasteFromClipboard(ordinal).then(
      (image) =>
        image === null
          ? Alert.alert("No image on the clipboard", "Copy a screenshot or photo first.")
          : onChosen([image]),
      failedToChoose,
    );

  const open = async () => {
    if (room === 0) {
      Alert.alert(
        "Ten images at most",
        "A message carries up to ten images. Remove one to add another.",
      );
      return;
    }
    const canPaste = await clipboardHasImage();
    const choices: ReadonlyArray<{ readonly label: string; readonly run: () => void }> = [
      { label: "Photo library", run: library },
      { label: "Take photo", run: camera },
      ...(canPaste ? [{ label: "Paste image", run: paste }] : []),
    ];
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: [...choices.map((choice) => choice.label), "Cancel"],
          cancelButtonIndex: choices.length,
        },
        (index) => choices[index]?.run(),
      );
      return;
    }
    Alert.alert(
      "Attach an image",
      undefined,
      choices.map((choice) => ({ text: choice.label, onPress: choice.run })),
      { cancelable: true },
    );
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Attach an image"
      disabled={disabled}
      hitSlop={6}
      onPress={() => void open()}
      style={({ pressed }) => ({
        width: 40,
        height: 42,
        alignItems: "center",
        justifyContent: "center",
        opacity: disabled ? 0.45 : pressed ? 0.6 : 1,
      })}
    >
      <ImagePlus size={22} color={colors.ink2} strokeWidth={1.75} />
    </Pressable>
  );
}

// ─── the strip ──────────────────────────────────────────────────────────────

const THUMB = 58;

function AttachmentThumb({
  attachment,
  onRemove,
  onRetry,
}: {
  readonly attachment: Attachment;
  readonly onRemove: (id: string) => void;
  readonly onRetry: (id: string) => void;
}) {
  const { colors } = useEvidenceTheme();
  const { phase } = attachment;
  const failed = phase.kind === "failed";
  let label: string | null = null;
  if (phase.kind === "preparing") label = "…";
  else if (phase.kind === "uploading") label = `${Math.round(phase.sent * 100)}%`;
  else if (failed) label = "retry";
  return (
    <View style={{ paddingTop: 6, paddingRight: 6 }}>
      <Pressable
        accessibilityRole={failed ? "button" : "image"}
        accessibilityLabel={failed ? `${attachment.name} did not upload. Retry` : attachment.name}
        disabled={!failed}
        onPress={() => onRetry(attachment.id)}
        style={{
          width: THUMB,
          height: THUMB,
          borderRadius: radius.md,
          overflow: "hidden",
          backgroundColor: colors.sunken,
          borderLeftWidth: failed ? 2 : 0,
          borderLeftColor: failed ? colors.red : "transparent",
        }}
      >
        <Image
          source={{ uri: attachment.uri }}
          contentFit="cover"
          style={{ width: "100%", height: "100%", opacity: phase.kind === "stored" ? 1 : 0.55 }}
        />
        {label === null ? null : (
          <View
            style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center" }]}
          >
            <MonoText size={10.5} tone={failed ? "danger" : "ink"}>
              {label}
            </MonoText>
          </View>
        )}
        {phase.kind === "uploading" ? (
          <View
            style={{
              position: "absolute",
              left: 0,
              bottom: 0,
              height: 2,
              width: `${Math.max(4, Math.round(phase.sent * 100))}%`,
              backgroundColor: colors.accent,
            }}
          />
        ) : null}
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Remove ${attachment.name}`}
        hitSlop={8}
        onPress={() => onRemove(attachment.id)}
        style={{
          position: "absolute",
          top: 0,
          right: 0,
          width: 20,
          height: 20,
          borderRadius: 10,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.ink,
        }}
      >
        <X size={12} color={colors.bg} strokeWidth={2.5} />
      </Pressable>
    </View>
  );
}

export function AttachmentStrip({
  attachments,
  onRemove,
  onRetry,
}: {
  readonly attachments: ReadonlyArray<Attachment>;
  readonly onRemove: (id: string) => void;
  readonly onRetry: (id: string) => void;
}) {
  if (attachments.length === 0) return null;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ gap: 4 }}
      style={{ marginTop: -6 }}
    >
      {attachments.map((attachment) => (
        <AttachmentThumb
          key={attachment.id}
          attachment={attachment}
          onRemove={onRemove}
          onRetry={onRetry}
        />
      ))}
    </ScrollView>
  );
}

/** Images on a sent message: this phone's copy as a thumbnail, others by name. */
export function TurnImages({
  images,
}: {
  readonly images: ReadonlyArray<{ readonly name: string; readonly uri: string | null }>;
}) {
  const { colors } = useEvidenceTheme();
  if (images.length === 0) return null;
  const shown = images.filter((image) => image.uri !== null);
  const named = images.filter((image) => image.uri === null);
  return (
    <View style={{ gap: 6 }}>
      {shown.length === 0 ? null : (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {shown.map((image, index) => (
            <Image
              key={`${index}:${image.name}`}
              source={image.uri === null ? null : { uri: image.uri }}
              contentFit="cover"
              accessibilityLabel={image.name}
              style={{
                width: 76,
                height: 76,
                borderRadius: radius.md,
                backgroundColor: colors.sunken,
              }}
            />
          ))}
        </View>
      )}
      {named.map((image, index) => (
        <MonoText key={`${index}:${image.name}`} tone="muted" size={11} numberOfLines={1}>
          image · {image.name}
        </MonoText>
      ))}
    </View>
  );
}
