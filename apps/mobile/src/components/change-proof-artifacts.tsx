import { Image } from "expo-image";
import { Link } from "expo-router";
import { useState } from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { EvButton } from "@/components/button";
import { Panel, PanelRow } from "@/components/panel";
import { ProofVideo } from "@/components/proof-video";
import { MonoText, UiText } from "@/components/typography";
import { usePairing } from "@/data/pairing-scope";
import { proofMediaSource } from "@/data/proof-media";
import { useChangeProofArtifacts, type ProofArtifactViewDto } from "@/data/review";
import { useEvidenceTheme } from "@/theme/evidence";

export function ChangeProofArtifacts({ changeId }: { readonly changeId: string }) {
  const captures = useChangeProofArtifacts(changeId);
  const [openId, setOpenId] = useState<string | null>(null);
  const open = captures.data?.find((view) => view.artifact.id === openId);
  if (captures.isSuccess && captures.data.length === 0) return null;
  return (
    <View style={{ gap: 12 }}>
      <UiText size={12} weight="medium" tone="label">
        Proof artifacts
      </UiText>
      <Panel>
        {captures.isError ? (
          <PanelRow first>
            <UiText>The proof artifacts could not be read.</UiText>
            <EvButton
              size="sm"
              variant="ghost"
              label="Try again"
              onPress={() => void captures.refetch()}
            />
          </PanelRow>
        ) : captures.isPending ? (
          <PanelRow first>
            <MonoText tone="faint">Reading proof artifacts…</MonoText>
          </PanelRow>
        ) : (
          captures.data.map((view, index) => (
            <PanelRow key={view.artifact.id} first={index === 0}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={view.label}
                onPress={() => setOpenId(view.artifact.id)}
                style={{ gap: 12 }}
              >
                <View style={{ width: 120 }}>
                  <ProofMedia view={view} thumbnail />
                </View>
                <UiText>{view.label}</UiText>
              </Pressable>
            </PanelRow>
          ))
        )}
      </Panel>
      {open === undefined ? null : (
        <ProofDetails key={open.artifact.id} view={open} onClose={() => setOpenId(null)} />
      )}
    </View>
  );
}

function ProofMedia({
  view,
  thumbnail = false,
}: {
  readonly view: ProofArtifactViewDto;
  readonly thumbnail?: boolean;
}) {
  const { machine } = usePairing();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const capture = view.artifact.capture;
  if (failed)
    return (
      <View style={{ gap: 8 }}>
        <UiText tone="muted">This capture could not be loaded.</UiText>
        <EvButton
          size="sm"
          variant="ghost"
          label="Try again"
          onPress={() => {
            setFailed(false);
            setAttempt((value) => value + 1);
          }}
        />
      </View>
    );
  if (view.mediaPath === null)
    return (
      <MonoText size={11} tone="faint">
        {capture._tag === "Recording"
          ? "Recording…"
          : capture._tag === "NotCaptured"
            ? `Not captured · ${capture.reason}`
            : "Media unavailable"}
      </MonoText>
    );
  const source = proofMediaSource(machine.connection, view.mediaPath);
  return capture._tag === "Screenshot" ? (
    <Image
      key={attempt}
      source={source}
      accessibilityLabel={
        thumbnail ? view.artifact.title : view.artifact.caption || view.artifact.title
      }
      contentFit="contain"
      cachePolicy="none"
      onError={() => setFailed(true)}
      style={{ width: "100%", aspectRatio: 1.6 }}
    />
  ) : capture._tag === "Video" ? (
    <ProofVideo source={source} thumbnail={thumbnail} />
  ) : null;
}

function ProofDetails({
  view,
  onClose,
}: {
  readonly view: ProofArtifactViewDto;
  readonly onClose: () => void;
}) {
  const { colors } = useEvidenceTheme();
  const insets = useSafeAreaInsets();
  const { artifact } = view;
  const capture = artifact.capture;
  const position =
    capture._tag === "Screenshot"
      ? `screen log · seq ${capture.moment.seq}`
      : capture._tag === "Video"
        ? `screen log · seq ${capture.span.fromSeq}–${capture.span.toSeq}`
        : capture._tag === "Recording"
          ? `screen log · seq ${capture.fromSeq}`
          : null;
  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <ScrollView
        style={{ backgroundColor: colors.bg }}
        contentContainerStyle={{
          paddingTop: insets.top + 16,
          paddingBottom: insets.bottom + 24,
          paddingHorizontal: 20,
          gap: 16,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <View style={{ flex: 1 }}>
            <UiText weight="semibold">{artifact.title}</UiText>
          </View>
          <EvButton size="sm" variant="ghost" label="Close" onPress={onClose} />
        </View>
        <MonoText size={11}>{view.label}</MonoText>
        <ProofMedia view={view} />
        <UiText>{artifact.caption}</UiText>
        {artifact.source._tag === "Unknown" ? (
          <UiText tone="muted">Source unknown · {artifact.source.reason}</UiText>
        ) : null}
        {artifact.sessionId === null ? (
          <UiText tone="muted">Session removed</UiText>
        ) : (
          <Link
            href={{ pathname: "/session/[id]", params: { id: artifact.sessionId } }}
            onPress={onClose}
          >
            <UiText tone="accent">Open session</UiText>
          </Link>
        )}
        {artifact.launch === null ? null : (
          <View style={{ gap: 4 }}>
            <UiText size={12} tone="label">
              launch
            </UiText>
            <MonoText>{artifact.launch}</MonoText>
          </View>
        )}
        {artifact.differences === null ? null : (
          <View style={{ gap: 4 }}>
            <UiText size={12} tone="label">
              differences
            </UiText>
            <UiText>{artifact.differences}</UiText>
          </View>
        )}
        {position === null ? null : (
          <MonoText size={11} tone="faint">
            {position}
          </MonoText>
        )}
      </ScrollView>
    </Modal>
  );
}
