import { once } from "node:events";
import * as fs from "node:fs";
import { createServer } from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import { SessionId } from "@mend/domain";
import { AgentTurn } from "@mend/domain/workbench";
import { describe, expect, it } from "vitest";

import { mainTestFixtures } from "./main-test-fixtures.ts";
import { encodeReceipt, messageTurn, steerReceipt, turnReceipt } from "./message-test-fixtures.ts";

const { spawning, session, project, startFakeMend, startCli, json } = mainTestFixtures();
const fullId = "0c9f7e1a-6b2d-4c6e-9a51-3f2a7d1b8c40";
const row = { ...session, id: fullId, worktree: "api-follow-up", status: "completed" };

describe("mend message through main", spawning, () => {
  it.each([fullId, "0c9f", "api-follow-up"])(
    "resolves %s and posts only to messages with the caller token",
    async (word) => {
      const routes: Array<string> = [];
      const bodies: Array<unknown> = [];
      const authorizations: Array<string | undefined> = [];
      const receipt = turnReceipt();
      const fake = await startFakeMend((request, response) => {
        const route = `${request.method} ${request.url}`;
        routes.push(route);
        authorizations.push(request.headers.authorization);
        if (route === `GET /api/sessions/${fullId}`) json(response, { session: row });
        else if (route === "GET /api/projects") json(response, [project]);
        else if (route === `GET /api/projects/${project.id}?deadEnds=include`)
          json(response, { project, sessions: [row] });
        else if (route === `POST /api/sessions/${fullId}/messages`) {
          let body = "";
          request.setEncoding("utf8");
          request.on("data", (chunk: string) => {
            body += chunk;
          });
          request.on("end", () => {
            bodies.push(JSON.parse(body));
            json(
              response,
              encodeReceipt(
                receipt._tag === "Turn"
                  ? {
                      ...receipt,
                      turn: new AgentTurn({ ...messageTurn, sessionId: SessionId.make(fullId) }),
                    }
                  : receipt,
              ),
            );
          });
        } else response.writeHead(500).end();
      });
      try {
        const cli = startCli(
          fake.url,
          ["message", word, "--queue", "-", "--json"],
          { MEND_TOKEN: "fake-message-token" },
          undefined,
          "  exact stdin\n\n",
        );
        await cli.closed;
        expect(await cli.exited, cli.stderr()).toEqual({ kind: "exit", code: 0 });
        expect(bodies).toEqual([
          {
            input: "  exact stdin\n\n",
            clientMessageId: expect.stringMatching(/^[0-9a-f-]{36}$/),
            queue: true,
          },
        ]);
        expect(authorizations.every((value) => value === "Bearer fake-message-token")).toBe(true);
        expect(routes).toEqual(
          word === fullId
            ? [`GET /api/sessions/${fullId}`, `POST /api/sessions/${fullId}/messages`]
            : [
                "GET /api/projects",
                `GET /api/projects/${project.id}?deadEnds=include`,
                `POST /api/sessions/${fullId}/messages`,
              ],
        );
        expect(cli.stdout(), cli.stderr()).not.toBe("");
        expect(JSON.parse(cli.stdout())).toMatchObject({
          version: 1,
          result: { _tag: "Turn", turn: { createdAt: "1970-01-01T00:00:00.000Z" } },
        });
        expect(cli.stderr()).toBe("");
      } finally {
        await fake.close();
      }
    },
  );

  it("sends literal --help after -- through the global flag gate", async () => {
    const inputs: Array<unknown> = [];
    const fake = await startFakeMend((request, response) => {
      if (request.method === "GET") json(response, { session: row });
      else {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => {
          body += chunk;
        });
        request.on("end", () => {
          inputs.push(JSON.parse(body));
          json(response, encodeReceipt(turnReceipt()));
        });
      }
    });
    try {
      const cli = startCli(fake.url, ["message", fullId, "--", "--help"]);
      await cli.closed;
      expect(await cli.exited).toEqual({ kind: "exit", code: 0 });
      expect(inputs).toEqual([{ input: "--help", clientMessageId: expect.any(String) }]);
      expect(cli.stdout()).toContain("sent as your next turn");
      expect(cli.stdout()).not.toContain("usage:");
    } finally {
      await fake.close();
    }
  });

  it("keeps unknown flags in the JSON error envelope before contacting the server", async () => {
    const cli = startCli("http://127.0.0.1:1", ["message", fullId, "--secret-input", "--json"]);
    await cli.closed;
    expect(await cli.exited).toEqual({ kind: "exit", code: 1 });
    expect(cli.stdout(), cli.stderr()).not.toBe("");
    expect(JSON.parse(cli.stdout())).toMatchObject({
      version: 1,
      error: { tag: "InvalidMessageArguments", clientMessageId: null },
    });
    expect(cli.stdout()).not.toContain("--secret-input");
    expect(cli.stderr()).toBe("");
  });

  it("reports a stopped session refusal without resume or a mode switch", async () => {
    const routes: Array<string> = [];
    const fake = await startFakeMend((request, response) => {
      const route = `${request.method} ${request.url}`;
      routes.push(route);
      if (request.method === "GET") json(response, { session: row });
      else {
        response.writeHead(409, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            _tag: "ProtocolSessionNotLive",
            sessionId: fullId,
            message: "This session has no live conversation; resume it first.",
          }),
        );
      }
    });
    try {
      const cli = startCli(fake.url, ["message", fullId, "next words", "--json"]);
      await cli.closed;
      expect(await cli.exited).toEqual({ kind: "exit", code: 1 });
      expect(cli.stdout(), cli.stderr()).not.toBe("");
      expect(JSON.parse(cli.stdout())).toMatchObject({
        version: 1,
        error: {
          tag: "ProtocolSessionNotLive",
          message: expect.stringContaining("resume it first"),
        },
      });
      expect(routes).toEqual([
        `GET /api/sessions/${fullId}`,
        `POST /api/sessions/${fullId}/messages`,
      ]);
    } finally {
      await fake.close();
    }
  });

  it("prints the line, exits 2 and names the request key on stderr when delivery is not confirmed", async () => {
    const fake = await startFakeMend((request, response) => {
      if (request.method === "GET") json(response, { session: row });
      else {
        request.resume();
        request.on("end", () => {
          json(response, encodeReceipt(steerReceipt({ _tag: "Unknown", reason: "restart" })));
        });
      }
    });
    try {
      const cli = startCli(fake.url, ["message", fullId, "next words"]);
      await cli.closed;
      expect(await cli.exited).toEqual({ kind: "exit", code: 2 });
      expect(cli.stdout()).toContain("delivery not confirmed · Mend will not resend");
      expect(cli.stderr()).toMatch(/^client message [0-9a-f-]{36} · check the session/);
    } finally {
      await fake.close();
    }
  });

  it.each([
    ["an error no code names (a bare 101)", "HTTP/1.1 101 Switching Protocols\r\n\r\n"],
    ["a header overflow", `HTTP/1.1 200 OK\r\nx-big: ${"a".repeat(65_536)}\r\n\r\n{}`],
    [
      "a corrupt gzip body",
      "HTTP/1.1 200 OK\r\ncontent-encoding: gzip\r\ncontent-length: 8\r\n\r\nnot gzip",
    ],
    ["a reply the HTTP parser rejects", "not http\r\n\r\n"],
  ])("exits 2 with the request key after %s, once the server has the POST", async (_, reply) => {
    const fake = await startFakeMend((request, response) => {
      if (request.method === "GET") json(response, { session: row });
      else {
        request.resume();
        request.on("end", () => request.socket.end(reply));
      }
    });
    try {
      const cli = startCli(fake.url, ["message", fullId, "next words", "--json"]);
      await cli.closed;
      expect(await cli.exited).toEqual({ kind: "exit", code: 2 });
      const printed = JSON.parse(cli.stdout());
      expect(printed).toMatchObject({
        version: 1,
        error: {
          tag: "MessageOutcomeUnconfirmed",
          clientMessageId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        },
      });
      expect(printed.error.message).not.toContain("cannot reach");
    } finally {
      await fake.close();
    }
  });

  it.each([307, 302])(
    "exits 2 with the request key when the server answers the POST with a %s to a closed port",
    async (status) => {
      const closed = createServer().listen(0, "127.0.0.1");
      await once(closed, "listening");
      const address = closed.address();
      if (address === null || typeof address === "string") throw new Error("no port");
      closed.close();
      await once(closed, "close");
      const fake = await startFakeMend((request, response) => {
        if (request.method === "GET") json(response, { session: row });
        else {
          request.resume();
          request.on("end", () => {
            response
              .writeHead(status, { location: `http://127.0.0.1:${address.port}/api/elsewhere` })
              .end();
          });
        }
      });
      try {
        const cli = startCli(fake.url, ["message", fullId, "next words", "--json"]);
        await cli.closed;
        expect(await cli.exited).toEqual({ kind: "exit", code: 2 });
        expect(JSON.parse(cli.stdout())).toMatchObject({
          version: 1,
          error: {
            tag: "MessageOutcomeUnconfirmed",
            clientMessageId: expect.stringMatching(/^[0-9a-f-]{36}$/),
          },
        });
      } finally {
        await fake.close();
      }
    },
  );

  it.each([
    [
      "a 400 with a corrupt gzip body",
      "HTTP/1.1 400 Bad Request\r\ncontent-encoding: gzip\r\ncontent-length: 8\r\n\r\nnot gzip",
    ],
    [
      "a 403 with a corrupt gzip body",
      "HTTP/1.1 403 Forbidden\r\ncontent-encoding: gzip\r\ncontent-length: 8\r\n\r\nnot gzip",
    ],
    [
      "a 409 with a corrupt gzip body",
      "HTTP/1.1 409 Conflict\r\ncontent-encoding: gzip\r\ncontent-length: 8\r\n\r\nnot gzip",
    ],
    [
      "a 413 with a corrupt gzip body",
      "HTTP/1.1 413 Payload Too Large\r\ncontent-encoding: gzip\r\ncontent-length: 8\r\n\r\nnot gzip",
    ],
    ["a truncated 400", "HTTP/1.1 400 Bad Request\r\ncontent-length: 50\r\n\r\n{}"],
  ])("exits 1 as a refusal after %s, once the server has the POST", async (_, reply) => {
    const fake = await startFakeMend((request, response) => {
      if (request.method === "GET") json(response, { session: row });
      else {
        request.resume();
        request.on("end", () => request.socket.end(reply));
      }
    });
    try {
      const cli = startCli(fake.url, ["message", fullId, "next words", "--json"]);
      await cli.closed;
      expect(await cli.exited).toEqual({ kind: "exit", code: 1 });
      const printed = JSON.parse(cli.stdout());
      expect(printed.error.tag).not.toBe("MessageOutcomeUnconfirmed");
      expect(printed.error.message).not.toContain("cannot reach");
    } finally {
      await fake.close();
    }
  });

  it("exits 1 with no request key when the POST's connection is refused", async () => {
    let fake: Awaited<ReturnType<typeof startFakeMend>> | undefined;
    fake = await startFakeMend((request, response) => {
      response.setHeader("connection", "close");
      json(response, { session: row });
      void fake?.close();
    });
    const cli = startCli(fake.url, ["message", fullId, "next words", "--json"]);
    await cli.closed;
    expect(await cli.exited).toEqual({ kind: "exit", code: 1 });
    expect(JSON.parse(cli.stdout())).toMatchObject({
      version: 1,
      error: { tag: "MessageNotSent", clientMessageId: null },
    });
  });

  it("reports an unreadable config inside the JSON envelope, after its own argument check", async () => {
    const config = fs.mkdtempSync(path.join(os.tmpdir(), "mend-message-config-"));
    try {
      fs.mkdirSync(path.join(config, "mend"));
      fs.writeFileSync(path.join(config, "mend", "cli.json"), "{ not json");
      const env = { XDG_CONFIG_HOME: config };
      const broken = startCli("http://127.0.0.1:1", ["message", fullId, "words", "--json"], env);
      const invalid = startCli("http://127.0.0.1:1", ["message", fullId, "--bad", "--json"], env);
      await Promise.all([broken.closed, invalid.closed]);
      expect(await broken.exited).toEqual({ kind: "exit", code: 1 });
      expect(JSON.parse(broken.stdout())).toMatchObject({
        version: 1,
        error: { tag: "CliConfigUnreadable", clientMessageId: null },
      });
      expect(broken.stderr()).toBe("");
      expect(await invalid.exited).toEqual({ kind: "exit", code: 1 });
      expect(JSON.parse(invalid.stdout())).toMatchObject({
        error: { tag: "InvalidMessageArguments" },
      });
    } finally {
      fs.rmSync(config, { recursive: true, force: true });
    }
  });

  it("completes a session after mend message in zsh and bash", async () => {
    const zsh = startCli("http://127.0.0.1:1", ["completions", "zsh"]);
    const bash = startCli("http://127.0.0.1:1", ["completions", "bash"]);
    await Promise.all([zsh.closed, bash.closed]);
    expect(zsh.stdout()).toContain("'message:send words to a session'");
    for (const script of [zsh.stdout(), bash.stdout()])
      expect(script).toMatch(/[|]message[|)][^\n]*\n(?:[^\n]*\n)?[^\n]*__complete session/);
    expect(bash.stdout()).toMatch(/compgen -W "[^"]* message [^"]*"/);
  });
});
