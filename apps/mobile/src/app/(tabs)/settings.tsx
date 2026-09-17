// Settings — the machine this app steers. Pairing is the path: the machine
// shows a code, this phone claims it and keeps the token it gets back. The
// hand-typed bearer token lives on under Advanced. Plus how the app reads:
// theme and text size. Stored on device; nothing else to set up.

import { useRouter } from "expo-router";
import { useState } from "react";
import { Pressable, StyleSheet, TextInput, View } from "react-native";

import { EvButton } from "@/components/button";
import { Panel } from "@/components/panel";
import { Screen, ScreenHeader } from "@/components/screen";
import { StatusWord } from "@/components/status";
import { MonoText, UiText } from "@/components/typography";
import { clearConfig, saveConfig, useConfig } from "@/data/live";
import { enablePushNotifications } from "@/data/notifications";
import type { ThemePreference } from "@/data/preferences";
import { setDisplayPreferences, TEXT_SCALES, useDisplayPreferences } from "@/data/preferences";
import { radius, useEvidenceTheme } from "@/theme/evidence";

function Segmented<T extends string | number>({
  value,
  options,
  onChange,
}: {
  readonly value: T;
  readonly options: ReadonlyArray<{ readonly value: T; readonly label: string }>;
  readonly onChange: (next: T) => void;
}) {
  const { colors } = useEvidenceTheme();
  return (
    <View style={{ flexDirection: "row", gap: 6 }}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={String(option.value)}
            onPress={() => onChange(option.value)}
            style={{
              flex: 1,
              alignItems: "center",
              paddingVertical: 8,
              borderRadius: radius.lg,
              borderWidth: 1,
              borderColor: selected ? colors.accent : colors.rule,
              backgroundColor: selected ? colors.wash : undefined,
            }}
          >
            <UiText size={13} weight="medium" tone={selected ? "accent" : "ink2"}>
              {option.label}
            </UiText>
          </Pressable>
        );
      })}
    </View>
  );
}

