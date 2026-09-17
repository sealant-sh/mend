// Pair this phone with a machine: scan the QR the machine shows, or type the
// same two facts by hand. One claim mints one token; the machine records the
// device and this phone keeps the token for every call after.

import type { BarcodeScanningResult } from "expo-camera";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Platform, StyleSheet, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { EvButton } from "@/components/button";
import { Panel } from "@/components/panel";
import { Screen, ScreenHeader } from "@/components/screen";
import { MonoText, UiText } from "@/components/typography";
import { enablePushNotifications } from "@/data/notifications";
import type { PairPayload } from "@/data/pairing";
import {
  claimPairing,
  codeIsComplete,
  formatCode,
  normalizeCode,
  parsePairParams,
  parseScanned,
} from "@/data/pairing";
import { radius, spacing, useEvidenceTheme } from "@/theme/evidence";

/** Ignore the same QR for this long — the camera reports it many times a second. */
const RESCAN_MS = 2_500;

type Claim =
  | { readonly state: "idle" }
  | { readonly state: "claiming" }
  | { readonly state: "paired"; readonly detail: string }
  | { readonly state: "note"; readonly text: string }
  | { readonly state: "refused"; readonly reason: string };

export default function PairScreen() {
  const { colors } = useEvidenceTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  // The QR is a `mend://pair` link, so the phone's own camera can open this
  // screen with the payload already in hand. Same two facts, same path.
  const { u, c } = useLocalSearchParams<{ u?: string; c?: string }>();
  const linked = parsePairParams(u, c);
  const linkedPayload = linked?.kind === "pairing" ? linked.payload : null;
  const [mode, setMode] = useState<"scan" | "manual">(linked === null ? "scan" : "manual");
  const [claim, setClaim] = useState<Claim>(
    linked?.kind === "server"
      ? { state: "note", text: `${linked.url} — now enter the code from the machine` }
      : { state: "idle" },
  );
  const [url, setUrl] = useState(
    linked === null ? "" : linked.kind === "pairing" ? linked.payload.url : linked.url,
  );
  const [code, setCode] = useState(linkedPayload?.code ?? "");
  const busy = useRef(false);
  const claimedLink = useRef(false);
  const lastScan = useRef<{ readonly data: string; readonly at: number }>({ data: "", at: 0 });

  const cameraUsable = Platform.OS !== "web";
  const scanning = mode === "scan" && cameraUsable && permission?.granted === true;

  const claimNow = async (payload: PairPayload) => {
    if (busy.current) return;
    busy.current = true;
    setClaim({ state: "claiming" });
    const outcome = await claimPairing(payload);
    busy.current = false;
    if (outcome.state === "refused") {
      setClaim({ state: "refused", reason: outcome.reason });
      return;
    }
    setClaim({ state: "paired", detail: `${outcome.config.url} · ${outcome.config.deviceName}` });
    // The push token belongs to whichever user this phone now speaks as.
    void enablePushNotifications();
    router.replace("/");
  };

  // A deep link is claimed once, on arrival: the user already pointed a camera
  // at the code, and re-typing it would be the same act twice. The ref makes a
  // re-render — or a second pass in development — a no-op.
  const linkedUrl = linkedPayload?.url ?? null;
  const linkedCode = linkedPayload?.code ?? null;
  useEffect(() => {
    if (linkedUrl === null || linkedCode === null || claimedLink.current) return;
    claimedLink.current = true;
    void claimNow({ url: linkedUrl, code: linkedCode });
  }, [linkedUrl, linkedCode]);

  const onBarcodeScanned = ({ data }: BarcodeScanningResult) => {
    const now = Date.now();
    if (busy.current) return;
    if (data === lastScan.current.data && now - lastScan.current.at < RESCAN_MS) return;
    lastScan.current = { data, at: now };
    const scanned = parseScanned(data);
    if (scanned === null) {
      setClaim({ state: "refused", reason: "not a Mend pairing code" });
      return;
    }
    if (scanned.kind === "server") {
      // The installer's QR carries the address only — no account, so no code yet.
      setUrl(scanned.url);
      setMode("manual");
      setClaim({ state: "note", text: `${scanned.url} — now enter the code from the machine` });
      return;
    }
    setUrl(scanned.payload.url);
    setCode(scanned.payload.code);
    void claimNow(scanned.payload);
  };

  const askCamera = async () => {
    const result = await requestPermission();
    if (!result.granted) {
      setMode("manual");
      setClaim({
        state: "refused",
        reason: "camera permission denied — type the code, or allow the camera in system settings",
      });
    }
  };

  const statusLine =
    claim.state === "claiming"
      ? "claiming…"
      : claim.state === "paired"
        ? `paired · ${claim.detail}`
        : claim.state === "refused"
          ? claim.reason
          : claim.state === "note"
            ? claim.text
            : null;
  const statusTone = claim.state === "refused" ? "danger" : "faint";

  if (scanning) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.canvas }}>
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={onBarcodeScanned}
        />
        <View
          style={{
            position: "absolute",
            left: 20,
            right: 20,
            bottom: insets.bottom + spacing.lg,
          }}
        >
          <Panel>
            <View style={{ padding: 16, gap: 10 }}>
              <UiText weight="medium">Point the camera at the code on your machine</UiText>
              <MonoText tone="faint">mend · settings · devices</MonoText>
              {statusLine === null ? null : <MonoText tone={statusTone}>{statusLine}</MonoText>}
              <EvButton
                variant="outline"
                size="sm"
                label="Type the code instead"
                onPress={() => setMode("manual")}
              />
            </View>
          </Panel>
        </View>
      </View>
    );
  }

  const inputStyle = {
    borderWidth: 1,
    borderColor: colors.rule,
    borderRadius: radius.lg,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.ink,
    fontSize: 14,
  };

  return (
    <Screen>
      <ScreenHeader
        eyebrow="pair"
        title="Pair with your machine"
        meta="one code · one token · this device"
      />
      {mode === "scan" ? (
        <Panel>
          <View style={{ padding: 16, gap: 12 }}>
            <UiText>
              On the machine, open Settings → Devices and show the pairing code. Scanning it gives
              this phone its own token.
            </UiText>
            <MonoText tone="faint">code expires 10 minutes after it is shown</MonoText>
            {statusLine === null ? null : <MonoText tone={statusTone}>{statusLine}</MonoText>}
            {cameraUsable ? (
              <EvButton label="Scan the code" onPress={() => void askCamera()} />
            ) : (
              <MonoText tone="faint">
                the camera rides the native app — type the code below
              </MonoText>
            )}
            <EvButton
              variant="ghost"
              label="Type the code instead"
              onPress={() => setMode("manual")}
            />
          </View>
        </Panel>
      ) : (
        <Panel>
          <View style={{ padding: 16, gap: 12 }}>
            <UiText>Server URL — shown on the machine beside the code</UiText>
            <TextInput
              value={url}
              onChangeText={(next) => {
                setUrl(next);
                setClaim({ state: "idle" });
              }}
              placeholder="https://mend.example.com"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              style={inputStyle}
            />
            <UiText>Pairing code</UiText>
            <TextInput
              value={formatCode(code)}
              onChangeText={(next) => {
                setCode(normalizeCode(next));
                setClaim({ state: "idle" });
              }}
              placeholder="ABCD-EFGH"
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={9}
              style={inputStyle}
            />
            {statusLine === null ? null : <MonoText tone={statusTone}>{statusLine}</MonoText>}
            <EvButton
              label={claim.state === "claiming" ? "Pairing…" : "Pair"}
              disabled={!codeIsComplete(code) || url.trim() === "" || claim.state === "claiming"}
              onPress={() => void claimNow({ url, code })}
            />
            {cameraUsable && permission?.canAskAgain !== false ? (
              <EvButton
                variant="ghost"
                label="Scan the code instead"
                onPress={() => {
                  setClaim({ state: "idle" });
                  setMode("scan");
                  if (permission?.granted !== true) void askCamera();
                }}
              />
            ) : null}
          </View>
        </Panel>
      )}
      <MonoText tone="faint">
        The token is minted on the machine and stored on this phone only. Revoke it there in
        Settings → Devices.
      </MonoText>
    </Screen>
  );
}
