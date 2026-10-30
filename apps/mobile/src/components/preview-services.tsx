import { useSecondTick } from "@mend/ui/hooks/use-second-tick";
import { ScrollView, View } from "react-native";

import { MonoText, UiText } from "@/components/typography";
import { previewRowsOf, type WorktreePreviewsDto } from "@/data/previews";

const FOUR_STATUS_LINES_TALL = 120;

export function PreviewServices({ read }: { readonly read: WorktreePreviewsDto | undefined }) {
  const said =
    read !== undefined &&
    (read.unprepared !== null || read.previews.some(({ status }) => status.length > 0));
  return said ? <PreviewLines read={read} /> : null;
}

function PreviewLines({ read }: { readonly read: WorktreePreviewsDto }) {
  const rows = previewRowsOf(read, new Date(useSecondTick() * 1000));
  return (
    <View testID="preview-services" style={{ paddingHorizontal: 16, paddingVertical: 6, gap: 4 }}>
      <UiText tone="label" weight="medium" size={12}>
        Services
      </UiText>
      <ScrollView style={{ maxHeight: FOUR_STATUS_LINES_TALL }} contentContainerStyle={{ gap: 4 }}>
        {rows.map((row) => (
          <View key={row.key} style={{ gap: 2 }}>
            <UiText tone="ink2" size={13} numberOfLines={1}>
              {row.serviceName}
            </UiText>
            {row.lines.map((line) => (
              <MonoText key={line} tone="faint" size={10.5} numberOfLines={2}>
                {line}
              </MonoText>
            ))}
          </View>
        ))}
        {read.unprepared === null ? null : (
          <MonoText tone="faint" size={10.5} numberOfLines={2}>
            {read.unprepared}
          </MonoText>
        )}
      </ScrollView>
    </View>
  );
}