export default function SettingsScreen() {
  const { colors } = useEvidenceTheme();
  const router = useRouter();
  const display = useDisplayPreferences();
  const config = useConfig();
  // The stored config is the truth; a draft only exists once something is
  // typed under Advanced. No effect, no copy that goes stale on save.
  const [draft, setDraft] = useState<{ readonly url: string; readonly token: string } | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [saved, setSaved] = useState(false);
  const [push, setPush] = useState<
    | { readonly state: "idle" }
    | { readonly state: "registering" }
    | { readonly state: "registered" }
    | { readonly state: "unavailable"; readonly reason: string }
  >({ state: "idle" });
  const [check, setCheck] = useState<
    | { readonly state: "idle" }
    | { readonly state: "testing" }
    | { readonly state: "ok"; readonly detail: string }
    | { readonly state: "bad"; readonly detail: string }
  >({ state: "idle" });

  // Nothing is known about this phone until AsyncStorage answers — see live.ts.
  // Rendering "Not paired" before that flashes the wrong panel on every launch.
  if (config === null) {
    return (
      <Screen topInset>
        <ScreenHeader eyebrow="mend" title="Settings" meta="reading this device" />
      </Screen>
    );
  }

  const url = draft?.url ?? config.url;
  const token = draft?.token ?? config.token;
  const paired = config.url !== "" && config.token !== "";

  /** Test what's typed (not only what's saved): health first, then an authed call. */
  const testConnection = async () => {
    setCheck({ state: "testing" });
    const base = url.trim().replace(/\/$/, "");
    try {
      const health = await fetch(`${base}/api/health`);
      if (!health.ok) {
        setCheck({ state: "bad", detail: `server answered ${health.status} on /api/health` });
        return;
      }
      const authed = await fetch(`${base}/api/projects`, {
        headers: { authorization: `Bearer ${token.trim()}` },
      });
      if (authed.status === 401) {
        setCheck({ state: "bad", detail: "reachable · token rejected (401)" });
        return;
      }
      if (!authed.ok) {
        setCheck({ state: "bad", detail: `reachable · projects answered ${authed.status}` });
        return;
      }
      const projects = (await authed.json()) as ReadonlyArray<unknown>;
      setCheck({
        state: "ok",
        detail: `connected · ${projects.length} project${projects.length === 1 ? "" : "s"}`,
      });
    } catch {
      setCheck({ state: "bad", detail: "unreachable — check URL, port, firewall, same network" });
    }
  };

  const inputStyle = {
    borderWidth: 1,
    borderColor: colors.rule,
    borderRadius: radius.lg,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.ink,
    fontSize: 14,
  };

  const pairedLine =
    config.deviceName === null && config.pairedAt === null
      ? "token entered by hand"
      : `${config.deviceName ?? "this device"}${
          config.pairedAt === null ? "" : ` · paired ${config.pairedAt.slice(0, 10)}`
        }`;

  return (
    <Screen topInset>
      <ScreenHeader
        eyebrow="mend"
        title="Settings"
        meta={paired ? "paired · one connection" : "not paired"}
      />
      {paired ? (
        <Panel>
          <View style={{ padding: 16, gap: 12 }}>
            <UiText weight="medium">This phone is paired</UiText>
            <MonoText>{config.url}</MonoText>
            <MonoText tone="faint">{pairedLine}</MonoText>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
              <EvButton
                variant="outline"
                label={check.state === "testing" ? "Testing…" : "Test connection"}
                onPress={() => void testConnection()}
                style={{ flex: 1 }}
              />
              {check.state === "ok" && <StatusWord tone="observed" word="connected" />}
              {check.state === "bad" && <StatusWord tone="breakage" word="failed" />}
            </View>
            {(check.state === "ok" || check.state === "bad") && <MonoText>{check.detail}</MonoText>}
            <View style={{ flexDirection: "row", gap: 12 }}>
              <EvButton
                variant="outline"
                label="Pair another machine"
                onPress={() => router.push("/pair")}
                style={{ flex: 1 }}
              />
              <EvButton
                variant="ghost"
                label="Unpair"
                onPress={() => {
                  void clearConfig().then(() => {
                    setDraft(null);
                    setCheck({ state: "idle" });
                    setSaved(false);
                    return undefined;
                  });
                }}
              />
            </View>
            <MonoText tone="faint">
              Unpair clears the URL and token on this phone only. The machine keeps the device until
              you revoke it there — Settings → Devices.
            </MonoText>
          </View>
        </Panel>
      ) : (
        <Panel>
          <View style={{ padding: 16, gap: 12 }}>
            <UiText weight="medium">Not paired</UiText>
            <UiText>
              On the machine running Mend, open Settings → Devices and show the pairing code. Scan
              it here and this phone gets its own token.
            </UiText>
            <MonoText tone="faint">no server · no token</MonoText>
            <EvButton label="Pair with your machine" onPress={() => router.push("/pair")} />
          </View>
        </Panel>
      )}
      <Panel>
        <Pressable
          onPress={() => setAdvanced(!advanced)}
          style={{
            padding: 16,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <UiText weight="medium">Advanced</UiText>
          <MonoText tone="faint">{advanced ? "hide" : "server url · bearer token"}</MonoText>
        </Pressable>
        {advanced && (
          <View
            style={{
              paddingHorizontal: 16,
              paddingBottom: 16,
              paddingTop: 12,
              gap: 12,
              borderTopWidth: StyleSheet.hairlineWidth,
              borderTopColor: colors.faintRule,
            }}
          >
            <MonoText tone="faint">
              legacy path — the CLI bearer token (MEND_TOKEN), typed by hand. Pairing replaces it.
            </MonoText>
            <UiText>Server URL (one this phone can reach)</UiText>
            <TextInput
              value={url}
              onChangeText={(next) => {
                setDraft({ url: next, token });
                setSaved(false);
              }}
              placeholder="https://mend.example.com"
              autoCapitalize="none"
              autoCorrect={false}
              style={inputStyle}
            />
            <UiText>Bearer token</UiText>
            <TextInput
              value={token}
              onChangeText={(next) => {
                setDraft({ url, token: next });
                setSaved(false);
              }}
              placeholder="token"
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              style={inputStyle}
            />
            <EvButton
              variant="outline"
              label={saved ? "Saved" : "Save"}
              onPress={() => {
                void saveConfig({
                  url: url.trim().replace(/\/$/, ""),
                  token: token.trim(),
                  deviceName: null,
                  pairedAt: null,
                }).then(() => {
                  setDraft(null);
                  setSaved(true);
                  return undefined;
                });
              }}
            />
            <MonoText tone="faint">
              Sessions, terminal, and review all ride this one connection.
            </MonoText>
          </View>
        )}
      </Panel>
      <Panel>
        <View style={{ padding: 16, gap: 12 }}>
          <UiText>Theme</UiText>
          <Segmented<ThemePreference>
            value={display.theme}
            options={[
              { value: "system", label: "System" },
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
            onChange={(theme) => setDisplayPreferences({ theme })}
          />
          <UiText>Text size</UiText>
          <Segmented<number>
            value={display.textScale}
            options={TEXT_SCALES.map(({ label, value }) => ({ label, value }))}
            onChange={(textScale) => setDisplayPreferences({ textScale })}
          />
          <MonoText>
            Everything scales with this — conversation, terminal, review. This line previews it.
          </MonoText>
        </View>
      </Panel>
      <Panel>
        <View style={{ padding: 16, gap: 12 }}>
          <UiText>Notifications — a push when a session settles or waits on you</UiText>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <EvButton
              variant="outline"
              label={
                push.state === "registering"
                  ? "Registering…"
                  : push.state === "registered"
                    ? "Registered"
                    : "Enable notifications"
              }
              onPress={() => {
                setPush({ state: "registering" });
                void enablePushNotifications().then((result) =>
                  setPush(
                    result.state === "registered"
                      ? { state: "registered" }
                      : { state: "unavailable", reason: result.reason },
                  ),
                );
              }}
              style={{ flex: 1 }}
            />
            {push.state === "registered" && <StatusWord tone="observed" word="registered" />}
            {push.state === "unavailable" && <StatusWord tone="breakage" word="unavailable" />}
          </View>
          {push.state === "unavailable" && <MonoText>{push.reason}</MonoText>}
        </View>
      </Panel>
    </Screen>
  );
}
