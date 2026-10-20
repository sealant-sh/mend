/** Text with every line ending as LF: CRLF and a lone CR alike, as a terminal paste reads them. */
export const lfOnly = (text: string): string =>
  text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
