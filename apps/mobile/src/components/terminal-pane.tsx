// A terminal surface with the key bar phone keyboards lack (Esc, Tab, Ctrl-C, arrows) — t3code's
// layout recipe. Full screen, the surface's bottom padding tracks the live keyboard height (the
// surface shrinks, the PTY resizes, the prompt stays visible) and the key bar rides the keyboard.
// In a pane of a wide layout, the layout avoids the keyboard for every pane and the key bar sits
// under the surface for as long as the pane is open.

import * as Clipboard from "expo-clipboard";
import { useEffect, useRef, useState } from "react";
import { Alert, Pressable, View } from "react-native";
import { KeyboardStickyView, useKeyboardState } from "react-native-keyboard-controller";

import { GhosttyTerminal } from "@/components/ghostty-terminal";
import { usePaneEdges } from "@/components/pane";
import { MonoText } from "@/components/typography";
import { loadConfig, pasteSessionImage } from "@/data/live";
import { useEvidenceTheme } from "@/theme/evidence";

const ACCESSORY_HEIGHT = 44;

const KEYS: ReadonlyArray<{ readonly label: string; readonly data: string }> = [
  { label: "esc", data: "\u001b" },
  { label: "tab", data: "\t" },
  { label: "^C", data: "\u0003" },
  { label: "up", data: "\u001b[A" },
  { label: "dn", data: "\u001b[B" },
  { label: "~", data: "~" },
  { label: "|", data: "|" },
  { label: "/", data: "/" },
  { label: "-", data: "-" },
];

// Bracketed paste (mode 2004): both harness TUIs and every shell ask for it,
// and it is how codex tells a pasted image path from typed text. The native
// surface does not expose the mode to JS, so the wrap is unconditional.
const bracketedPaste = (text: string): string => `\u001b[200~${text}\u001b[201~`;

/** Ctrl+letter is the letter's alphabet position; punctuation per ECMA-48. */
const applyCtrl = (data: string): string => {
  if (data.length !== 1) return data;
  const code = data.toLowerCase().charCodeAt(0);
  if (code >= 97 && code <= 122) return String.fromCharCode(code - 96);
  const specials: Record<string, string> = {
    "@": "\u0000",
    "[": "\u001b",
    "\\": "\u001c",
    "]": "\u001d",
    "^": "\u001e",
    _: "\u001f",
    "?": "\u007f",
  };
  return specials[data] ?? data;
};

export function TerminalPane({
  sessionId,
  processId,
}: {
  readonly sessionId: string;
  /** A supporting shell process. Omitted only for legacy agent-terminal links. */
  readonly processId?: string;
}) {
  const { colors } = useEvidenceTheme();
  const pane = usePaneEdges();
  const [base, setBase] = useState<{ url: string; token: string } | null>(null);
  // Sticky modifier (t3code's key-bar pattern): tap ctrl, then the key it
  // applies to — phone keyboards can't chord. The ref mirrors the state so
  // the input transform reads the latch without re-wiring the surface.
  const [ctrlLatched, setCtrlLatched] = useState(false);
  const ctrlLatchedRef = useRef(false);
  const latchCtrl = (latched: boolean) => {
    ctrlLatchedRef.current = latched;
    setCtrlLatched(latched);
  };
  const sendRef = useRef<((data: string) => void) | null>(null);
  useEffect(() => {
    void loadConfig().then((config) => setBase({ url: config.url, token: config.token }));
  }, []);

  // A screenshot on the clipboard: the TUI's own Ctrl+V reads the clipboard
  // of the container it runs in, which has none. Mend stores the bytes beside
  // the session and answers with the workspace path, which is pasted as text.
  // Codex attaches a pasted image path as an image; claude reads it.
  const [pastingImage, setPastingImage] = useState(false);
  const pasteImage = async () => {
    if (pastingImage) return;
    setPastingImage(true);
    try {
      const image = await Clipboard.getImageAsync({ format: "png" });
      if (image === null) {
        Alert.alert("No image on the clipboard", "Copy a screenshot or photo first, then tap img.");
        return;
      }
      const stored = await pasteSessionImage(
        sessionId,
        image.data.slice(image.data.indexOf(",") + 1),
      );
      sendRef.current?.(bracketedPaste(stored.path));
    } catch (error) {
      Alert.alert(
        "Image not pasted",
        error instanceof Error ? error.message : "The image was not stored.",
      );
    } finally {
      setPastingImage(false);
    }
  };

  const keyboard = useKeyboardState((state) => ({
    height: state.height,
    isVisible: state.isVisible,
  }));

  const keyBar = (
    <View
      style={{
        flexDirection: "row",
        height: ACCESSORY_HEIGHT,
        backgroundColor: colors.sunken,
        borderTopWidth: 1,
        borderTopColor: colors.softRule,
      }}
    >
      <Pressable
        onPress={() => latchCtrl(!ctrlLatched)}
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: ctrlLatched ? colors.wash : undefined,
        }}
      >
        <MonoText style={{ color: ctrlLatched ? colors.accent : colors.ink }}>ctrl</MonoText>
      </Pressable>
      <Pressable
        onPress={() => void pasteImage()}
        disabled={pastingImage}
        style={{ flex: 1, alignItems: "center", justifyContent: "center" }}
      >
        <MonoText style={{ color: pastingImage ? colors.faint : colors.ink }}>
          {pastingImage ? "…" : "img"}
        </MonoText>
      </Pressable>
      {KEYS.map((key) => (
        <Pressable
          key={key.label}
          onPress={() => {
            sendRef.current?.(ctrlLatched ? applyCtrl(key.data) : key.data);
            latchCtrl(false);
          }}
          style={{ flex: 1, alignItems: "center", justifyContent: "center" }}
        >
          <MonoText style={{ color: colors.ink }}>{key.label}</MonoText>
        </Pressable>
      ))}
    </View>
  );

  const surface =
    base === null ? null : (
      <GhosttyTerminal
        serverUrl={base.url}
        token={base.token}
        sessionId={sessionId}
        {...(processId === undefined ? {} : { processId })}
        registerSend={(send) => {
          sendRef.current = send;
        }}
        transformInput={(data) => {
          if (!ctrlLatchedRef.current) return data;
          latchCtrl(false);
          return applyCtrl(data);
        }}
      />
    );

  if (!pane.sticky) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: colors.panel,
          paddingBottom: keyboard.isVisible ? 0 : pane.bottom,
        }}
      >
        <View style={{ flex: 1 }}>{surface}</View>
        {keyBar}
      </View>
    );
  }

  const bottomInset = keyboard.isVisible ? keyboard.height + ACCESSORY_HEIGHT : pane.bottom;
  return (
    <>
      <View style={{ flex: 1, backgroundColor: colors.panel, paddingBottom: bottomInset }}>
        {surface}
      </View>
      {keyboard.isVisible && (
        <KeyboardStickyView
          style={{ position: "absolute", bottom: 0, left: 0, right: 0 }}
          offset={{ closed: 0, opened: 0 }}
        >
          {keyBar}
        </KeyboardStickyView>
      )}
    </>
  );
}
