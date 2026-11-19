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
  // CI pulls the base through scripts/ci-images.mjs and names its local tag here (SLNT-1071).
  const base = process.env["MEND_TEST_RFB_XVNC_BASE"];
  const args = base === undefined ? [] : ["--build-arg", `XVNC_BASE=${base}`];
  execFileSync(
    "docker",
    ["build", "-q", ...args, "--target", target, "-t", IMAGES[target], CONTEXT],
    {
      stdio: "ignore",
      timeout: 600_000,
    },
  );
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

/**
 * Hands a container to Docker to kill and delete, and returns without waiting for it. A busy
 * daemon can take longer than a hook's budget to delete a container, and no test claims anything
 * about that wait (SLNT-1108, SLNT-1125). Detached, the removal outlives the worker that asked.
 */
export const removeContainer = (name: string): void =>
  spawn("docker", ["rm", "-f", name], { detached: true, stdio: "ignore" }).unref();

/** Reports the daemon's answer to a `docker run`, then removes the container once let go of. */
const RUN_THEN_REMOVE = [
  "trap '' PIPE",
  'name=$1; shift; said=$(docker run --name "$name" "$@" 2>&1 >/dev/null); status=$?',
  'printf "%s %s" "$status" "$said"; exec >&-',
  'cat >/dev/null; docker rm -f "$name" >/dev/null 2>&1',
].join("\n");

export interface RunningContainer {
  /** Settles once the daemon has answered the start, however long a busy one takes. */
  readonly started: Promise<void>;
  /** Removes the container after the daemon's answer, and returns without waiting for either. */
  readonly remove: () => void;
}

/**
 * `docker run --name name ...args`, from a shell that outlives the worker. The start waits for the
 * daemon's answer within the calling hook's budget, not on a clock of the client's own: a client
 * killed mid-start leaves the daemon making the container anyway, after a removal by name has
 * already found nothing (SLNT-1141). The shell removes the container once it has the answer and
 * `remove` is called or the worker has exited, so a container made late goes too.
 */
export const runContainer = (name: string, args: ReadonlyArray<string>): RunningContainer => {
  const shell = spawn("sh", ["-c", RUN_THEN_REMOVE, "sh", name, ...args], {
    detached: true,
    stdio: ["pipe", "pipe", "ignore"],
  });
  shell.unref();
  shell.stdin.on("error", () => {});
  const started = new Promise<void>((resolve, reject) => {
    let said = "";
    shell.stdout.setEncoding("utf8");
    shell.stdout.on("data", (chunk: string) => (said += chunk));
    shell.stdout.once("end", () => {
      const [status, ...message] = said.split(" ");
      if (status === "0") resolve();
      else
        reject(
          new Error(`docker run ${name} exited ${status || "unanswered"}: ${message.join(" ")}`),
        );
    });
  });
  return { started, remove: () => void shell.stdin.end() };
};

export interface Xvnc {
  readonly port: number;
  /** A shell command on the display, answering its output. */
  readonly x: (command: string) => string;
  /** A client on the display, left running. */
  readonly start: (...argv: ReadonlyArray<string>) => void;
  /** Writes new passwords over Xvnc's password file, through stdin, as a screen's script does. */
  readonly signWith: (full: string, viewOnly: string) => void;
  /** Hands the container to Docker to kill and delete, and returns without waiting for it. */
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
  const remove = () => removeContainer(name);
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
  // A write after socat exits (a refused sign-in) fails with EPIPE; the close reports the end.
  child.stdin.on("error", () => {});
  return connectionOver({
    onData: (deliver) => child.stdout.on("data", (chunk) => deliver(new Uint8Array(chunk))),
    onClose: (closed) => child.on("close", closed),
    write: (bytes, done) => void child.stdin.write(bytes, done),
    end: () => void child.stdin.end(),
    destroy: () => void child.kill(),
  });
};
