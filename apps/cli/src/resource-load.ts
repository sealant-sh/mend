import { spawn } from "node:child_process";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import * as http from "node:http";
import * as https from "node:https";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  dumpFormat,
  loadBytes,
  loadIsLive,
  parsePullUrl,
  ResourceLoadAnswer,
  scrubLoadMessage,
} from "@mend/domain/workbench";
import { Redacted, Schema } from "effect";

import type { ApiCall } from "./pair.ts";

/** The raw upload is separate from JSON calls so a dump never becomes a string or an ArrayBuffer. */
export type ResourceLoadUpload = (route: string, body: AsyncIterable<Uint8Array>) => Promise<void>;

/** Passwords reach pg_dump only as PGPASSWORD. A failed process never prints its stderr. */
export const localDumpPlan = (raw: string) => {
  const parsed = parsePullUrl(Redacted.make(raw));
  if (!parsed.ok) return parsed;
  return {
    ok: true as const,
    label: parsed.value.label,
    argv: ["--format=custom", "--no-owner", "--no-acl", `--dbname=${parsed.value.connection}`],
    password: parsed.value.password,
  };
};

/** Only five bytes are read to detect pg_dump's custom header; the file itself stays streamed. */
export const fileLoadSource = async (path: string) => {
  const info = await stat(path);
  if (!info.isFile()) throw new Error("the load source must be a regular file");
  const file = await open(path, "r");
  try {
    const prefix = new Uint8Array(5);
    await file.read(prefix, 0, 5, 0);
    return {
      label: scrubLoadMessage(basename(path)),
      bytesTotal: info.size,
      format: dumpFormat(prefix),
    };
  } finally {
    await file.close();
  }
};

/** HTTP backpressure carries the same chunk stream from disk or pg_dump to Mend. */
export const resourceLoadUpload =
  (config: { readonly url: string; readonly token: string | null }): ResourceLoadUpload =>
  async (route, body) => {
    const url = new URL(`${config.url}/api${route}`);
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request(url, {
      method: "PUT",
      headers: {
        "content-type": "application/octet-stream",
        ...(config.token === null ? {} : { authorization: `Bearer ${config.token}` }),
      },
    });
    const response = new Promise<void>((resolve, reject) => {
      request.once("error", () => reject(new Error("the dump upload connection ended")));
      request.once("response", (reply) => {
        reply.resume();
        reply.once("end", () => {
          if (reply.statusCode === 200) {
            resolve();
            return;
          }
          reject(new Error(`the dump upload was refused (${reply.statusCode ?? 0})`));
        });
        reply.once("error", () => reject(new Error("the dump upload response ended")));
      });
    });
    try {
      await Promise.all([pipeline(Readable.from(body), request), response]);
    } catch {
      request.destroy();
      throw new Error("the dump upload did not finish; read the resource's load status");
    }
  };

const decodeAnswer = Schema.decodeUnknownSync(ResourceLoadAnswer);

/** Runs the public CLI load, prints bytes while sending and the server's phases until terminal. */
export const runResourceLoad = async (input: {
  readonly api: ApiCall;
  readonly upload: ResourceLoadUpload;
  readonly base: string;
  readonly name: string;
  readonly worktreeId: string | null;
  readonly target: "shared" | "own" | null;
  readonly from: string | null;
  readonly pull: string | null;
  readonly say: (line: string) => void;
}) => {
  const { from, pull, api, base, say } = input;
  if ((from === null) === (pull === null))
    throw new Error("choose --from <file|postgres-url> or --pull <postgres-url>");
  const dump = from !== null && /^postgres(?:ql)?:/i.test(from) ? localDumpPlan(from) : null;
  if (dump !== null && !dump.ok) throw new Error(dump.message);
  const file =
    from !== null && dump === null
      ? await fileLoadSource(from).catch(() => {
          throw new Error("the dump file could not be read");
        })
      : null;
  const source =
    pull !== null
      ? { kind: "pull", url: pull }
      : {
          kind: "upload",
          label: dump?.ok === true ? dump.label : (file?.label ?? "dump"),
          bytesTotal: file?.bytesTotal ?? null,
        };
  let row = decodeAnswer(
    await api("POST", base, {
      name: input.name,
      worktreeId: input.worktreeId,
      target: input.target,
      source,
    }),
  );
  say(row.statusLine);
  const route = `${base.split("?")[0]}/${encodeURIComponent(row.id)}?${base.split("?")[1] ?? "timeZone=UTC"}`;
  if (pull === null) {
    const child =
      dump?.ok === true
        ? spawn("pg_dump", dump.argv, {
            env: { ...process.env, PGPASSWORD: Redacted.value(dump.password) },
            stdio: ["ignore", "pipe", "ignore"],
          })
        : null;
    const exit =
      child === null
        ? null
        : once(child, "close").then(
            ([code]) => {
              if (code !== 0) throw new Error("pg_dump failed here; the database was not changed");
              return;
            },
            () => {
              throw new Error(
                "pg_dump could not start here; install postgresql-client or use --pull",
              );
            },
          );
    // Observe rejection immediately even when it happens while HTTP is still opening.
    void exit?.catch(() => {});
    const bytes: AsyncIterable<Uint8Array> =
      child === null && from !== null
        ? createReadStream(from)
        : (child?.stdout ?? Readable.from([]));
    const counting = async function* () {
      let done = 0;
      let last = 0;
      for await (const chunk of bytes) {
        done += chunk.length;
        if (Date.now() - last >= 1000) {
          last = Date.now();
          say(
            `@${input.name} · loading ${source.kind === "upload" ? source.label : "dump"} · receiving ${loadBytes(done)}${file === null ? "" : ` of ${loadBytes(file.bytesTotal)}`}`,
          );
        }
        yield chunk;
      }
      if (exit !== null) await exit;
    };
    try {
      await input.upload(route.replace("?", "/body?"), counting());
    } finally {
      child?.kill();
    }
  }
  while (loadIsLive(row.phase)) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    row = decodeAnswer(await api("GET", route));
    say(row.statusLine);
  }
  if (row.phase === "failed") throw new Error(row.statusLine);
};
