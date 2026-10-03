// Start a session with its launch tunables: model, thinking effort, and
// priority (codex only — claude's fast mode is an in-session toggle the
// platform doesn't expose at launch). The lists come from the server's catalog
// (docs/models-audit.md); the picker preselects the server's default for the
// harness, and what it shows is what the launch sends and the session records.
// Choices persist per harness on device.

import { modelPicker, type HarnessModelCatalogView } from "@mend/domain/workbench";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { useState, type ReactNode } from "react";
import { Pressable, TextInput, View } from "react-native";

import { EvButton } from "@/components/button";
import { PanelRow } from "@/components/panel";
import { MonoText, UiText } from "@/components/typography";
import { setLaunchOptions, useLaunchOptions, type LaunchOptions } from "@/data/harness-options";
import { catalogOf, PROTOCOL_HARNESSES, useHarnessModels, useProjectBranches } from "@/data/live";
import { fontFamilies, radius, useEvidenceTheme } from "@/theme/evidence";

function Chip({
  label,
  detail,
  chosen,
  onPress,
}: {
  readonly label: string;
  /** A quiet mono note after the label (`default`). */
  readonly detail?: string | undefined;
  readonly chosen: boolean;
  readonly onPress: () => void;
}) {
  const { colors } = useEvidenceTheme();
  return (
    <Pressable
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        borderWidth: 1,
        borderColor: chosen ? colors.accent : colors.rule,
        backgroundColor: chosen ? colors.wash : colors.panel,
        borderRadius: radius.lg,
        paddingHorizontal: 10,
        paddingVertical: 6,
      }}
    >
      <UiText tone={chosen ? "accent" : "ink2"} size={12}>
        {label}
      </UiText>
      {detail === undefined ? null : (
        <MonoText tone="faint" size={10.5}>
          {detail}
        </MonoText>
      )}
    </Pressable>
  );
}

function OptionGroup({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <View style={{ gap: 6 }}>
      <MonoText tone="faint" size={10.5}>
        {label}
      </MonoText>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>{children}</View>
    </View>
  );
}

/** The row's one-line summary: the model the launch will run, then the effort and speed chosen. */
const summaryOf = (
  picker: ReturnType<typeof modelPicker>,
  catalog: HarnessModelCatalogView,
  speed: LaunchOptions["speed"],
): string => {
  const parts = [picker.hasModels ? picker.modelLabel : "harness default"];
  if (picker.effort !== null) parts.push(picker.effort);
  if (catalog.fastCapable && speed === "fast") parts.push("fast");
  return parts.join(" · ");
};

