import assert from "node:assert/strict";
import test from "node:test";

import {
  chooseTidy,
  deployNeeds,
  describeTidy,
  MEASURED_DEPLOY_BYTES,
  parseListing,
  parseTidyRun,
  tidyScript,
} from "./box-tidy.mjs";

const GB = 1024 ** 3;
const id = (n) => `sha256:${String(n).padStart(64, "0")}`;
const hour = (h) => new Date(Date.parse("2026-11-16T00:00:00Z") + h * 3_600_000).toISOString();

// One image line as LIST_BOX prints it.
const image = (n, { tags = [], digests = [], at = 0, pulled = at, size = GB, labels = null }) =>
  `image=${id(n)}|${JSON.stringify(tags)}|${JSON.stringify(digests)}|${hour(at)}|${hour(pulled)}|${Math.trunc(size)}|${JSON.stringify(labels)}`;

const preview = (run, at, labels = {}) =>
  image(run, {
    tags: [`ghcr.io/sealant-sh/mend:0.37.0-next.1.preview.${run}`],
    at,
    size: 2.7 * GB,
    labels: {
      "org.opencontainers.image.revision": `${run}`.repeat(40).slice(0, 40),
      "dev.sealant.mend.network-guard-image": `busybox:1.37@${id(900)}`,
      ...labels,
    },
  });

// A box like VM 131 on 16 Nov: previews 211 to 225 with 225 running, a pinned guard and gateway,
// stale gateways, workspace images, an old and a new build cache record, and twelve dumps.
const boxListing = ({ running = 225, extra = [] } = {}) =>
  [
    "free=6000000000",
    `now=${hour(100).replace(/\.\d{3}Z$/, "Z")}`,
    ...[211, 212, 213, 214, 215, 216, 217, 218, 219, 220, 221, 222, 225].map((run) =>
      preview(run, run - 200, {
        "dev.sealant.mend.boat-gateway-image": `ghcr.io/g@${id(800 + (run >= 221 ? 1 : 0))}`,
      }),
    ),
    image(900, { digests: [`busybox@${id(900)}`], at: -1000, size: 7e6 }),
    image(800, { digests: [`ghcr.io/g@${id(800)}`], at: 5 }),
    image(801, { digests: [`ghcr.io/g@${id(801)}`], at: 20 }),
    image(802, { digests: [`ghcr.io/g@${id(802)}`], at: 1 }),
    image(700, { tags: ["sealant-workspace-ubuntu:plan-aaaa"], at: 2, size: 7 * GB }),
    image(701, {
      tags: ["sealant-workspace-ubuntu:plan-bbbb", "sealant-workspace-ubuntu:latest"],
      at: 30,
      size: 7.3 * GB,
    }),
    image(702, { digests: [`sealant-workspace-nix@${id(702)}`], at: 3 }),
    image(600, { tags: ["postgres:17-alpine"], at: -500 }),
    image(601, { digests: [`postgres@${id(601)}`], at: -400 }),
    `container=${id(running)}|/mend-mend-1|running`,
    `container=${id(600)}|/mend-postgres-1|running`,
    `container=${id(601)}|/sealres-1|exited`,
    `container=${id(701)}|/sealant-ws|running`,
    `cache=${JSON.stringify({
      BuildCache: [
        {
          ID: "old",
          Type: "regular",
          InUse: false,
          Shared: true,
          Size: 5 * GB,
          CreatedAt: hour(1),
          LastUsedAt: hour(2),
        },
        {
          ID: "oldbusy",
          Type: "regular",
          InUse: true,
          Shared: false,
          Size: GB,
          CreatedAt: hour(1),
          LastUsedAt: hour(2),
        },
        {
          ID: "frontend",
          Type: "frontend",
          InUse: false,
          Shared: false,
          Size: 1,
          CreatedAt: hour(1),
          LastUsedAt: null,
        },
        {
          ID: "fresh",
          Type: "regular",
          InUse: false,
          Shared: false,
          Size: GB,
          CreatedAt: hour(1),
          LastUsedAt: hour(90),
        },
      ],
    })}`,
    ...Array.from({ length: 12 }, (_, n) => {
      const at = Date.parse(hour(n * 5)) / 1000;
      return `dump=${at}.5|${(n + 1) * 1e8}|/root/backups/pre-${n}.sql`;
    }),
    ...extra,
  ].join("\n");

