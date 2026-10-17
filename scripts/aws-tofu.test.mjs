// deploy/aws/tofu offers two control planes, the EKS cluster and the single instance, over one
// shared network, storage and MicroVM layer. Both stay defined. This holds the stack to that
// with source migration checks and evaluated, plan-only OpenTofu configurations.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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

// Independent deployment inventories, reviewed from the documented ownership of each resource.
// These do not use production count/for_each expressions or observed plan output as an oracle.
const countedCluster = [
  "aws_iam_role.eks",
  "aws_iam_role_policy_attachment.eks",
  "aws_cloudwatch_log_group.eks",
  "aws_eks_cluster.poc",
  "aws_iam_openid_connect_provider.eks",
  "aws_iam_role.node",
  "aws_launch_template.node",
  "aws_eks_node_group.poc",
  "aws_iam_role.cni",
  "aws_iam_role_policy_attachment.cni",
  "aws_eks_addon.vpc_cni",
  "aws_eks_addon.kube_proxy",
  "aws_eks_addon.coredns",
  "aws_iam_role.ebs_csi",
  "aws_iam_role_policy.ebs_csi",
  "aws_eks_addon.ebs_csi",
  "aws_security_group.eks_workload",
  "aws_vpc_security_group_ingress_rule.eks_internal",
  "aws_vpc_security_group_egress_rule.eks",
  "aws_vpc_security_group_ingress_rule.planetscale",
  "aws_iam_role_policy.mend_captures",
  "aws_iam_role_policy.sealant_api",
  "aws_iam_role_policy.sealant_worker",
  "aws_security_group.session_nlb",
  "aws_vpc_security_group_ingress_rule.session_nlb",
  "aws_vpc_security_group_egress_rule.session_nlb",
  "aws_vpc_security_group_ingress_rule.session_nodeport",
  "aws_lb.session",
  "aws_lb_target_group.session",
  "aws_lb_listener.session",
  "aws_autoscaling_attachment.session",
];
const clusterAddresses = [
  ...countedCluster.map((address) => `${address}[0]`),
  'aws_iam_role_policy_attachment.node["AmazonEKSWorkerNodePolicy"]',
  'aws_iam_role_policy_attachment.node["AmazonEC2ContainerRegistryPullOnly"]',
  'aws_iam_role.application["mend"]',
  'aws_iam_role.application["sealant_api"]',
  'aws_iam_role.application["sealant_worker"]',
];
const instanceAddresses = [
  "aws_iam_role.instance",
  "aws_iam_role_policy_attachment.instance_ssm",
  "aws_iam_role_policy.instance_captures",
  "aws_iam_role_policy.instance_microvm_control",
  "aws_iam_role_policy.instance_microvm_lifecycle",
  "aws_cloudwatch_log_group.instance_containers",
  "aws_iam_role_policy.instance_container_logs",
  "aws_iam_instance_profile.instance",
  "aws_security_group.instance",
  "aws_vpc_security_group_ingress_rule.instance_http",
  "aws_vpc_security_group_ingress_rule.instance_https",
  "aws_vpc_security_group_ingress_rule.instance_http3",
  "aws_vpc_security_group_ingress_rule.instance_workspace_ssh",
  "aws_vpc_security_group_ingress_rule.instance_session_channel",
  "aws_vpc_security_group_egress_rule.instance",
  "aws_vpc_security_group_ingress_rule.planetscale_from_instance",
  "aws_instance.control_plane",
  "aws_ebs_volume.instance_data",
  "aws_volume_attachment.instance_data",
  "aws_eip.instance",
  "aws_eip_association.instance",
  "aws_iam_role.dlm",
  "aws_iam_role_policy_attachment.dlm",
  "aws_dlm_lifecycle_policy.instance_data",
].map((address) => `${address}[0]`);
const sharedAddresses = [
  "aws_vpc.poc",
  "aws_default_security_group.poc",
  "aws_internet_gateway.poc",
  "aws_eip.nat",
  "aws_nat_gateway.poc",
  "aws_route_table.public",
  "aws_vpc_endpoint.s3",
  "aws_security_group.microvm",
  "aws_vpc_security_group_egress_rule.microvm",
  "aws_security_group.planetscale",
  "aws_vpc_endpoint.planetscale",
  ...[
    "aws_subnet.public",
    "aws_subnet.private",
    "aws_route_table.private",
    "aws_route_table_association.public",
    "aws_route_table_association.private",
  ].flatMap((address) => ["eu-central-1a", "eu-central-1b"].map((zone) => `${address}["${zone}"]`)),
  "aws_s3_bucket.captures",
  "aws_s3_bucket.artifacts",
  ...[
    "aws_s3_bucket_public_access_block.poc",
    "aws_s3_bucket_ownership_controls.poc",
    "aws_s3_bucket_server_side_encryption_configuration.poc",
    "aws_s3_bucket_lifecycle_configuration.poc",
    "aws_s3_bucket_policy.poc",
  ].flatMap((address) => ["captures", "artifacts"].map((bucket) => `${address}["${bucket}"]`)),
  "aws_ecr_repository.workspace",
  "aws_cloudwatch_log_group.microvm_build",
  "aws_cloudwatch_log_group.microvm_exec",
  "aws_iam_role.microvm_build",
  "aws_iam_role_policy.microvm_build",
  "aws_iam_role.microvm_exec",
  "aws_iam_role_policy.microvm_exec",
  "aws_iam_role.connector_operator",
  "aws_iam_role_policy.connector_operator",
  "aws_lambdacore_network_connector.vpc_egress",
  "aws_budgets_budget.poc",
];

