import { type FixtureKind, serveFixture } from "./apps.ts";

const KINDS: ReadonlyArray<FixtureKind> = [
  "digest",
  "download",
  "sse",
  "websocket",
  "cookies",
  "all",
];

const kind = KINDS.find((candidate) => candidate === process.argv[2]);
if (kind === undefined) {
  process.stderr.write(`usage: serve.ts <${KINDS.join("|")}> [port]\n`);
  process.exit(2);
}
const fixture = await serveFixture(kind, Number(process.argv[3] ?? 0));
process.stdout.write(`${JSON.stringify({ port: fixture.port })}\n`);
process.once("SIGTERM", () => {
  void fixture.stop().then(() => process.exit(0));
});
