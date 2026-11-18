import { NativeSelect, NativeSelectOption } from "@mend/ui/components/ui/native-select";
import { ToggleGroup, ToggleGroupItem } from "@mend/ui/components/ui/toggle-group";

import {
  TERMINAL_FACES,
  TERMINAL_SIZES,
  terminalFamily,
  terminalFont,
  TEXT_SIZES,
  textSize,
} from "#/lib/appearance";
import { setThemePreference, type ThemePreference, useThemePreference } from "#/lib/theme";

import { SettingRow, SettingSection } from "./setting-row.tsx";
import { SettingsPage } from "./settings-page.tsx";

const THEMES: ReadonlyArray<{ readonly value: ThemePreference; readonly label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/**
 * Settings → This device → Appearance (Doop "Settings · This device · Appearance"): theme, text
 * size and the terminal's font, for this browser only (docs/adr/0025). The theme is the same
 * choice the account menu sets. Each applies at once and is kept in a cookie, so the next page
 * load draws it from the first paint.
 */
export function AppearancePage() {
  const theme = useThemePreference();
  const size = textSize.use();
  const font = terminalFont.use();
  return (
    <SettingsPage
      page="d-appearance"
      intro="Mend saves these in this browser. Your phone and other browsers keep their own."
    >
      <SettingSection title="Display">
        <SettingRow
          layout="stack"
          label="Theme"
          description="System follows your computer's light or dark setting."
          control={
            <Segmented label="Theme" value={theme} choices={THEMES} onChange={setThemePreference} />
          }
        />
        <SettingRow
          layout="stack"
          label="Text size"
          description="The size of text across Mend in this browser."
          control={
            <Segmented
              label="Text size"
              value={size}
              choices={TEXT_SIZES}
              onChange={textSize.set}
            />
          }
        />
      </SettingSection>
      <SettingSection title="Terminal">
        <SettingRow
          layout="stack"
          label="Terminal font"
          labelFor="terminal-font"
          description="The font for terminals in your sessions. If this browser doesn't have it, Mend uses Geist Mono."
          note={
            <p
              aria-hidden
              style={{ fontFamily: terminalFamily(font), fontSize: `${font.size}px` }}
              className="mt-2 truncate rounded-lg bg-muted px-3 py-2.5 text-foreground"
            >
              <span className="text-muted-foreground">~/checkout-api $ </span>pnpm vitest run
              payments
            </p>
          }
          control={
            <NativeSelect
              id="terminal-font"
              value={font.face}
              onChange={(event) => terminalFont.set({ ...font, face: event.target.value })}
              size="field"
              className="w-56 max-lg:w-full"
            >
              {TERMINAL_FACES.map((face) => (
                <NativeSelectOption key={face.id} value={face.id}>
                  {face.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          }
        />
        <SettingRow
          layout="stack"
          label="Terminal font size"
          labelFor="terminal-font-size"
          description="Text size in terminals, separate from the rest of Mend."
          control={
            <NativeSelect
              id="terminal-font-size"
              value={String(font.size)}
              onChange={(event) => terminalFont.set({ ...font, size: Number(event.target.value) })}
              size="field"
              className="w-28 max-lg:w-full"
            >
              {TERMINAL_SIZES.map((option) => (
                <NativeSelectOption key={option} value={String(option)}>
                  {option} px
                </NativeSelectOption>
              ))}
            </NativeSelect>
          }
        />
      </SettingSection>
    </SettingsPage>
  );
}

/**
 * A choice of a few, side by side (the frames' segmented control): the kit's ToggleGroup, one
 * value always picked.
 */
function Segmented<T extends string>({
  label,
  value,
  choices,
  onChange,
}: {
  readonly label: string;
  readonly value: T;
  readonly choices: ReadonlyArray<{ readonly value: T; readonly label: string }>;
  readonly onChange: (value: T) => void;
}) {
  return (
    <ToggleGroup
      aria-label={label}
      value={[value]}
      onValueChange={(next: ReadonlyArray<unknown>) => {
        const picked = choices.find((choice) => choice.value === next[0]);
        if (picked !== undefined) onChange(picked.value);
      }}
      spacing={0.5}
      className="rounded-lg bg-muted p-0.5 max-lg:grid max-lg:w-full max-lg:grid-cols-3"
    >
      {choices.map((choice) => (
        <ToggleGroupItem
          key={choice.value}
          value={choice.value}
          className="h-8 rounded-md px-3.5 text-row text-muted-foreground hover:bg-transparent aria-pressed:bg-card aria-pressed:text-foreground aria-pressed:shadow-[0_0_0_1px_var(--color-input)] max-lg:h-10 max-lg:text-lead"
        >
          {choice.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
