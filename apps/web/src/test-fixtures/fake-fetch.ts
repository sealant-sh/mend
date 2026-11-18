// What a fake server reads off a request. The code under test passes a string or URL and a string
// body; anything else fails the test loudly instead of reading "[object Request]".

/** The URL a fake server was asked for, as text. */
export const urlText = (input: RequestInfo | URL): string =>
  input instanceof Request ? input.url : input.toString();

/** The text a request carried as its body. */
export const bodyText = (init: { readonly body?: unknown } | undefined): string => {
  const body = init?.body;
  if (typeof body !== "string") throw new Error("Expected a string body");
  return body;
};
