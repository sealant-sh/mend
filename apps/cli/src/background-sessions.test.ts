import { describe, expect, it } from "vitest";

import { resolveBackgroundSessions, type ReadRoute } from "./background-sessions.ts";
import { MendRequestError } from "./server-request.ts";

const notFound = new MendRequestError("http", "not found", 404);
const unavailable = new MendRequestError("http", "the server answered 503", 503);
const noAnswer = new MendRequestError("unreachable", "cannot reach the server", null);

/** A server answering each route with a value, or refusing it. */
const server = (answers: Readonly<Record<string, unknown>>) => {
  const asked: Array<string> = [];
  const read: ReadRoute = async (route) => {
    asked.push(route);
    const answer = answers[route];
    if (answer instanceof Error) throw answer;
    if (answer === undefined) throw notFound;
    return answer;
  };
  return { asked, read };
};

const resolve = async (
  answers: Readonly<Record<string, unknown>>,
  stance: "inherit" | "on" | "off" = "inherit",
) => {
  const { asked, read } = server(answers);
  const said: Array<string> = [];
  const background = await resolveBackgroundSessions(stance, read, (line) => said.push(line));
  return { background, asked, said };
};

describe("which lifecycle a CLI launch takes", () => {
  it("takes the project's own stance without asking", async () => {
    expect(await resolve({}, "off")).toEqual({ background: false, asked: [], said: [] });
    expect(await resolve({}, "on")).toEqual({ background: true, asked: [], said: [] });
  });

  it("follows the person's own resolved setting", async () => {
    const result = await resolve({
      "/me/automation": { effective: { backgroundSessions: false } },
      "/organization/settings": { effective: { backgroundSessions: true } },
    });
    expect(result).toEqual({ background: false, asked: ["/me/automation"], said: [] });
  });

  it("asks the older questions only of a server that does not know the route", async () => {
    const result = await resolve({
      "/organization/settings": { effective: { backgroundSessions: false } },
    });
    expect(result).toEqual({
      background: false,
      asked: ["/me/automation", "/organization/settings"],
      said: [],
    });
    expect(await resolve({ "/settings": { backgroundSessions: false } })).toMatchObject({
      background: false,
      asked: ["/me/automation", "/organization/settings", "/settings"],
    });
  });

  it.each([
    ["a server error", unavailable],
    ["no answer", noAnswer],
  ])(
    "stays in the background on %s, says the setting was not read, and never reads the organization's",
    async (_, failure) => {
      const result = await resolve({
        "/me/automation": failure,
        "/organization/settings": { effective: { backgroundSessions: false } },
      });
      expect(result).toEqual({
        background: true,
        asked: ["/me/automation"],
        said: ["your background-sessions setting could not be read · running in the background"],
      });
    },
  );
});
