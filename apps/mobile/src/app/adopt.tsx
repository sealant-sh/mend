// Adopt a project — the server host's GitHub CLI answers with repos to tap
// (its credentials, not Mend's), or any network Git clone URL typed by hand.
// Same verb and endpoint as web and CLI; the clone lands in the
// central store and sessions get worktrees from there. The confirm step is a
// sticky bar: picking a repo never requires scrolling back to act.

import { repositoryCloneUrlIssue } from "@mend/domain/workbench";
import { useRouter } from "expo-router";
import { Check } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Keyboard, Pressable, StyleSheet, TextInput, View } from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { EvButton } from "@/components/button";
import { Panel, PanelRow } from "@/components/panel";
import { Screen, SectionLabel } from "@/components/screen";
import { SetupSessionPanel } from "@/components/setup-session";
import { StatusWord } from "@/components/status";
import { BodyText, MonoText, UiText } from "@/components/typography";
import type { GhRepoDto } from "@/data/live";
import { useAdoptProject, useGhRepos, useGhStatus } from "@/data/live";
import { fontFamilies, radius, useEvidenceTheme } from "@/theme/evidence";

/** The server's STORE_NAME rule, mirrored for the inline hint. */
const STORE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** owner/Repo.Name or repo.git to a usable store name. */
const inferName = (source: string): string => {
  const base =
    source
      .replace(/\/+$/, "")
      .replace(/\.git$/, "")
      .split(/[/:]/)
      .at(-1) ?? "";
  return base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 64);
};

/** Waits out a typing burst — gh's search API allows ~30 calls a minute. */
function useDebounced(value: string, ms: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

function RepoRow({
  repo,
  selected,
  onPress,
}: {
  readonly repo: GhRepoDto;
  readonly selected: boolean;
  readonly onPress: () => void;
}) {
  const { colors } = useEvidenceTheme();
  const meta = [
    repo.visibility,
    repo.language ?? undefined,
    repo.stars > 0 ? `★ ${repo.stars}` : undefined,
    repo.pushedAt === null ? undefined : `pushed ${repo.pushedAt.slice(0, 10)}`,
    repo.isFork ? "fork" : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" · ");
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        {
          paddingHorizontal: 16,
          paddingVertical: 12,
          gap: 4,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: colors.faintRule,
        },
        selected && { backgroundColor: colors.wash },
        pressed && { backgroundColor: colors.sunken },
      ]}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <UiText weight="medium" size={14} numberOfLines={1} style={{ flexShrink: 1 }}>
          {repo.nameWithOwner}
        </UiText>
        {selected ? <Check size={16} color={colors.accent} strokeWidth={2.5} /> : null}
      </View>
      {repo.description === null ? null : (
        <UiText tone="muted" size={12.5} numberOfLines={1}>
          {repo.description}
        </UiText>
      )}
      <MonoText tone="faint" size={11}>
        {meta}
      </MonoText>
    </Pressable>
  );
}

