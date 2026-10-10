// Assistant prose as real markdown, on the web build. react-native-nitro-markdown
// parses with md4c through Nitro Modules and draws math with ratex-react-native,
// both native-only, so Metro cannot bundle it for web. Here react-markdown
// (remark, GFM) renders DOM elements styled from the same Evidence tokens and
// sizes as markdown.tsx. Math is parsed so its source survives intact, and shows
// as monospaced source: the fallback nitro-markdown itself uses without RaTeX.

import type { CSSProperties, ReactNode } from "react";
import { createContext, useContext, useMemo } from "react";
import type { Components } from "react-markdown";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

import { useTextScale } from "@/components/typography";
import { fontFamilies, radius, useEvidenceTheme } from "@/theme/evidence";

const remarkPlugins = [remarkGfm, remarkMath];

// A <code> inside <pre> is a block; react-markdown no longer says which.
const InCodeBlock = createContext(false);
const inheritFont: CSSProperties = { fontFamily: "inherit", fontSize: "inherit" };

export function MendMarkdown({ children: source }: { readonly children: string }) {
  const { colors } = useEvidenceTheme();
  const scale = useTextScale();

  const { root, components } = useMemo(() => {
    const body = 15 * scale;
    const code = Math.max(10, body * 0.82);
    const semibold: CSSProperties = {
      fontFamily: fontFamilies.sans.semibold,
      fontWeight: "normal",
    };
    const heading = (size: number): CSSProperties => ({
      ...semibold,
      color: colors.ink,
      fontSize: size,
      lineHeight: 1.3,
      marginTop: 16,
      marginBottom: 6,
    });
    const mono: CSSProperties = { fontFamily: fontFamilies.mono.regular, fontSize: code };
    const codeBlock: CSSProperties = {
      ...mono,
      backgroundColor: colors.sunken,
      borderRadius: radius.md,
      color: colors.ink,
      lineHeight: 1.5,
      margin: "0 0 10px",
      overflowX: "auto",
      padding: 8,
      whiteSpace: "pre",
    };
    const inlineCode: CSSProperties = {
      ...mono,
      backgroundColor: colors.sunken,
      borderRadius: 4,
      color: colors.ink2,
      padding: "1px 4px",
    };
    const cell: CSSProperties = {
      border: `1px solid ${colors.softRule}`,
      padding: "4px 8px",
      textAlign: "left",
      verticalAlign: "top",
    };

    const markdownComponents: Components = {
      p: ({ children }) => <p style={{ margin: "0 0 10px" }}>{children}</p>,
      h1: ({ children }) => <h1 style={heading(body * 1.45)}>{children}</h1>,
      h2: ({ children }) => <h2 style={heading(body * 1.3)}>{children}</h2>,
      h3: ({ children }) => <h3 style={heading(body * 1.15)}>{children}</h3>,
      h4: ({ children }) => <h4 style={heading(body * 1.05)}>{children}</h4>,
      h5: ({ children }) => <h5 style={heading(body)}>{children}</h5>,
      h6: ({ children }) => <h6 style={heading(body * 0.95)}>{children}</h6>,
      strong: ({ children }) => (
        <strong style={{ ...semibold, color: colors.ink }}>{children}</strong>
      ),
      em: ({ children }) => <em style={{ fontStyle: "italic" }}>{children}</em>,
      a: ({ href, children }) => (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: colors.accent, textDecorationLine: "underline" }}
        >
          {children}
        </a>
      ),
      ul: ({ children }) => <ul style={{ margin: "2px 0 8px", paddingLeft: 22 }}>{children}</ul>,
      ol: ({ children, start }) => (
        <ol start={start} style={{ margin: "2px 0 8px", paddingLeft: 22 }}>
          {children}
        </ol>
      ),
      li: ({ children, className }) => (
        <li
          style={{
            margin: "0 0 4px",
            listStyleType: className?.includes("task-list-item") ? "none" : undefined,
          }}
        >
          {children}
        </li>
      ),
      blockquote: ({ children }) => (
        <blockquote
          style={{
            borderLeft: `2px solid ${colors.rule}`,
            margin: "8px 0",
            padding: "2px 0 2px 11px",
          }}
        >
          {children}
        </blockquote>
      ),
      hr: () => (
        <hr
          style={{ border: "none", borderTop: `1px solid ${colors.softRule}`, margin: "12px 0" }}
        />
      ),
      pre: ({ children }) => (
        <pre style={codeBlock}>
          <InCodeBlock.Provider value={true}>{children}</InCodeBlock.Provider>
        </pre>
      ),
      code: ({ children }) => <Code inlineStyle={inlineCode}>{children}</Code>,
      img: ({ src, alt }) => <img src={src} alt={alt ?? ""} style={{ maxWidth: "100%" }} />,
      table: ({ children }) => (
        <div style={{ margin: "0 0 10px", overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse" }}>{children}</table>
        </div>
      ),
      th: ({ children }) => (
        <th style={{ ...cell, ...semibold, backgroundColor: colors.sunken }}>{children}</th>
      ),
      td: ({ children }) => <td style={cell}>{children}</td>,
    };

    const rootStyle: CSSProperties = {
      color: colors.ink,
      flexShrink: 1,
      fontFamily: fontFamilies.sans.regular,
      fontSize: body,
      lineHeight: `${body * 1.53}px`,
      minWidth: 0,
      overflowWrap: "anywhere",
    };
    return { root: rootStyle, components: markdownComponents };
  }, [colors, scale]);

  return (
    <div style={root}>
      <Markdown remarkPlugins={remarkPlugins} components={components}>
        {source}
      </Markdown>
    </div>
  );
}

function Code({
  inlineStyle,
  children,
}: {
  readonly inlineStyle: CSSProperties;
  readonly children?: ReactNode;
}) {
  const block = useContext(InCodeBlock);
  return <code style={block ? inheritFont : inlineStyle}>{children}</code>;
}
