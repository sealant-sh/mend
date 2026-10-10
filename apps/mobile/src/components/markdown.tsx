// Assistant prose as real markdown. The renderer is react-native-nitro-markdown
// (md4c parsing over Nitro Modules — the same engine t3code's mobile app uses
// for its non-native markdown path; MIT, pingdotgg/t3code showed the way).
// Theme and node styles are materialized from the Evidence tokens so markdown
// follows the app's scheme and the user's text scale. Math is on (the parser's
// default) and ratex-react-native, autolinked as nitro-markdown's peer, draws
// it. Both are native-only: the web build renders with markdown.web.tsx.

import { useMemo } from "react";
import { Linking, StyleSheet } from "react-native";
import type { NodeStyleOverrides, PartialMarkdownTheme } from "react-native-nitro-markdown";
import { Markdown } from "react-native-nitro-markdown";

import { useTextScale } from "@/components/typography";
import { fontFamilies, radius, useEvidenceTheme } from "@/theme/evidence";

export function MendMarkdown({ children }: { readonly children: string }) {
  const { colors } = useEvidenceTheme();
  const scale = useTextScale();

  const { theme, styles } = useMemo(() => {
    const body = 15 * scale;
    const code = Math.max(10, body * 0.82);
    const markdownTheme: PartialMarkdownTheme = {
      colors: {
        text: colors.ink,
        heading: colors.ink,
        link: colors.accent,
        blockquote: colors.rule,
        border: colors.softRule,
        surface: "transparent",
        surfaceLight: colors.sunken,
        accent: colors.accent,
        tableBorder: colors.softRule,
        tableHeader: colors.sunken,
        tableHeaderText: colors.ink,
        tableRowOdd: "transparent",
        tableRowEven: "transparent",
      },
      spacing: { xs: 4, s: 4, m: 8, l: 8, xl: 16 },
      fontSizes: {
        s: body - 2,
        m: body,
        h1: body * 1.45,
        h2: body * 1.3,
        h3: body * 1.15,
        h4: body * 1.05,
        h5: body,
        h6: body * 0.95,
      },
      fontFamilies: {
        regular: fontFamilies.sans.regular,
        heading: fontFamilies.sans.semibold,
        mono: fontFamilies.mono.regular,
      },
      headingWeight: "600",
      borderRadius: { s: 4, m: radius.md, l: radius.lg },
      showCodeLanguage: false,
    };
    const nodeStyles: NodeStyleOverrides = {
      document: { flexShrink: 1 },
      paragraph: { marginTop: 0, marginBottom: 10 },
      list: { marginTop: 2, marginBottom: 8 },
      list_item: { marginTop: 0, marginBottom: 4 },
      text: { lineHeight: body * 1.53 },
      bold: { fontFamily: fontFamilies.sans.semibold, color: colors.ink },
      italic: { fontStyle: "italic" },
      link: { color: colors.accent, textDecorationLine: "underline" },
      code_inline: {
        fontFamily: fontFamilies.mono.regular,
        fontSize: code,
        color: colors.ink2,
        backgroundColor: colors.sunken,
      },
      code_block: {
        backgroundColor: colors.sunken,
        borderRadius: radius.md,
      },
      blockquote: {
        borderLeftWidth: 2,
        borderLeftColor: colors.rule,
        paddingLeft: 11,
        paddingVertical: 2,
        marginLeft: 0,
        marginVertical: 8,
      },
      heading: {
        fontFamily: fontFamilies.sans.semibold,
        color: colors.ink,
        marginTop: 16,
        marginBottom: 6,
      },
      horizontal_rule: {
        backgroundColor: colors.softRule,
        height: StyleSheet.hairlineWidth,
        marginVertical: 12,
      },
    };
    return { theme: markdownTheme, styles: nodeStyles };
  }, [colors, scale]);

  return (
    <Markdown
      options={{ gfm: true }}
      theme={theme}
      styles={styles}
      onLinkPress={(href) => {
        void Linking.openURL(href).catch(() => undefined);
      }}
    >
      {children}
    </Markdown>
  );
}