const hold = { tag: "pr1755", head: "9".repeat(40), at: hour(99), dump: "/root/backups/pre-0.sql" };
const refs = (choice) => choice.images.map((item) => item.ref);

test("the listing is read with what could not be read kept apart from empty", () => {
  const listing = parseListing(boxListing());
  assert.equal(listing.images.length, 22);
  assert.deepEqual(listing.images.find((item) => item.id === id(900)).tags, []);
  assert.equal(listing.cache.length, 4);
  assert.equal(listing.dumps.length, 12);
  const empty = parseListing("");
  assert.equal(empty.cache, null);
  assert.equal(empty.dumps, null);
  assert.equal(empty.free, null);
});

test("nothing is chosen without the caller's own hold", () => {
  const listing = parseListing(boxListing());
  for (const held of [null, { ...hold, tag: "pr1600" }, { unreadable: "{" }]) {
    const choice = chooseTidy({ listing, hold: held, tag: "pr1755" });
    assert.ok(choice.refused, JSON.stringify(held));
    assert.deepEqual([choice.images, choice.cache, choice.dumps], [[], [], []]);
    assert.match(describeTidy(choice), /^nothing removed/);
  }
  const blind = parseListing(boxListing().replace(/^container=.*$/gm, ""));
  assert.match(chooseTidy({ listing: blind, hold, tag: "pr1755" }).refused, /no containers/);
});

test("never the running image, never the newest three previews", () => {
  // The box runs an old preview, 214: it stays, and so do the newest three.
  const choice = chooseTidy({
    listing: parseListing(boxListing({ running: 214 })),
    hold,
    tag: "pr1755",
  });
  const removed = refs(choice);
  for (const run of [214, 221, 222, 225])
    assert.ok(!removed.some((ref) => ref.endsWith(`.preview.${run}`)), `preview ${run} kept`);
  for (const run of [211, 212, 213, 215, 216, 217, 218, 219, 220])
    assert.ok(
      removed.includes(`ghcr.io/sealant-sh/mend:0.37.0-next.1.preview.${run}`),
      `preview ${run} removed`,
    );
  assert.deepEqual(
    choice.kept.filter((item) => item.ref.endsWith(".preview.214")).map((item) => item.why),
    ["a container uses it"],
  );
});

test("never the image the hold's own deploy pulled or built from its head", () => {
  const listing = parseListing(boxListing());
  // Preview 216 was pulled after the hold was taken; preview 217 was built from the hold's head.
  listing.images.find((item) => item.id === id(216)).pulled = Date.parse(hour(99.5));
  listing.images.find((item) => item.id === id(217)).labels["org.opencontainers.image.revision"] =
    hold.head;
  const removed = refs(chooseTidy({ listing, hold, tag: "pr1755" }));
  assert.ok(!removed.some((ref) => /\.preview\.21[67]$/.test(ref)));
  assert.ok(removed.some((ref) => ref.endsWith(".preview.218")));
});

test("untagged images go only when no container uses them and no kept Mend image pins them", () => {
  const removed = refs(chooseTidy({ listing: parseListing(boxListing()), hold, tag: "pr1755" }));
  assert.ok(!removed.includes(id(900)), "the network guard the kept previews pin");
  assert.ok(!removed.includes(id(801)), "the gateway the kept previews pin");
  assert.ok(!removed.includes(id(601)), "the image a stopped container uses");
  assert.ok(removed.includes(id(800)), "a gateway only removed previews pinned");
  assert.ok(removed.includes(id(802)), "a gateway nothing pins");
});

