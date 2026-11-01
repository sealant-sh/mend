/** Server-worded observations in the existing session header. */
export function ResourceStatusLines({ lines }: { readonly lines: ReadonlyArray<string> }) {
  return lines.map((line, index) => (
    <p key={index} className="mt-1 font-mono text-xs break-words text-ink-2">
      {line}
    </p>
  ));
}
