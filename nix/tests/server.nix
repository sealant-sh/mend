{
  pkgs,
  mendModule,
  mend,
}:
let
  inherit (pkgs) lib;
  version = (lib.importJSON ../../apps/cli/package.json).version;
  pins = lib.importJSON ../test-images.json;
  mendImage = "ghcr.io/sealant-sh/mend:${version}";
  images =
    assert lib.assertMsg (
      pins ? ${mendImage}
    ) "nix/test-images.json has no ${mendImage}; run nix/update-test-images.sh";
    lib.mapAttrsToList (_: pkgs.dockerTools.pullImage) pins;
in
pkgs.testers.runNixOSTest {
  name = "mend-server";

  nodes.machine = {
    imports = [ mendModule ];
    virtualisation = {
      memorySize = 6144;
      cores = 4;
      diskSize = 16384;
    };
    services.mend = {
      enable = true;
      url = "https://mend.test";
      edge.enable = true;
      t3Gateway = {
        enable = true;
        host = "t3.mend.test";
      };
      sessions.runtime = "docker";
    };
    systemd.services.mend.wantedBy = lib.mkForce [ ];
    specialisation.public.configuration.services.mend.exposure = "public";
    environment.systemPackages = [
      mend
      pkgs.curl
      pkgs.jq
    ];
  };

  testScript = ''
    import hashlib
    import hmac
    import json
    import time

    origin = "http://127.0.0.1:3105"
    tunnel = "http://localhost:3105"
    gateway = "http://127.0.0.1:3120"

    def mend_cli(args, token=None):
        auth = f"MEND_TOKEN={token} " if token else ""
        return machine.succeed(f"MEND_URL={origin} {auth}mend {args}")

    def health():
        return json.loads(machine.succeed(f"curl --fail --silent {origin}/api/health"))

    def mend_environment():
        return json.loads(machine.succeed("docker inspect --format '{{json .Config.Env}}' mend-mend-1"))

    def edge_containers():
        return machine.succeed(
            "docker ps --quiet --filter label=com.docker.compose.project=mend"
            " --filter label=com.docker.compose.service=edge"
        ).strip()

    machine.wait_for_unit("docker.service")
    started = time.monotonic()
    for archive in ${builtins.toJSON (map toString images)}:
        machine.succeed(f"docker load --input {archive}")
    print(f"images loaded in {time.monotonic() - started:.0f}s")

    def switch(specialisation=None):
        to = f"specialisation/{specialisation}/" if specialisation else ""
        machine.succeed(f"/run/booted-system/{to}bin/switch-to-configuration test")

    switch("public")
    started = time.monotonic()
    machine.fail("systemctl start mend.service")
    print(f"mend.service as public on a fresh install failed in {time.monotonic() - started:.0f}s")
    print(machine.succeed("journalctl -u mend.service | grep -A2 'ExposureRefused'"))
    switch()

    started = time.monotonic()
    machine.succeed("systemctl start mend.service")
    print(f"mend.service started in {time.monotonic() - started:.0f}s")

    first = health()
    print(f"health: {first}")
    assert first["status"] == "ok", f"health status is {first['status']}"
    assert first["version"] == "${version}", f"health version is {first['version']}"
    identity = dict(
        line.split("=", 1) for line in machine.succeed("cat /var/lib/mend/identity.env").splitlines()
    )
    expected_instance = hmac.new(
        identity["BETTER_AUTH_SECRET"].encode(), b"mend instance id", hashlib.sha256
    ).hexdigest()[:32]
    assert first["instance"] == expected_instance, f"health instance {first['instance']} is not this identity's"
    identity_before = machine.succeed("sha256sum /var/lib/mend/identity.env")
    assert machine.succeed("stat -c %a /var/lib/mend/identity.env").strip() == "600"
    assert machine.succeed("stat -c %a /run/mend/server.env").strip() == "600"

    running = machine.succeed("docker ps --format '{{.Label \"com.docker.compose.service\"}}' | sort").split()
    print(f"running services: {running}")
    for service in ["docker-mirror", "garage", "mend", "npm-mirror", "postgres"]:
        assert service in running, f"{service} is not running: {running}"
    assert edge_containers() == "", "the edge runs before the first account exists"

    environment = mend_environment()
    for variable in [
        "MEND_SESSION_RUNTIME=docker",
        "MEND_T3_GATEWAY_ENABLED=true",
        "MEND_T3_GATEWAY_PUBLISHED=127.0.0.1:3120",
        "MEND_T3_GATEWAY_URL=https://t3.mend.test",
    ]:
        assert variable in environment, f"the Mend container's environment has no {variable}"
    published = machine.succeed("docker port mend-mend-1 3120/tcp").strip()
    assert published == "127.0.0.1:3120", f"the gateway's port is published on {published}"
    machine.wait_until_succeeds(f"curl --fail --silent {gateway}/.well-known/t3/environment", timeout=60)
    print(f"t3code gateway: {machine.succeed(f'curl --fail --silent {gateway}/.well-known/t3/environment')}")
    machine.succeed("journalctl -u mend.service | grep -q 'the edge stays down until the first account exists'")

    version_output = mend_cli("version")
    print(version_output)
    assert "server ${version}" in version_output, "mend version did not read the server's version"

    instance = json.loads(machine.succeed(f"curl --fail --silent {origin}/api/instance"))
    assert instance["users"] == "none", f"a fresh install has users {instance['users']}"
    assert tunnel in machine.succeed("grep ^MEND_ALLOWED_ORIGINS= /run/mend/server.env"), "the tunnel's origin is not allowed before the first account"
    signup = json.loads(machine.succeed(
        f"curl --fail --silent -X POST {origin}/api/auth/sign-up/email"
        f" -H 'content-type: application/json' -H 'origin: {tunnel}'"
        """ -d '{"email":"owner@mend.test","name":"Owner","password":"a-long-test-password-1234"}'"""
    ))
    session = signup["token"]
    print(f"first account, signed up from the tunnel's origin: {signup['user']['email']}")
    device = json.loads(machine.succeed(
        f"curl --fail --silent -X POST {origin}/api/me/devices"
        f" -H 'content-type: application/json' -H 'authorization: Bearer {session}'"
        """ -d '{"name":"nixos-test","platform":"other"}'"""
    ))
    token = device["token"]
    print(f"device token for device {device['device']['id']}")

    members = mend_cli("members", token)
    print(members)
    assert "owner@mend.test" in members, "mend members does not list the first account"

    _, doctor = machine.execute(f"MEND_URL={origin} MEND_TOKEN={token} mend doctor 2>&1")
    print(doctor)
    gateway_line = next((line for line in doctor.splitlines() if "t3code gateway" in line), "")
    assert "https://t3.mend.test" in gateway_line, "mend doctor does not show the t3code gateway's address"
    _, exposure = machine.execute(f"MEND_URL={origin} MEND_TOKEN={token} mend operator exposure 2>&1")
    print(exposure)
    assert "t3code-gateway" in exposure, "the exposure report does not list t3code-gateway"

    started = time.monotonic()
    machine.succeed("systemctl restart mend.service")
    print(f"mend.service restarted in {time.monotonic() - started:.0f}s")
    assert edge_containers() != "", "the edge is not running once the first account exists"
    site = machine.succeed("docker exec mend-edge-1 caddy adapt --config /etc/caddy/Caddyfile 2>/dev/null")
    assert "t3.mend.test" in site, "the edge does not serve the gateway's host"
    machine.succeed("docker exec mend-edge-1 wget -q -O /dev/null http://mend:3120/.well-known/t3/environment")
    print("the edge serves t3.mend.test and reaches the gateway on the edge network")
    assert tunnel not in machine.succeed("grep ^MEND_ALLOWED_ORIGINS= /run/mend/server.env"), "the tunnel's origin is still allowed after the first account"
    machine.succeed("journalctl -u mend.service | grep -q 'no longer allows http://localhost:3105'")
    assert mend_cli("members", token) == members, "the CLI's session did not survive the restart"
    second = health()
    print(f"health after restart: {second}")
    assert second["status"] == "ok", f"health status after restart is {second['status']}"
    assert second["instance"] == first["instance"], "the instance changed across the restart"
    assert machine.succeed("sha256sum /var/lib/mend/identity.env") == identity_before, "the identity changed"
    assert edge_containers() != "", "the edge is not running after a restart"

    started = time.monotonic()
    machine.succeed("systemctl restart mend.service")
    print(f"mend.service restarted again in {time.monotonic() - started:.0f}s")
    assert health()["instance"] == first["instance"], "the instance changed across the second restart"
    assert edge_containers() != "", "the edge is not running after the second restart"
    assert tunnel not in machine.succeed("grep ^MEND_ALLOWED_ORIGINS= /run/mend/server.env"), "the tunnel's origin came back"
    print(machine.succeed("journalctl -u mend.service | grep 'mend:'"))
  '';
}
