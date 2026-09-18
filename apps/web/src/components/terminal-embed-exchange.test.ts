import { describe, expect, it } from "vitest";

import { EmbedTicketRefused, makeEmbedExchange } from "./terminal.tsx";

describe("the embed page's ticket chain", () => {
  it("spends the URL's ticket first, then shows the renewal it was handed, only ever in a body", async () => {
    const sent: Array<{ readonly url: string; readonly body: unknown }> = [];
    let round = 0;
    const send: typeof fetch = async (input, init) => {
      round += 1;
      sent.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return Response.json({
        ticket: `mut_socket_${round}`,
        renew: `mut_renew_${round}`,
        expiresInSeconds: 30,
      });
    };
    const exchange = makeEmbedExchange("mut_from_url", { process: "proc_1" }, send);
    expect(await exchange.next()).toBe("mut_socket_1");
    expect(await exchange.next()).toBe("mut_socket_2");
    expect(sent).toEqual([
      { url: "/api/upgrade-tickets/exchange", body: { ticket: "mut_from_url", process: "proc_1" } },
      { url: "/api/upgrade-tickets/exchange", body: { ticket: "mut_renew_1", process: "proc_1" } },
    ]);
  });

  it("fails the connect when the trade is refused, and keeps the ticket it had", async () => {
    let refuse = true;
    const bodies: Array<unknown> = [];
    const send: typeof fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      if (refuse) return new Response(null, { status: 401 });
      return Response.json({ ticket: "mut_socket", renew: "mut_renew", expiresInSeconds: 30 });
    };
    const exchange = makeEmbedExchange("mut_from_url", { session: "s1" }, send);
    await expect(exchange.next()).rejects.toBeInstanceOf(EmbedTicketRefused);
    refuse = false;
    expect(await exchange.next()).toBe("mut_socket");
    expect(bodies).toEqual([
      { ticket: "mut_from_url", session: "s1" },
      { ticket: "mut_from_url", session: "s1" },
    ]);
  });
});