function HarnessRow({
  harness,
  catalog,
  first,
  pending,
  projectId,
  onStart,
}: {
  readonly harness: string;
  readonly catalog: HarnessModelCatalogView;
  readonly first: boolean;
  readonly pending: boolean;
  readonly projectId: string;
  readonly onStart: (harness: string, options: LaunchOptions, base: string | null) => void;
}) {
  const { colors } = useEvidenceTheme();
  const options = useLaunchOptions(harness);
  // The one picker (docs/models-audit.md): the server's catalog, the sticky choice, the default
  // preselected. Built once in the domain; the phone only draws chips from it.
  const picker = modelPicker(catalog, options);
  const [open, setOpen] = useState(false);
  // Per-launch, not persisted: "which branch" is a decision about THIS session.
  const [base, setBase] = useState<string | null>(null);
  const branches = useProjectBranches(projectId, open);
  const set = (patch: Partial<LaunchOptions>) =>
    setLaunchOptions(harness, { ...options, ...patch });
  const Chevron = open ? ChevronDown : ChevronRight;
  // What the launch sends: the picker's effective model and effort, never a raw sticky value.
  const launchOptions: LaunchOptions = {
    model: picker.model,
    effort: picker.effort,
    speed: catalog.fastCapable ? options.speed : null,
  };

  return (
    <PanelRow first={first}>
      <View style={{ gap: 10 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Pressable
            onPress={() => setOpen((current) => !current)}
            style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 6 }}
          >
            <Chevron size={14} color={colors.faint} strokeWidth={1.8} />
            <View style={{ gap: 2, flexShrink: 1 }}>
              <UiText weight="medium" size={13.5}>
                {harness}
              </UiText>
              <MonoText tone="faint" size={10.5}>
                {summaryOf(picker, catalog, options.speed)}
              </MonoText>
            </View>
          </Pressable>
          <EvButton
            size="sm"
            variant="outline"
            label={pending ? "…" : "Start"}
            disabled={pending}
            onPress={() => onStart(harness, launchOptions, base)}
          />
        </View>
        {open && (
          <View style={{ gap: 10 }}>
            {picker.hasModels && (
              <OptionGroup label="model">
                {picker.models.map((model) => (
                  <Chip
                    key={model.id}
                    label={model.label}
                    detail={model.isDefault ? "default" : undefined}
                    chosen={model.selected}
                    onPress={() => set({ model: model.id })}
                  />
                ))}
              </OptionGroup>
            )}
            {picker.efforts.length > 1 && (
              <OptionGroup label="thinking">
                {picker.efforts.map((row) => (
                  <Chip
                    key={row.effort ?? "default"}
                    label={row.label}
                    chosen={row.selected}
                    onPress={() => set({ effort: row.effort })}
                  />
                ))}
              </OptionGroup>
            )}
            {(branches.data ?? []).length > 0 && (
              <OptionGroup label="base">
                <Chip label="default" chosen={base === null} onPress={() => setBase(null)} />
                {(branches.data ?? [])
                  .filter((branch) => !branch.isDefault)
                  .slice(0, 8)
                  .map((branch) => (
                    <Chip
                      key={branch.name}
                      label={branch.name}
                      chosen={base === branch.name}
                      onPress={() => setBase(branch.name)}
                    />
                  ))}
              </OptionGroup>
            )}
            {catalog.fastCapable && (
              <OptionGroup label="priority">
                <Chip
                  label="standard"
                  chosen={options.speed === null}
                  onPress={() => set({ speed: null })}
                />
                <Chip
                  label="fast"
                  chosen={options.speed === "fast"}
                  onPress={() => set({ speed: "fast" })}
                />
              </OptionGroup>
            )}
          </View>
        )}
      </View>
    </PanelRow>
  );
}

/** The harness rows for one project — drop inside a Panel. */
export function StartSessionRows({
  pending,
  projectId,
  onStart,
  first = true,
}: {
  readonly pending: boolean;
  readonly projectId: string;
  readonly onStart: (
    harness: string,
    options: LaunchOptions,
    base: string | null,
    name: string | null,
  ) => void;
  /** Whether the first harness row is the panel's first row. */
  readonly first?: boolean;
}) {
  const { colors } = useEvidenceTheme();
  const catalogs = useHarnessModels();
  // The worktree's name comes first — it is the identity being created.
  const [name, setName] = useState("");
  const cleaned = name
    .trim()
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 64);
  return (
    <>
      <PanelRow first={first}>
        <TextInput
          value={name}
          onChangeText={(value) => setName(value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-"))}
          placeholder="worktree name — e.g. fix-auth (empty = auto)"
          placeholderTextColor={colors.faint}
          autoCapitalize="none"
          autoCorrect={false}
          style={{
            fontFamily: fontFamilies.mono.regular,
            fontSize: 12,
            color: colors.ink,
            paddingVertical: 2,
          }}
        />
      </PanelRow>
      {PROTOCOL_HARNESSES.map((harness) => (
        <HarnessRow
          key={harness}
          harness={harness}
          catalog={catalogOf(catalogs.data, harness)}
          first={false}
          pending={pending}
          projectId={projectId}
          onStart={(chosenHarness, options, base) =>
            onStart(chosenHarness, options, base, cleaned === "" ? null : cleaned)
          }
        />
      ))}
    </>
  );
}
