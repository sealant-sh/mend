import type { IncomingMessage, ServerResponse } from "node:http";

import { type HandoffWorld, handoffWorlds, newsroomCheckout } from "@mend/local-git/testing";

import { mainTestFixtures } from "../main-test-fixtures.ts";

export const ORIGIN = "https://github.com/acme/newsroom-api.git";
export const SESSION_ID = "3f2a1c0d-6b1e-4c2a-9d1f-0a1b2c3d4e5f";
export const FILE_BYTES = 64 * 1024;

export const project = {
  id: "project-1",
  name: "newsroom-api",
  originUrl: ORIGIN,
  storePath: "/srv/mend/newsroom-api/repo.git",
  defaultBranch: "main",
};

export const OLD_SERVER =
  "mend: this Mend server (0.35.1) does not take handoffs · upgrade it, then hand off again · nothing was created\n";

export const newsroom = (w: HandoffWorld, name?: string, origin = ORIGIN) =>
  newsroomCheckout(w, origin, name);

export const received = (
  overrides: {
    readonly name?: string;
    readonly replayed?: boolean;
    readonly status?: string;
    readonly summary?: string | null;
    readonly previous?: string | null;
  } = {},
) => ({
  session: {
    id: SESSION_ID,
    harness: "claude",
    status: overrides.status ?? "idle",
    summary: overrides.summary ?? null,
  },
  worktree: { id: "worktree-1", name: overrides.name ?? "fix-login" },
  commitsAhead: 2,
  replayed: overrides.replayed ?? false,
  previous:
    overrides.previous === undefined || overrides.previous === null
      ? null
      : { name: overrides.previous },
});

interface Fake {
  readonly routes: Array<string>;
  readonly bodies: Array<Buffer>;
  readonly launches: Array<unknown>;
  readonly adoptions: Array<unknown>;
}

const readBody = async (request: IncomingMessage): Promise<Buffer> => {
  const chunks: Array<Buffer> = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
};

export const withBody = (request: IncomingMessage, reply: (body: Buffer) => void): void => {
  void (async () => reply(await readBody(request)))();
};

/** Registers the file's hooks, so each test file calls it once at the top. */
export const mainHandoffFixtures = () => {
  const main = mainTestFixtures();
  const world = handoffWorlds();
  const { json, startCli, startFakeMend } = main;

  const handoffServer = async (
    options: {
      readonly projects?: ReadonlyArray<unknown>;
      readonly terms?: (response: ServerResponse) => void;
      readonly answer?: (response: ServerResponse, attempt: number) => void;
      readonly launch?: (response: ServerResponse) => void;
      readonly mountDelivery?: "bind" | "sources";
      readonly socket?: "end" | "drop";
    } = {},
  ) => {
    const fake: Fake = { routes: [], bodies: [], launches: [], adoptions: [] };
    const server = await startFakeMend((request, response) => {
      const route = `${request.method ?? "GET"} ${request.url ?? ""}`;
      fake.routes.push(route);
      if (route === "GET /api/projects") json(response, options.projects ?? [project]);
      else if (route === "GET /api/health") json(response, { version: "0.35.1" });
      else if (route === "GET /api/organization") {
        json(response, { mountDelivery: options.mountDelivery ?? "sources" });
      } else if (route === "GET /api/me/git-access") json(response, { mode: "bridge" });
      else if (route === `GET /api/projects/${project.id}/handoffs`) {
        if (options.terms === undefined) {
          json(response, { bundleBytes: 64 * 1024 * 1024, fileBytes: FILE_BYTES });
        } else options.terms(response);
      } else if (route === "GET /api/projects/handoff-probe/handoffs") {
        if (options.terms === undefined) {
          response.writeHead(404, { "content-type": "application/json" });
          response.end(JSON.stringify({ _tag: "NotFound", id: "handoff-probe" }));
        } else options.terms(response);
      } else if (route.startsWith(`POST /api/projects/${project.id}/handoffs?`)) {
        withBody(request, (body) => {
          fake.bodies.push(body);
          if (options.answer === undefined) json(response, received());
          else options.answer(response, fake.bodies.length);
        });
      } else if (route === `POST /api/sessions/${SESSION_ID}/launch`) {
        withBody(request, (body) => {
          fake.launches.push(JSON.parse(body.toString()));
          if (options.launch === undefined) {
            json(response, { ...received().session, status: "running", summary: null });
          } else options.launch(response);
        });
      } else if (route === "POST /api/projects") {
        withBody(request, (body) => {
          fake.adoptions.push(JSON.parse(body.toString()));
          json(response, project);
        });
      } else response.writeHead(404).end();
    }, options.socket);
    return { ...fake, server };
  };

  const run = async (
    server: Awaited<ReturnType<typeof handoffServer>>,
    args: ReadonlyArray<string>,
    cwd: string,
    env: Readonly<Record<string, string>> = {},
  ) => {
    const cli = startCli(server.server.url, ["handoff", ...args], env, cwd);
    const { code } = await cli.exited;
    await server.server.close();
    return { code, stdout: cli.stdout(), stderr: cli.stderr() };
  };

  return { ...main, world, handoffServer, run };
};
