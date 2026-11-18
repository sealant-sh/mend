import { createServer } from "node:net";

/** Reserve both ports together so the OS cannot choose the same port twice. */
export const choosePorts = async (overrides = []) => {
  const servers = [];
  try {
    const ports = [];
    for (const value of overrides) {
      const port = value === undefined ? 0 : Number(value);
      if (!Number.isInteger(port) || port < 0 || port > 65535 || value === "")
        throw new Error(`Invalid verify port: ${value}`);
      const server = createServer();
      servers.push(server);
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen({ port, host: "127.0.0.1" }, resolve);
      });
      ports.push(server.address().port);
    }
    return ports;
  } finally {
    await Promise.all(servers.map((server) => new Promise((done) => server.close(done))));
  }
};

/** Only the detached group this drive started, including Vite's descendants. */
export const stopDrive = async (child, ports = []) => {
  const signal = (name) => {
    try {
      process.kill(-child.pid, name);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  const closed =
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise((done) => child.once("close", done));
  signal("SIGTERM");
  const timer = setTimeout(() => signal("SIGKILL"), 5000);
  try {
    await closed;
    // The proxy can exit before its descendants; terminate anything still in its group.
    signal("SIGKILL");
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        await choosePorts(ports.map(String));
        break;
      } catch (error) {
        if (error.code !== "EADDRINUSE" || Date.now() >= deadline) throw error;
        await new Promise((done) => setTimeout(done, 20));
      }
    }
  } finally {
    clearTimeout(timer);
  }
};
