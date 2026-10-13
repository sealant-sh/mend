import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";

/** An owned loopback transport; unexpected public origins never reach the network. */
export const recordingRegistry = async (publicOrigin, respond) => {
  const requests = [];
  const server = createServer((request, response) => {
    const observed = {
      method: request.method,
      path: request.url,
      authorization: request.headers.authorization ?? null,
      accept: request.headers.accept ?? null,
    };
    requests.push(observed);
    respond(observed, response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no fixture address");
  return {
    requests,
    fetchImpl: (url, init) => {
      const requested = new URL(url);
      assert.equal(requested.origin, publicOrigin);
      assert.equal(requested.username, "");
      assert.equal(requested.password, "");
      return fetch(
        `http://127.0.0.1:${address.port}${requested.pathname}${requested.search}`,
        init,
      );
    },
    close: async () => {
      const closed = new Promise((resolve, reject) =>
        server.close((error) => {
          if (error !== undefined) {
            reject(error);
            return;
          }
          resolve();
        }),
      );
      server.closeAllConnections();
      await closed;
    },
  };
};
