// deploy/aws/tofu offers two control planes, the EKS cluster and the single instance, over one
// shared network, storage and MicroVM layer. Both stay defined. This holds the stack to that
// without OpenTofu: it reads the configuration as text.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = path.join(root, "deploy/aws/tofu");
const files = Object.fromEntries(
  readdirSync(directory)
    .filter((name) => name.endsWith(".tf"))
    .map((name) => [name, readFileSync(path.join(directory, name), "utf8")]),
);
const everything = Object.values(files).join("\n");

/** `resource "type" "name" { … }` blocks of a file, with their bodies. */
const resources = (source) =>
  [...source.matchAll(/^resource "([a-z_]+)" "([a-z_]+)" \{\n([\s\S]*?)^\}/gm)].map(
    ([, type, name, body]) => ({ type, name, body }),
  );

test("both control planes are defined, each behind its own setting", () => {
  assert.match(everything, /^variable "cluster_enabled" \{[\s\S]*?default\s+= true/m);
  assert.match(everything, /^variable "instance_enabled" \{[\s\S]*?default\s+= false/m);
  assert.match(everything, /^resource "aws_eks_cluster" "poc"/m, "the cluster must stay defined");
  assert.match(everything, /^resource "aws_instance" "control_plane"/m);
});

test("everything in the cluster's own files is gated, so turning it off removes all of it", () => {
  for (const file of ["eks.tf", "ebs-csi.tf"])
    for (const { type, name, body } of resources(files[file]))
      assert.match(
        body,
        /^\s+(count\s+= local\.cluster_count|for_each\s+= var\.cluster_enabled \?)/m,
        `${file}: ${type}.${name} is not gated by cluster_enabled`,
      );
});

test("a resource that gained a count has a move, so an existing cluster is not recreated", () => {
  const counted = Object.entries(files)
    .filter(([file]) => file !== "instance.tf")
    .flatMap(([, source]) => resources(source))
    .filter(({ body }) => /^\s+count\s+= local\.cluster_count/m.test(body));
  assert.ok(counted.length > 20, "expected the cluster's resources to be counted");
  for (const { type, name } of counted)
    assert.match(
      files["cluster.tf"],
      new RegExp(`from = ${type}\\.${name}\\n\\s+to\\s+= ${type}\\.${name}\\[0\\]`),
      `${type}.${name} has no moved block`,
    );
});

test("what both control planes share is never gated", () => {
  for (const file of ["network.tf", "storage.tf", "microvm.tf"])
    for (const { type, name, body } of resources(files[file])) {
      const clusterOnly =
        name.startsWith("eks") || (type.includes("ingress_rule") && name === "planetscale");
      if (!clusterOnly)
        assert.doesNotMatch(
          body,
          /cluster_count|instance_count|cluster_enabled|instance_enabled/,
          `${file}: ${type}.${name} is shared and must not depend on either control plane`,
        );
    }
});