test("workspace images and other tagged images are never chosen", () => {
  const removed = refs(chooseTidy({ listing: parseListing(boxListing()), hold, tag: "pr1755" }));
  assert.ok(!removed.some((ref) => ref.startsWith("sealant-workspace") || ref === id(702)));
  assert.ok(!removed.some((ref) => ref.startsWith("postgres") || ref === id(600)));
});

test("build cache unused for two days goes; in use, internal or fresh stays", () => {
  const choice = chooseTidy({ listing: parseListing(boxListing()), hold, tag: "pr1755" });
  assert.deepEqual(
    choice.cache.map((record) => record.id),
    ["old"],
  );
  assert.match(
    describeTidy(choice),
    /1 build cache records unused for 48 h \(5\.0 GiB, 5\.0 GiB of it shared/,
  );
});

test("dumps beyond the newest ten go, never the hold's own", () => {
  const choice = chooseTidy({ listing: parseListing(boxListing()), hold, tag: "pr1755" });
  // pre-0 and pre-1 are the two oldest; pre-0 is the hold's dump.
  assert.deepEqual(
    choice.dumps.map((dump) => dump.path),
    ["/root/backups/pre-1.sql"],
  );
  const evil = parseListing(boxListing({ extra: ["dump=1|1|/root/backups/x'; rm -rf ~; '.sql"] }));
  const paths = chooseTidy({ listing: evil, hold, tag: "pr1755" }).dumps.map((dump) => dump.path);
  assert.ok(!paths.some((path) => path.includes("'")), "a path the script cannot quote is skipped");
});

test("the removal script re-checks the hold and removes only what was chosen", () => {
  const choice = chooseTidy({ listing: parseListing(boxListing()), hold, tag: "pr1755" });
  const script = tidyScript(choice, "pr1755");
  assert.match(
    script,
    /grep -q '"tag":"pr1755"' \/var\/lib\/mend-box-check\/hold.json 2>\/dev\/null \|\| \{/,
  );
  assert.doesNotMatch(script, /system prune|image prune| -a\b|--all|rmi -f|image rm -f|rm -rf/);
  assert.equal(script.match(/docker image rm /g).length, choice.images.length);
  assert.match(script, /docker buildx prune --force --filter until=48h/);
  assert.throws(() => tidyScript(choice, "pr1; reboot"), /unexpected tag/);
});

test("the removal's output says what went, what failed, and free space before and after", () => {
  const listing = parseListing(boxListing());
  const run = parseTidyRun(
    [
      "before=6000000000",
      "removed=image|ghcr.io/sealant-sh/mend:0.37.0-next.1.preview.211",
      `failed=image|${id(802)}|Error response from daemon: conflict`,
      "pruned=Total: 5GB",
      `cacheafter=${JSON.stringify({ BuildCache: [{ ID: "fresh" }, { ID: "oldbusy" }, { ID: "frontend" }] })}`,
      "removed=dump|/root/backups/pre-1.sql",
      "after=21000000000",
    ].join("\n"),
    listing,
  );
  assert.equal(run.before, 6e9);
  assert.equal(run.after, 21e9);
  assert.deepEqual(run.removed.cache, ["old"]);
  assert.deepEqual(run.removed.dumps, ["/root/backups/pre-1.sql"]);
  assert.equal(run.failed[0].ref, id(802));
  assert.equal(
    parseTidyRun("refused=the hold is not pr1755's", listing).refused,
    "the hold is not pr1755's",
  );
});

test("one deploy needs the box's newest preview image, dump and workspace image", () => {
  const need = deployNeeds(parseListing(boxListing()));
  assert.equal(need.parts.image, Math.trunc(2.7 * GB));
  assert.equal(need.parts.dump, 12e8);
  assert.equal(need.parts.workspace, Math.trunc(7.3 * GB));
  assert.equal(need.bytes, need.parts.image + need.parts.dump + need.parts.workspace);
  assert.equal(deployNeeds(parseListing("")).bytes, MEASURED_DEPLOY_BYTES);
});
