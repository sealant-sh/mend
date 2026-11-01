import { MonoText } from "./typography";

/** Server-worded observations beside the session's other workspace lines. */
export function ResourceStatusLines({ lines }: { readonly lines: ReadonlyArray<string> }) {
  return lines.map((line, index) => (
    <MonoText key={index} tone="ink2" size={12}>
      {line}
    </MonoText>
  ));
}
