// deploy/aws/tofu offers two control planes, the EKS cluster and the single instance, over one
// shared network, storage and MicroVM layer. Both stay defined. This holds the stack to that
// with source migration checks and evaluated, plan-only OpenTofu configurations.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
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

// The root bundles Go's crypto/x509 looks for on Linux, in its order; it reads the first that exists.
const systemRoots = [
  "/etc/ssl/certs/ca-certificates.crt",
  "/etc/pki/tls/certs/ca-bundle.crt",
  "/etc/ssl/ca-bundle.pem",
  "/etc/pki/tls/cacert.pem",
  "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem",
  "/etc/ssl/cert.pem",
];

/**
 * The system roots plus the provider mirror's CA, written into `directory` for tofu's
 * SSL_CERT_FILE, or null (with a diagnostic) when either is missing. The mirror's CA is not in the
 * system trust store, so only the tofu processes given this bundle trust it.
 */
const mirrorRoots = (t, mirror, directory) => {
  const ca = process.env.CI_TOFU_PROVIDER_MIRROR_CA;
  const roots = systemRoots.find((file) => existsSync(file));
  const missing = !roots
    ? "no system root bundle"
    : !ca || !existsSync(ca)
      ? `no CA file at CI_TOFU_PROVIDER_MIRROR_CA (${ca ?? "unset"})`
      : null;
  if (missing) {
    t.diagnostic(`provider mirror ${mirror} not used: ${missing}; downloading from the registry`);
    return null;
  }
  const bundle = path.join(directory, "roots.pem");
  writeFileSync(bundle, `${readFileSync(roots, "utf8")}\n${readFileSync(ca, "utf8")}`);
  return bundle;
};

