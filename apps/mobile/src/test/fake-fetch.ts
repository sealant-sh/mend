// What a fake server reads off a request. The code under test passes a string or URL and a JSON
// string body; anything else fails the test loudly instead of reading "[object Request]".

/** The URL a fake server was asked for. */
export const requestUrl = (input: RequestInfo | URL): URL =>
  new URL(input instanceof Request ? input.url : input);

/** The JSON a request carried as its body. */
export const jsonBody = (init: RequestInit | undefined): unknown => {
  const body = init?.body;
  if (typeof body !== "string") throw new Error("Expected a JSON string body");
  return JSON.parse(body);
};
