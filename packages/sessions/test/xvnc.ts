import { execFileSync } from "node:child_process";
import * as net from "node:net";
import { fileURLToPath } from "node:url";

import type { ForwardBytes, ForwardRead } from "@mend/sealant";
import { Effect } from "effect";

const IMAGE = "mend-hand-xvnc:local";
const CONTEXT = fileURLToPath(new URL("fixtures/rfb", import.meta.url));
export const XVNC_PASSWORD = "handpass";

export const dockerReady = (() => {
  try {
    execFileSync("docker", ["version"], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
})();

const docker = (...args: ReadonlyArray<string>) =>
  execFileSync("docker", [...args], { encoding: "utf8", timeout: 30_000 });

export interface Xvnc {
  readonly port: number;
  /** A shell command on the display, answering its output. */
  readonly x: (command: string) => string;
  /** A client on the display, left running. */
  readonly start: (...argv: ReadonlyArray<string>) => void;
  readonly remove: () => void;
}

/** TigerVNC Xvnc at 1280x800 with VncAuth, in a container called `name`, removed by that name. */
export const startXvnc = (name: string): Xvnc => {
  execFileSync("docker", ["build", "-q", "--target", "xvnc", "-t", IMAGE, CONTEXT], {
    stdio: "ignore",
    timeout: 600_000,
  });
  const xvnc = [
    `printf '%s\\n' ${XVNC_PASSWORD} | vncpasswd -f > /tmp/passwd`,
    "exec Xvnc :0 -geometry 1280x800 -depth 24 -SecurityTypes VncAuth -PasswordFile /tmp/passwd -rfbport 5900 -SendCutText=0 -nolisten tcp",
  ].join(" && ");
  docker("run", "-d", "--rm", "--name", name, "-p", "127.0.0.1::5900", IMAGE, "sh", "-c", xvnc);
  const remove = () => void execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
  try {
    const port = Number(docker("port", name, "5900").trim().split(":").at(-1));
    const x = (command: string) => docker("exec", "-e", "DISPLAY=:0", name, "sh", "-c", command);
    for (let tries = 0; ; tries++) {
      try {
        x("xdpyinfo >/dev/null");
        break;
      } catch (error) {
        if (tries > 50) throw error;
      }
    }
    return {
      port,
      x,
      start: (...argv) => void docker("exec", "-d", "-e", "DISPLAY=:0", name, ...argv),
      remove,
    };
  } catch (error) {
    remove();
    throw error;
  }
};

export interface Connection {
  readonly bytes: ForwardBytes;
  /** Every message written, in order. */
  readonly written: ReadonlyArray<Uint8Array>;
  /** Drops the connection under whoever holds it. */
  readonly cut: () => void;
}

/** One TCP connection as forward bytes, the way the forward adapter hands them over. */
export const connect = (port: number): Promise<Connection> =>
  new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    const chunks: Array<Uint8Array> = [];
    const readers: Array<(read: ForwardRead) => void> = [];
    const written: Array<Uint8Array> = [];
    let ended = false;
    const deliver = () => {
      for (;;) {
        const reader = readers[0];
        if (reader === undefined || (chunks.length === 0 && !ended)) return;
        readers.shift();
        const next = chunks.shift();
        reader(next === undefined ? { kind: "eof" } : { kind: "bytes", bytes: next });
      }
    };
    socket.on("data", (chunk) => {
      chunks.push(new Uint8Array(chunk));
      deliver();
    });
    socket.on("close", () => {
      ended = true;
      deliver();
    });
    socket.once("error", reject);
    socket.once("connect", () =>
      resolve({
        written,
        cut: () => socket.destroy(),
        bytes: {
          read: () =>
            Effect.callback<ForwardRead>((resume) => {
              readers.push((read) => resume(Effect.succeed(read)));
              deliver();
            }),
          write: (bytes) =>
            Effect.callback<void>((resume) => {
              written.push(bytes);
              socket.write(bytes, () => resume(Effect.void));
            }),
          finish: () => Effect.sync(() => void socket.end()),
          close: () => Effect.sync(() => void socket.destroy()),
        },
      }),
    );
  });