test(
  "OpenTofu plans the exact independent resource inventory for all four control-plane settings",
  { timeout: 300_000 },
  (t) => {
    const moduleFiles = [
      "application.tf",
      "budget.tf",
      "cluster.tf",
      "ebs-csi.tf",
      "eks.tf",
      "instance.tf",
      "microvm.tf",
      "network.tf",
      "outputs.tf",
      "storage.tf",
      "variables.tf",
      "versions.tf",
    ];
    assert.deepEqual(
      Object.keys(files).toSorted(),
      moduleFiles.toSorted(),
      "Every module config file must be evaluated",
    );
    const scratch = mkdtempSync(path.join(tmpdir(), "mend-tofu-gates-"));
    try {
      const module = path.join(scratch, "module");
      mkdirSync(path.join(module, "tests"), { recursive: true });
      mkdirSync(path.join(scratch, "home"));
      const cliConfig = path.join(scratch, "cli.tfrc");
      writeFileSync(cliConfig, "");
      // Never copy ignored tfvars, state, provider credentials or an operator's local CLI config.
      for (const name of [...moduleFiles, ".terraform.lock.hcl", "instance-user-data.sh"])
        copyFileSync(path.join(directory, name), path.join(module, name));
      const fixture = readFileSync(
        path.join(root, "scripts/fixtures/aws-control-plane-gates.tftest.hcl"),
        "utf8",
      );
      const names = ["both_disabled", "cluster_only", "instance_only", "both_enabled"];
      assert.deepEqual(
        [...fixture.matchAll(/^run "([^"]+)"/gm)].map((match) => match[1]),
        names,
      );
      assert.equal(
        [...fixture.matchAll(/^\s+command = plan\s*$/gm)].length,
        4,
        "All fixture runs must be plan-only",
      );
      assert.match(fixture, /^mock_provider "aws" \{/m);
      writeFileSync(path.join(module, "tests/gates.tftest.hcl"), fixture);
      const env = {
        PATH: process.env.PATH,
        HOME: path.join(scratch, "home"),
        TMPDIR: scratch,
        TF_CLI_CONFIG_FILE: cliConfig,
        TF_IN_AUTOMATION: "1",
        AWS_EC2_METADATA_DISABLED: "true",
      };
      const tool = process.env.MEND_TEST_TOFU_BINARY ?? "tofu";
      const run = (args) => {
        const result = spawnSync(tool, [`-chdir=${module}`, ...args], {
          env,
          encoding: "utf8",
          timeout: 120_000,
          maxBuffer: 32 * 1024 * 1024,
          detached: true,
        });
        if (result.error && Number.isInteger(result.pid) && result.pid > 0) {
          try {
            process.kill(-result.pid, "SIGKILL");
          } catch (error) {
            if (error.code !== "ESRCH") {
              const cleanupFailure = new AggregateError(
                [result.error, error],
                "could not stop the owned OpenTofu process group",
                { cause: result.error },
              );
              throw cleanupFailure;
            }
          }
        }
        assert.ifError(result.error);
        assert.equal(result.signal, null);
        return result;
      };
      const execute = (args) => {
        const result = run(args);
        assert.equal(
          result.status,
          0,
          `OpenTofu ${args[0]} must succeed: ${result.stderr}\n${result.stdout}`,
        );
        return result.stdout;
      };
      const init = ["init", "-input=false", "-backend=false", "-lockfile=readonly"];
      // Box runners name the host's read-only provider mirror here, so init does not download the
      // AWS provider (816 MB unpacked) on every run. The test writes its own CLI config for it,
      // never an inherited one. OpenTofu checks a mirrored package against this lock file's hashes
      // as it does a download, so a planted package fails init. A mirror that cannot answer for
      // this lock falls back to the registry.
      const mirror = process.env.CI_TOFU_PROVIDER_MIRROR;
      if (mirror) {
        assert.match(
          mirror,
          /^https:\/\/[\w.:-]+\/$/,
          "CI_TOFU_PROVIDER_MIRROR must be https://host[:port]/",
        );
        writeFileSync(
          cliConfig,
          [
            "provider_installation {",
            "  network_mirror {",
            `    url     = "${mirror}"`,
            '    include = ["registry.opentofu.org/hashicorp/aws"]',
            "  }",
            '  direct { exclude = ["registry.opentofu.org/hashicorp/aws"] }',
            "}",
            "",
          ].join("\n"),
        );
        const mirrored = run(init);
        // Down or unreachable: "failed to query provider mirror". Without this lock's version:
        // "the previously-selected version … is no longer available". A checksum mismatch fails.
        const unanswered =
          /failed to query provider mirror|previously-selected version \S+ is no longer available/;
        // The diagnostic wraps inside a box: compare its words, not its lines.
        const words = mirrored.stderr.replace(/\x1b\[[\d;]*m/g, "").replace(/[\s│╷╵]+/g, " ");
        if (mirrored.status !== 0 && unanswered.test(words)) {
          t.diagnostic(`provider mirror ${mirror} did not answer; downloading from the registry`);
          writeFileSync(cliConfig, "");
          execute(init);
        } else
          assert.equal(
            mirrored.status,
            0,
            `OpenTofu init must succeed: ${mirrored.stderr}\n${mirrored.stdout}`,
          );
      } else execute(init);
      assert.equal(
        readFileSync(path.join(module, ".terraform.lock.hcl"), "utf8"),
        readFileSync(path.join(directory, ".terraform.lock.hcl"), "utf8"),
      );
      const output = execute(["test", "-filter=tests/gates.tftest.hcl", "-json", "-verbose"]);
      const records = output
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const plans = records.filter((record) => record.type === "test_plan");
      assert.deepEqual(
        plans.map((record) => record["@testrun"]),
        names,
        "Every combination must emit one actual plan",
      );
      assert.deepEqual(
        records
          .filter((record) => record.type === "test_summary")
          .map((record) => record.test_summary),
        [{ status: "pass", passed: 4, failed: 0, errored: 0, skipped: 0 }],
      );
      const expected = [
        sharedAddresses,
        [...sharedAddresses, ...clusterAddresses],
        [...sharedAddresses, ...instanceAddresses],
        [...sharedAddresses, ...clusterAddresses, ...instanceAddresses],
      ];
      plans.forEach((record, index) => {
        assert.equal(record.test_plan.errored, false);
        assert.deepEqual(
          record.test_plan.planned_values.root_module.child_modules ?? [],
          [],
          "The reviewed inventory contains no child modules",
        );
        const actual = record.test_plan.planned_values.root_module.resources
          .filter((resource) => resource.mode === "managed")
          .map((resource) => resource.address)
          .toSorted();
        assert.deepEqual(actual, expected[index].toSorted(), names[index]);
      });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);

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
