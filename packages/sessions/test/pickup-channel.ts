import { spawn } from "node:child_process";
import * as http from "node:http";
import { gzipSync } from "node:zlib";

import { Effect } from "effect";

import {
  makePickupTickets,
  pickupAnswerOf,
  type PickupBinding,
  type PickupFile,
  type PickupTickets,
} from "../src/pickup-tickets.ts";
import { handleSessionRequest } from "../src/session-channel.ts";
import type { SessionSocketApi } from "../src/session-socket.ts";

/**
 * A session channel that serves pickups and nothing else, over loopback HTTP, through the real
 * route table (`handleSessionRequest`): what an exec in a workspace reaches with the env the
 * launch gives it. Every request body the channel received is kept, so a test can show what
 * crossed the wire.
 */
export interface PickupChannel {
  /** The env an exec needs to reach the channel. */
  readonly env: Record<string, string>;
  readonly tickets: PickupTickets;
  /** A ticket for `files`, bound as a launch binds one. */
  readonly mint: (files: ReadonlyArray<PickupFile>) => string;
  /** How many redemptions arrived, answered or refused. */
  readonly redemptions: () => number;
  readonly close: () => Promise<void>;
}

const notHere = () => Effect.die("not in this channel");

export const BINDING: PickupBinding = {
  purpose: "secret-files",
  sessionId: "sess-pickup",
  worktreeId: "wt-pickup",
  personId: "user-pickup",
  launchId: null,
};

export const startPickupChannel = async (
  options: {
    /** Runs when a redemption arrives, before it is answered (a test can move things then). */
    readonly beforeAnswer?: () => void;
    /** How many redemptions to answer as a busy channel first, the ticket left untaken. */
    readonly failFirst?: number;
  } = {},
): Promise<PickupChannel> => {
  const tickets = makePickupTickets();
  let redemptions = 0;
  const api: SessionSocketApi = {
    recipes: notHere,
    listServices: notHere,
    runServiceRecipe: notHere,
    runService: notHere,
    addService: notHere,
    stopService: notHere,
    restartService: notHere,
    stopSession: notHere,
    land: notHere,
    listRepositories: notHere,
    addableProjects: notHere,
    addRepository: notHere,
    gitTransport: notHere,
    gitTransportDone: notHere,
    pickup: (ticket) =>
      Effect.suspend(() => {
        redemptions += 1;
        if (redemptions <= (options.failFirst ?? 0)) {
          return Effect.fail(new Error("session channel: this request could not be answered now"));
        }
        options.beforeAnswer?.();
        const taken = tickets.take(ticket);
        if (taken.kind === "taken") return Effect.succeed(pickupAnswerOf(taken.entry.files));
        return Effect.fail(
          new Error(
            taken.kind === "spent"
              ? "this pickup ticket was already redeemed, perhaps through another channel"
              : "this pickup ticket is spent, expired or unknown",
          ),
        );
      }),
  };
  const server = http.createServer((request, response) => {
    void handleSessionRequest(api, request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    env: {
      MEND_SESSION_ENDPOINT: `http://127.0.0.1:${port}`,
      MEND_SESSION_ID: BINDING.sessionId,
      MEND_SESSION_TOKEN: "pickup-channel-test-token-0123456789",
    },
    tickets,
    mint: (files) => tickets.mint(BINDING, files),
    redemptions: () => redemptions,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
};

/** Run one exec as the platform would, without blocking the channel this process serves. */
export const runExec = (
  argv: ReadonlyArray<string>,
  env: Record<string, string>,
): Promise<{ readonly status: number | null; readonly stdout: string; readonly stderr: string }> =>
  new Promise((resolve, reject) => {
    const [command, ...args] = argv;
    const child = spawn(command ?? "sh", args, { env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });

/**
 * Every way a file's bytes could show in an argv: as they are (text files), and in base64, whole
 * or from any of the three offsets base64 can start a run at, and gzipped then base64.
 */
export const secretForms = (bytes: Uint8Array): ReadonlyArray<string> => {
  const buffer = Buffer.from(bytes);
  const forms = [0, 1, 2].map((offset) =>
    buffer
      .subarray(offset)
      .toString("base64")
      .slice(4, 4 + 24),
  );
  // The gzip-then-base64 the workspace file writer used (`writeFilesExecs`), past its header.
  const gzipped = gzipSync(buffer, { level: 9 }).toString("base64").slice(16, 40);
  const text = buffer.toString("utf8");
  return [...forms, gzipped, ...(text.length >= 8 ? [text.slice(0, 32)] : [])].filter(
    (form) => form.length >= 8,
  );
};