// Run the real inventory test with controlled CLI failures, without depending on an outage.
const withTofu = (source, check) => {
  const scratch = mkdtempSync(path.join(tmpdir(), "mend-tofu-init-"));
  try {
    const tool = path.join(scratch, "tofu.mjs");
    const cache = path.join(scratch, "plugin-cache");
    writeFileSync(tool, `#!${process.execPath}\n${source}`, { mode: 0o755 });
    const result = spawnSync(
      process.execPath,
      [
        "--test",
        "--test-reporter=tap",
        "--test-name-pattern=^OpenTofu plans",
        import.meta.filename,
      ],
      {
        env: {
          ...process.env,
          NODE_TEST_CONTEXT: undefined,
          MEND_TEST_TOFU_BINARY: tool,
          TF_PLUGIN_CACHE_DIR: cache,
          CI_TOFU_PROVIDER_MIRROR: "",
        },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    assert.ifError(result.error);
    check(result, cache);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};

test("an uncached AWS provider outage skips the inventory with a reason", () => {
  for (const error of [
    "Failed to install provider\n│ Error while installing hashicorp/aws v6.64.0: could not download checksum file from https://github.com/opentofu/terraform-provider-aws/releases/download/v6.64.0/terraform-provider-aws_6.64.0_SHA256SUMS: 504 Gateway Timeout",
    "Failed to query available provider packages\n│ Could not retrieve available versions for hashicorp/aws: dial tcp: lookup registry.opentofu.org: no such host",
    "Failed to install provider\n│ Error while installing hashicorp/aws: read tcp: connection reset by peer",
  ]) {
    withTofu(
      `console.error(${JSON.stringify(`╷\n│ Error: ${error}\n╵`)}); process.exit(1);`,
      (result) => {
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /# SKIP .*AWS provider unavailable/);
        assert.ok(result.stdout.includes(error.split(": ").at(-1)), result.stdout);
      },
    );
  }
});

test("provider checksum errors, invalid configuration and missing versions still fail", () => {
  for (const error of [
    "Failed to install provider: hashicorp/aws does not match any of the checksums recorded in the dependency lock file",
    "Invalid expression: Expected the start of an expression",
    "Failed to query available provider packages: hashicorp/aws locked version 6.64.0 does not match configured version constraint",
    "Failed to install provider: hashicorp/aws: 404 Not Found",
    "Failed to install provider: hashicorp/aws: 504 Gateway Timeout\nError: Invalid expression",
  ]) {
    withTofu(`console.error(${JSON.stringify(`Error: ${error}`)}); process.exit(1);`, (result) => {
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.doesNotMatch(result.stdout, /# SKIP/);
    });
  }
});

test("the inventory uses the plugin cache and still rejects a different evaluated plan", () => {
  withTofu(
    `import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
const cache = process.env.TF_PLUGIN_CACHE_DIR;
if (!cache || !path.isAbsolute(cache) || !existsSync(cache)) throw new Error("plugin cache missing");
if (process.argv[3] === "init") {
  writeFileSync(path.join(cache, "initialized"), "yes");
} else {
  for (const name of ["both_disabled", "cluster_only", "instance_only", "both_enabled"])
    console.log(JSON.stringify({ type: "test_plan", "@testrun": name, test_plan: {
      errored: false, planned_values: { root_module: { resources: [] } }
    } }));
  console.log(JSON.stringify({ type: "test_summary", test_summary: {
    status: "pass", passed: 4, failed: 0, errored: 0, skipped: 0
  } }));
}`,
    (result, cache) => {
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.equal(readFileSync(path.join(cache, "initialized"), "utf8"), "yes");
      assert.match(result.stdout, /both_disabled/);
      assert.doesNotMatch(result.stdout, /# SKIP/);
    },
  );
});

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
      // The test's HOME is disposable, but CI restores this shared cache by the lockfile hash.
      if (process.env.TF_PLUGIN_CACHE_DIR) {
        env.TF_PLUGIN_CACHE_DIR = path.resolve(process.env.TF_PLUGIN_CACHE_DIR);
        mkdirSync(env.TF_PLUGIN_CACHE_DIR, { recursive: true });
      }
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
      const init = ["init", "-input=false", "-backend=false", "-lockfile=readonly", "-no-color"];
      // Box runners name the host's read-only provider mirror here, so init does not download the
      // AWS provider (816 MB unpacked) on every run. The test writes its own CLI config for it,
      // never an inherited one, and trusts the mirror's CA only in its own tofu processes, through
      // SSL_CERT_FILE. OpenTofu checks a mirrored package against this lock file's hashes as it
      // does a download, so a planted package fails init. A mirror that cannot answer for this
      // lock falls back to the registry, through the same bundle's system roots.
      const mirror = process.env.CI_TOFU_PROVIDER_MIRROR;
      if (mirror)
        assert.match(
          mirror,
          /^https:\/\/[\w.:-]+\/$/,
          "CI_TOFU_PROVIDER_MIRROR must be https://host[:port]/",
        );
      const roots = mirror && mirrorRoots(t, mirror, scratch);
      let initialized;
      if (roots) {
        env.SSL_CERT_FILE = roots;
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
        initialized = run(init);
        // Down or unreachable: "failed to query provider mirror". Without this lock's version:
        // "the previously-selected version … is no longer available". A checksum mismatch fails.
        const unanswered =
          /failed to query provider mirror|previously-selected version \S+ is no longer available/;
        // The diagnostic wraps inside a box: compare its words, not its lines.
        const words = initialized.stderr.replace(/\x1b\[[\d;]*m/g, "").replace(/[\s│╷╵]+/g, " ");
        if (initialized.status !== 0 && unanswered.test(words)) {
          t.diagnostic(`provider mirror ${mirror} did not answer; downloading from the registry`);
          writeFileSync(cliConfig, "");
          initialized = run(init);
        }
      } else initialized = run(init);
      const diagnostic = `${initialized.stderr}\n${initialized.stdout}`
        .replace(/[\s│╷╵]+/g, " ")
        .trim();
      const errors = diagnostic.split(/\bError:\s*/).slice(1);
      // Only provider availability errors skip. Invalid config, incompatible locks, checksum
      // mismatches and every failure after init still fail the test. Check each error so a
      // network outage cannot hide another diagnostic in the same init result.
      const unavailable =
        errors.length > 0 &&
        errors.every(
          (error) =>
            /Failed to (install provider|query available provider packages)/.test(error) &&
            /hashicorp\/aws/.test(error) &&
            /\b50[0234]\b|connection (refused|reset)|no such host|i\/o timeout|context deadline exceeded|TLS handshake timeout|Client\.Timeout|network is unreachable|temporary failure in name resolution|unexpected EOF/i.test(
              error,
            ),
        );
      if (initialized.status !== 0 && unavailable) {
        t.skip(`AWS provider unavailable and not usable from the plugin cache: ${diagnostic}`);
        return;
      }
      assert.equal(
        initialized.status,
        0,
        `OpenTofu init must succeed: ${initialized.stderr}\n${initialized.stdout}`,
      );
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