export default function AdoptScreen() {
  const router = useRouter();
  const { colors } = useEvidenceTheme();
  const insets = useSafeAreaInsets();
  const status = useGhStatus();
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebounced(query.trim(), 350);
  const discovery = status.data?.available === true && status.data.authenticated;
  const repos = useGhRepos(debouncedQuery, discovery);
  const [selected, setSelected] = useState<GhRepoDto | null>(null);
  const [manualSource, setManualSource] = useState("");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const adopt = useAdoptProject();
  const [adoptedId, setAdoptedId] = useState<string | null>(null);

  const source = selected === null ? manualSource.trim() : `${selected.url}.git`;
  const sourceIssue = source === "" ? null : repositoryCloneUrlIssue(source);
  const nameOk = STORE_NAME.test(name);

  const pick = (repo: GhRepoDto) => {
    Keyboard.dismiss();
    adopt.reset();
    const deselecting = selected?.nameWithOwner === repo.nameWithOwner;
    setSelected(deselecting ? null : repo);
    setManualSource("");
    if (!nameTouched) setName(deselecting ? "" : inferName(repo.nameWithOwner));
  };

  const typeSource = (value: string) => {
    adopt.reset();
    setManualSource(value);
    setSelected(null);
    if (!nameTouched) setName(inferName(value.trim()));
  };

  const submit = () => {
    if (source === "" || sourceIssue !== null || !nameOk || adopt.isPending) return;
    Keyboard.dismiss();
    adopt.mutate({ name, source }, { onSuccess: (project) => setAdoptedId(project.id) });
  };

  if (adoptedId !== null)
    return (
      <Screen>
        <SetupSessionPanel projectId={adoptedId} onClose={() => router.back()} />
      </Screen>
    );

  const inputStyle = {
    borderWidth: 1,
    borderColor: colors.rule,
    borderRadius: radius.lg,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.ink,
    fontFamily: fontFamilies.mono.regular,
    fontSize: 13,
  } as const;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Screen>
        <BodyText tone="muted">
          Clones into the central store on the server; sessions run in worktrees from that copy,
          never your checkout.
        </BodyText>

        <SectionLabel>
          {status.data?.login == null ? "github" : `github · ${status.data.login}`}
        </SectionLabel>
        {status.isPending ? (
          <Panel>
            <View style={{ padding: 16 }}>
              <MonoText tone="faint">asking the server's gh…</MonoText>
            </View>
          </Panel>
        ) : discovery ? (
          <Panel>
            <View style={{ padding: 12, paddingBottom: 8 }}>
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder="Search github — empty shows your latest"
                placeholderTextColor={colors.faint}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="search"
                style={inputStyle}
              />
            </View>
            {repos.isPending ? (
              <PanelRow>
                <MonoText tone="faint">searching…</MonoText>
              </PanelRow>
            ) : repos.isError ? (
              <PanelRow>
                <MonoText tone="danger" size={11.5}>
                  {repos.error.message}
                </MonoText>
              </PanelRow>
            ) : repos.data.length === 0 ? (
              <PanelRow>
                <MonoText tone="faint">nothing matched</MonoText>
              </PanelRow>
            ) : (
              repos.data.map((repo) => (
                <RepoRow
                  key={repo.nameWithOwner}
                  repo={repo}
                  selected={selected?.nameWithOwner === repo.nameWithOwner}
                  onPress={() => pick(repo)}
                />
              ))
            )}
          </Panel>
        ) : (
          <Panel>
            <View style={{ padding: 16, gap: 8 }}>
              <UiText>GitHub discovery is unavailable on the server</UiText>
              <MonoText tone="muted" size={11.5}>
                {status.data?.detail ??
                  (status.error instanceof Error ? status.error.message : "no detail reported")}
              </MonoText>
              {status.data?.available === true ? (
                <MonoText tone="faint" size={11.5}>
                  run `gh auth login` on the server machine, then reopen this screen
                </MonoText>
              ) : null}
            </View>
          </Panel>
        )}

        <SectionLabel>clone URL</SectionLabel>
        <Panel>
          <View style={{ padding: 16, gap: 8 }}>
            <UiText>HTTP(S), SSH, or SCP-style Git URL</UiText>
            <TextInput
              value={manualSource}
              onChangeText={typeSource}
              placeholder="https://github.com/owner/repo.git"
              placeholderTextColor={colors.faint}
              autoCapitalize="none"
              autoCorrect={false}
              style={inputStyle}
            />
            {sourceIssue === null ? null : (
              <MonoText tone="danger" size={11}>
                {sourceIssue}
              </MonoText>
            )}
          </View>
        </Panel>
      </Screen>

      {source === "" ? null : (
        <KeyboardStickyView offset={{ closed: 0, opened: insets.bottom }}>
          <View
            style={{
              backgroundColor: colors.panel,
              borderTopWidth: StyleSheet.hairlineWidth,
              borderTopColor: colors.softRule,
              paddingHorizontal: 16,
              paddingTop: 12,
              paddingBottom: Math.max(insets.bottom, 12),
              gap: 8,
            }}
          >
            <MonoText tone="faint" size={11} numberOfLines={1}>
              {source}
            </MonoText>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <TextInput
                value={name}
                onChangeText={(value) => {
                  adopt.reset();
                  setNameTouched(true);
                  setName(value);
                }}
                placeholder="project-name"
                placeholderTextColor={colors.faint}
                autoCapitalize="none"
                autoCorrect={false}
                style={[inputStyle, { flex: 1, paddingVertical: 8 }]}
              />
              <EvButton
                label={adopt.isPending ? "Adopting…" : "Adopt"}
                onPress={submit}
                style={
                  nameOk && sourceIssue === null && !adopt.isPending ? undefined : { opacity: 0.5 }
                }
              />
            </View>
            {name !== "" && !nameOk ? (
              <MonoText tone="muted" size={11}>
                lowercase letters, digits, ".", "_", "-" — starting with a letter or digit
              </MonoText>
            ) : null}
            {adopt.isPending ? <StatusWord tone="live" word="cloning into the store" /> : null}
            {adopt.isError ? (
              <View style={{ gap: 4 }}>
                <StatusWord tone="breakage" word="failed" />
                <MonoText tone="danger" size={11}>
                  {adopt.error.message}
                </MonoText>
              </View>
            ) : null}
          </View>
        </KeyboardStickyView>
      )}
    </View>
  );
}
