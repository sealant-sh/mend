import { execFileSync, spawn } from "node:child_process";
import * as net from "node:net";
import { fileURLToPath } from "node:url";

import type { ForwardBytes, ForwardRead } from "@mend/sealant";
import { Effect } from "effect";

const CONTEXT = fileURLToPath(new URL("fixtures/rfb", import.meta.url));
const IMAGES = { xvnc: "mend-hand-xvnc:local", screen: "mend-screen-script:local" } as const;
export const XVNC_PASSWORD = "handpass";

/** Builds a stage of the fixtures' Dockerfile, a cache hit once the global setup built it. */
export const fixtureImage = (target: keyof typeof IMAGES): string => {
  execFileSync("docker", ["build", "-q", "--target", target, "-t", IMAGES[target], CONTEXT], {
    stdio: "ignore",
    timeout: 600_000,
  });
  return IMAGES[target];
};

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
  /** Writes new passwords over Xvnc's password file, through stdin, as a screen's script does. */
  readonly signWith: (full: string, viewOnly: string) => void;
  readonly remove: () => void;
}

/** TigerVNC Xvnc at 1280x800 with VncAuth, in a container called `name`, removed by that name. */
export const startXvnc = (name: string): Xvnc => {
  const image = fixtureImage("xvnc");
  const xvnc = [
    `printf '%s\\n' ${XVNC_PASSWORD} | vncpasswd -f > /tmp/passwd`,
    "exec Xvnc :0 -geometry 1280x800 -depth 24 -SecurityTypes VncAuth -PasswordFile /tmp/passwd -rfbport 5900 -SendCutText=0 -nolisten tcp",
  ].join(" && ");
  docker("run", "-d", "--rm", "--name", name, "-p", "127.0.0.1::5900", image, "sh", "-c", xvnc);
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
      signWith: (full, viewOnly) =>
        void execFileSync(
          "docker",
          [
            "exec",
            "-i",
            name,
            "sh",
            "-c",
            "vncpasswd -f >/tmp/passwd.next && mv /tmp/passwd.next /tmp/passwd",
          ],
          { input: `${full}\n${viewOnly}\n`, timeout: 30_000 },
        ),
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

interface Pipe {
  readonly onData: (deliver: (chunk: Uint8Array) => void) => void;
  readonly onClose: (closed: () => void) => void;
  readonly write: (bytes: Uint8Array, done: () => void) => void;
  readonly end: () => void;
  readonly destroy: () => void;
}

const connectionOver = (pipe: Pipe): Connection => {
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
  pipe.onData((chunk) => {
    chunks.push(chunk);
    deliver();
  });
  pipe.onClose(() => {
    ended = true;
    deliver();
  });
  return {
    written,
    cut: pipe.destroy,
    bytes: {
      read: () =>
        Effect.callback<ForwardRead>((resume) => {
          readers.push((read) => resume(Effect.succeed(read)));
          deliver();
        }),
      write: (bytes) =>
        Effect.callback<void>((resume) => {
          written.push(bytes);
          pipe.write(bytes, () => resume(Effect.void));
        }),
      finish: () => Effect.sync(pipe.end),
      close: () => Effect.sync(pipe.destroy),
    },
  };
};

/** One TCP connection as forward bytes, the way the forward adapter hands them over. */
export const connect = (port: number): Promise<Connection> =>
  new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("error", reject);
    socket.once("connect", () =>
      resolve(
        connectionOver({
          onData: (deliver) => socket.on("data", (chunk) => deliver(new Uint8Array(chunk))),
          onClose: (closed) => socket.on("close", closed),
          write: (bytes, done) => void socket.write(bytes, done),
          end: () => void socket.end(),
          destroy: () => void socket.destroy(),
        }),
      ),
    );
  });

/** A connection to a port on a container's own loopback, through `socat` inside it. */
export const connectInside = (container: string, port: number): Connection => {
  const child = spawn("docker", [
    "exec",
    "-i",
    container,
    "socat",
    "STDIO",
    `TCP:127.0.0.1:${port}`,
  ]);
  return connectionOver({
    onData: (deliver) => child.stdout.on("data", (chunk) => deliver(new Uint8Array(chunk))),
    onClose: (closed) => child.on("close", closed),
    write: (bytes, done) => void child.stdin.write(bytes, done),
    end: () => void child.stdin.end(),
    destroy: () => void child.kill(),
  });
};
