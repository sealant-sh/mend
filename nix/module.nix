{ deployDir, defaultVersion }:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.mend;
  inherit (lib)
    mkOption
    mkEnableOption
    mkIf
    types
    ;

  declarable = [
    "core-private"
    "edge-tls"
    "workspace-ssh"
    "t3code-gateway"
    "preview-gateway"
  ];

  isLoopback = address: address == "::1" || lib.hasPrefix "127." address;
  isIPv6 = lib.hasInfix ":";
  composeHost = address: if isIPv6 address then "[${address}]" else address;
  connectHost =
    address:
    if address == "0.0.0.0" then
      "127.0.0.1"
    else if address == "::" then
      "[::1]"
    else
      composeHost address;
  isAddress =
    address:
    builtins.match "[0-9]{1,3}(\\.[0-9]{1,3}){3}" address != null
    || builtins.match "[0-9a-fA-F:.]*:[0-9a-fA-F:.]*" address != null;

  origin = builtins.match "(https?)://([^/?#@]+)" cfg.url;
  urlHostname =
    let
      authority = lib.elemAt origin 1;
    in
    if origin == null then
      ""
    else if lib.hasPrefix "[" authority then
      lib.head (lib.splitString "]" (lib.removePrefix "[" authority))
    else
      lib.toLower (lib.head (lib.splitString ":" authority));

  sshBind = if cfg.ssh.bindHost == cfg.bind.host then null else cfg.ssh.bindHost;
  sshReach = if sshBind == null then cfg.bind.host else sshBind;
  edge = cfg.edge.enable;
  mirrorsOn = cfg.mirrors.npm.enable || cfg.mirrors.docker.enable;
  isDnsName =
    name:
    builtins.match "([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?" name
    != null
    && !isAddress name;

  # Where the t3code gateway is published and what T3 Code's Remote link takes, as
  # `mend server setup --t3-gateway` places it (t3GatewayPlacement in apps/cli/src/server-edge.ts).
  t3 =
    let
      inherit (cfg.t3Gateway) bindHost port host;
      published = "${composeHost bindHost}:${toString port}";
      probe = "http://${connectHost bindHost}:${toString port}";
      namedHost = if urlHostname == "" then connectHost bindHost else composeHost urlHostname;
    in
    if !cfg.t3Gateway.enable then
      null
    else
      {
        inherit
          bindHost
          port
          published
          probe
          ;
        edgeHost = host;
        url =
          if host != null then
            "https://${host}"
          else if isLoopback bindHost then
            probe
          else
            "http://${namedHost}:${toString port}";
      };
  t3Volume = "mend-t3-gateway";

  gate = cfg.tenancy == "multi" || cfg.exposure == "public";
  postureEnvironment =
    lib.optionalAttrs (cfg.exposure != null) { MEND_EXPOSURE = cfg.exposure; }
    // lib.optionalAttrs (cfg.tenancy != null) { MEND_TENANCY = cfg.tenancy; }
    // lib.optionalAttrs gate {
      MEND_SOURCE_POLICY = "tenant";
      MEND_CAPTURE_REQUIRE_SIZES = "true";
    }
    // lib.optionalAttrs (cfg.exposure == "public") { MEND_URL_BEARERS = "refuse"; }
    // lib.optionalAttrs (sshBind != null) {
      MEND_SSH_PUBLISHED = "${composeHost sshBind}:${toString cfg.ssh.port}";
    }
    // lib.optionalAttrs (cfg.declared != [ ]) {
      MEND_EXPOSURE_DECLARED = lib.concatStringsSep "," cfg.declared;
    }
    // lib.optionalAttrs (cfg.sessions.runtime != null) { MEND_SESSION_RUNTIME = cfg.sessions.runtime; }
    // lib.optionalAttrs (cfg.sessions.runtimes != null) {
      MEND_SESSION_RUNTIMES = lib.concatStringsSep "," cfg.sessions.runtimes;
    }
    // lib.optionalAttrs (t3 != null) {
      MEND_T3_GATEWAY_ENABLED = "true";
      MEND_T3_GATEWAY_PUBLISHED = t3.published;
      MEND_T3_GATEWAY_URL = t3.url;
    };
  mendEnvironment = postureEnvironment // cfg.environment;

  # Compose interpolates $ in every value it reads from a file.
  escapeCompose = lib.replaceStrings [ "$" ] [ "$$" ];

  mirrorCuts =
    lib.optionals (!cfg.mirrors.npm.enable) [
      "del(.services.mend.environment.MEND_NPM_MIRROR_URL)"
      ''del(.services["npm-mirror"])''
      ''del(.volumes["mend-npm-mirror"])''
    ]
    ++ lib.optionals (!cfg.mirrors.docker.enable) [
      "del(.services.mend.environment.SEALANT_DOCKER_REGISTRY_MIRRORS)"
      "del(.services.mend.environment.SEALANT_DOCKER_REGISTRY_MIRROR_CONTAINER)"
      ''del(.services["docker-mirror"])''
      ''del(.volumes["mend-docker-mirror"])''
    ];
  composeDir =
    if mirrorsOn && mirrorCuts != [ ] then
      pkgs.runCommand "mend-compose" { nativeBuildInputs = [ pkgs.yq-go ]; } ''
        cp -r ${deployDir} $out
        chmod -R u+w $out
        yq -i ${lib.escapeShellArg (lib.concatStringsSep " | " mirrorCuts)} $out/compose.mirrors.yaml
      ''
    else
      deployDir;

  # The same services, ports and volumes as setup's compose.t3.yaml (renderT3GatewayOverlay).
  t3Overlay = lib.optionalAttrs (t3 != null) {
    services = {
      mend = {
        ports = [ "${t3.published}:3120" ];
        volumes = [ "${t3Volume}:/opt/mend-t3-gateway/state" ];
      };
    }
    // lib.optionalAttrs (t3.edgeHost != null) {
      edge = {
        environment.MEND_T3_GATEWAY_EDGE_HOST = t3.edgeHost;
        volumes = [ "${composeDir}/Caddyfile.t3:/etc/caddy/sites/t3code-gateway.caddy:ro" ];
      };
    };
    volumes.${t3Volume} = { };
  };
  overlay = lib.recursiveUpdate t3Overlay (
    lib.optionalAttrs (mendEnvironment != { }) {
      services.mend.environment = lib.mapAttrs (_: escapeCompose) mendEnvironment;
    }
  );
  moduleOverlay = pkgs.writeText "compose.module.json" (builtins.toJSON overlay);

  composeFiles = [
    "${composeDir}/compose.v2.yaml"
  ]
  ++ lib.optional edge "${composeDir}/compose.edge.yaml"
  ++ lib.optional mirrorsOn "${composeDir}/compose.mirrors.yaml"
  ++ lib.optional (overlay != { }) moduleOverlay
  ++ map toString cfg.extraComposeFiles;

  staticEnv = pkgs.writeText "mend-static.env" (
    lib.concatStrings (
      lib.mapAttrsToList (key: value: "${key}=${value}\n") (
        {
          MEND_VERSION = cfg.version;
          MEND_IMAGE_REPOSITORY = cfg.imageRepository;
          APP_URL = cfg.url;
          MEND_BIND_HOST = composeHost cfg.bind.host;
          MEND_PORT = toString cfg.bind.port;
          MEND_SSH_PORT = toString cfg.ssh.port;
          SEALANT_SSH_HOST = cfg.sshHost;
          MEND_STORE_VOLUME_NAME = "mend-store";
          MEND_CONTROL_VOLUME_NAME = "mend-control";
          MEND_GARAGE_VOLUME_NAME = "mend-garage";
          DOCKER_SOCKET_PATH = "/run/docker.sock";
        }
        // lib.optionalAttrs (sshBind != null) { MEND_SSH_BIND_HOST = composeHost sshBind; }
        // lib.optionalAttrs edge {
          MEND_EDGE_HOST = cfg.edge.host;
          MEND_EDGE_BIND_HOST = composeHost cfg.edge.bindHost;
        }
        // lib.optionalAttrs cfg.mirrors.npm.enable { MEND_NPM_MIRROR_MAX_SIZE = cfg.mirrors.npm.maxSize; }
        // lib.optionalAttrs cfg.mirrors.docker.enable {
          MEND_DOCKER_MIRROR_MAX_SIZE = cfg.mirrors.docker.maxSize;
        }
      )
    )
  );

  tunnelOrigin = "http://localhost:${toString cfg.bind.port}";
  firstAccountHint = "Until one does, Mend also allows ${tunnelOrigin}: create the first account there over an SSH tunnel (ssh -L ${toString cfg.bind.port}:127.0.0.1:${toString cfg.bind.port} <this host>), then run systemctl restart mend${lib.optionalString edge ", which starts the edge"}.";

  healthOrigin = "http://${connectHost cfg.bind.host}:${toString cfg.bind.port}";

  plan = pkgs.writeText "mend-plan.sh" ''
    identity=${
      lib.escapeShellArg (
        if cfg.secretsFile == null then "${cfg.stateDir}/identity.env" else toString cfg.secretsFile
      )
    }
    generate_identity=${if cfg.secretsFile == null then "1" else "0"}
    state_dir=${lib.escapeShellArg cfg.stateDir}
    allowed_origins=${lib.escapeShellArg (builtins.toJSON cfg.allowedOrigins)}
    tunnel_origin=${lib.escapeShellArg tunnelOrigin}
    static_env=${staticEnv}
    compose_dir=${composeDir}
    compose_files=(${lib.escapeShellArgs composeFiles})
    version=${lib.escapeShellArg cfg.version}
    app_url=${lib.escapeShellArg cfg.url}
    health_origin=${lib.escapeShellArg healthOrigin}
    edge=${if edge then "1" else "0"}
    mend_container=mend-mend-1
    first_account_hint=${lib.escapeShellArg firstAccountHint}
  '';

  server = pkgs.writeShellApplication {
    name = "mend-server";
    runtimeInputs = [
      config.virtualisation.docker.package
      pkgs.docker-compose
      pkgs.coreutils
      pkgs.curl
      pkgs.gnugrep
      pkgs.gnused
      pkgs.jq
      pkgs.openssl
    ];
    excludeShellChecks = [ "SC2154" ];
    text = builtins.readFile ./server.sh;
  };

  mirrorSize =
    default:
    mkOption {
      type = types.strMatching "[1-9][0-9]{0,5}[mg]";
      inherit default;
      description = "The cache's size cap, in nginx's units (`512m` is too small: at least `1g` or `1024m`).";
    };
  atLeastOneGiB = size: lib.hasSuffix "g" size || lib.toInt (lib.removeSuffix "m" size) >= 1024;
in
{
  options.services.mend = {
    enable = mkEnableOption "Mend, run as its supported Docker Compose install";

    version = mkOption {
      type = types.strMatching "[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.-]+)?";
      default = defaultVersion;
      defaultText = lib.literalMD "the version of the `mend` CLI in this flake (`apps/cli/package.json`)";
      description = "The Mend server version, the tag of its image. `mend server setup` defaults to its own CLI version the same way.";
    };

    imageRepository = mkOption {
      type = types.str;
      default = "ghcr.io/sealant-sh/mend";
      description = "Where Mend's image comes from; the image is `<imageRepository>:<version>`.";
    };

    url = mkOption {
      type = types.str;
      example = "https://mend.example.com";
      description = "The origin people open Mend at (`APP_URL`), with no path.";
    };

    allowedOrigins = mkOption {
      type = types.listOf types.str;
      default = [ ];
      description = "Further browser origins Mend accepts (`MEND_ALLOWED_ORIGINS`), each exact.";
    };

    bind = {
      host = mkOption {
        type = types.str;
        default = "127.0.0.1";
        description = "The address Mend's web port is published on, a literal IPv4 or IPv6 address.";
      };
      port = mkOption {
        type = types.port;
        default = 3105;
        description = "Mend's web port on the host.";
      };
    };

    ssh = {
      bindHost = mkOption {
        type = types.nullOr types.str;
        default = null;
        description = "Where workspace SSH is published apart from the web port (`MEND_SSH_BIND_HOST`). Null publishes it beside the web port, on `bind.host`.";
      };
      port = mkOption {
        type = types.port;
        default = 2222;
        description = "Workspace SSH's port on the host.";
      };
    };

    sshHost = mkOption {
      type = types.str;
      default = urlHostname;
      defaultText = lib.literalMD "the hostname of `url`";
      description = "The host workspace SSH is reached at (`SEALANT_SSH_HOST`).";
    };

    exposure = mkOption {
      type = types.nullOr (
        types.enum [
          "loopback"
          "private"
          "public"
        ]
      );
      default = null;
      description = ''
        How this instance is reached, as you declare it (`MEND_EXPOSURE`). Null declares nothing
        and the server keeps its default; with the edge on, the edge overlay declares `private`.
        `public` needs the edge and a first account: on a fresh install the server refuses to
        start as public, and the unit's log says why.
      '';
    };

    tenancy = mkOption {
      type = types.nullOr (
        types.enum [
          "single"
          "multi"
        ]
      );
      default = null;
      description = "One organization or many (`MEND_TENANCY`). Null keeps the server's default, `single`.";
    };

    declared = mkOption {
      type = types.listOf (types.enum declarable);
      default = [ ];
      description = "The public exposure gate's items you verified from outside (`MEND_EXPOSURE_DECLARED`).";
    };

    edge = {
      enable = mkEnableOption ''
        the Caddy TLS edge (deploy/docker/compose.edge.yaml) on 80 and 443. It starts only once
        the first account exists: until then registration is open to whoever reaches the origin
        first. Until then Mend also allows `http://localhost:<bind.port>`, so the account can be
        created over an SSH tunnel; then `systemctl restart mend` starts the edge
      '';
      host = mkOption {
        type = types.str;
        default = urlHostname;
        defaultText = lib.literalMD "the hostname of `url`";
        description = "The DNS name the edge's certificate is for (`MEND_EDGE_HOST`). `url` must be `https://<host>`.";
      };
      bindHost = mkOption {
        type = types.str;
        default = "0.0.0.0";
        description = "The address the edge publishes 80/tcp, 443/tcp and Mend's 443/udp on.";
      };
    };

    t3Gateway = {
      enable = mkEnableOption ''
        the t3code gateway (docs/adr/0012), which lets T3 Code's desktop, mobile and web clients add
        this server as a remote environment. It runs in the Mend container on a listener of its own,
        as `mend server setup --t3-gateway` turns it on, and its state stays in the Docker volume
        `mend_mend-t3-gateway` when it is turned off. While it is on, the exposure gate lists
        `t3code-gateway`
      '';
      port = mkOption {
        type = types.port;
        default = 3120;
        description = "The gateway's port on the host (`--t3-gateway-port`).";
      };
      bindHost = mkOption {
        type = types.str;
        default = cfg.bind.host;
        defaultText = lib.literalExpression "config.services.mend.bind.host";
        description = ''
          The address the gateway's port is published on, a literal IPv4 or IPv6 address. Setup
          publishes it where Mend's web port is. With the edge, it stays on loopback.
        '';
      };
      host = mkOption {
        type = types.nullOr types.str;
        default = null;
        example = "t3.mend.example.com";
        description = ''
          The DNS name the edge serves the gateway on (`--t3-gateway-origin`). Needs the edge. A
          T3 Code client always uses a server's root path, so the gateway cannot share `edge.host`
          and needs a host of its own, whose DNS points where `edge.host` does. Null serves it
          through no edge: T3 Code reaches it at `bindHost` and `port`.
        '';
      };
    };

    sessions.runtime = mkOption {
      type = types.nullOr (
        types.enum [
          "docker"
          "boat"
        ]
      );
      default = null;
      description = ''
        Where an organization's new sessions run until its owner chooses (`MEND_SESSION_RUNTIME`,
        `--session-runtime`). Null keeps the server's default, `docker`, or the first of
        `sessions.runtimes`. It picks the runtime only: Boat's credentials, admission and the public
        session and capture endpoints are configured apart from it, and until they are, a Boat
        session reports a refusal and never starts on Docker instead. Existing worktrees keep the
        runtime they started with.
      '';
    };

    sessions.runtimes = mkOption {
      type = types.nullOr (
        types.nonEmptyListOf (
          types.enum [
            "docker"
            "boat"
          ]
        )
      );
      default = null;
      example = [
        "docker"
        "boat"
      ];
      description = ''
        The runtimes organizations may choose among (`MEND_SESSION_RUNTIMES`,
        `--session-runtimes`). With both, each organization's owner picks where its new sessions
        run in Organization settings, and `sessions.runtime` is what an organization gets until it
        picks; it must be in this list. Null offers `sessions.runtime` alone.
      '';
    };

    mirrors = {
      npm = {
        enable = mkOption {
          type = types.bool;
          default = true;
          description = "Run the npm registry mirror beside Mend, as `mend server setup` does by default.";
        };
        maxSize = mirrorSize "10g";
      };
      docker = {
        enable = mkOption {
          type = types.bool;
          default = true;
          description = "Run the Docker Hub mirror beside Mend, as `mend server setup` does by default.";
        };
        maxSize = mirrorSize "20g";
      };
    };

    secretsFile = mkOption {
      type = types.nullOr types.path;
      default = null;
      example = "/run/secrets/mend-identity.env";
      description = ''
        The install's identity: a `KEY=value` file in `mend server setup`'s identity.env format
        with MEND_POSTGRES_ADMIN_PASSWORD, MEND_DB_PASSWORD, SEALANT_DB_PASSWORD,
        BETTER_AUTH_SECRET, SEALANT_CREDENTIALS_KEY, SEALANT_SERVICE_KEY and
        WORKSPACE_SSH_GATEWAY_TOKEN. A path at run time, never read into the Nix store, so a
        sops-nix or agenix secret works. The SHA-256 of its exact bytes labels the data volumes as
        this install's, so its bytes must never change. Null generates one at
        `''${stateDir}/identity.env` on the first start; an existing setup install's identity.env
        adopts that install's data.
      '';
    };

    stateDir = mkOption {
      type = types.path;
      default = "/var/lib/mend";
      description = ''
        Where the generated identity lives when `secretsFile` is null. Mend's data lives in Docker
        named volumes (workspaces mount them by name), so it follows Docker's own data root: move
        it with `virtualisation.docker.daemon.settings.data-root`.
      '';
    };

    environment = mkOption {
      type = types.attrsOf types.str;
      default = { };
      example = {
        MEND_TRUSTED_PROXIES = "172.16.0.0/12";
      };
      description = "Further environment for the Mend container, applied over everything the module sets. Never put a secret here: it lands in the Nix store.";
    };

    extraComposeFiles = mkOption {
      type = types.listOf types.path;
      default = [ ];
      description = "Compose overlays applied last. Relative paths inside them resolve against deploy/docker.";
    };

    openFirewall = mkOption {
      type = types.bool;
      default = false;
      description = ''
        Open the ports Mend publishes beyond loopback: the edge's 80/tcp, 443/tcp and 443/udp
        with the edge on, otherwise the web port, workspace SSH and the t3code gateway when their
        addresses are not loopback. Docker publishes ports through rules of its own that NixOS's firewall does not
        filter, so the bind addresses, not this option, are what keep a port off a network.
      '';
    };
  };

  config = mkIf cfg.enable {
    assertions = [
      {
        assertion = origin != null;
        message = "services.mend.url must be an http or https origin with no path, such as https://mend.example.com.";
      }
      {
        assertion = cfg.secretsFile == null || !lib.hasPrefix builtins.storeDir (toString cfg.secretsFile);
        message = "services.mend.secretsFile is in the Nix store, where every local user can read it. Point it at a path outside the store, such as a sops-nix or agenix secret.";
      }
      {
        assertion =
          isAddress cfg.bind.host
          && (cfg.ssh.bindHost == null || isAddress cfg.ssh.bindHost)
          && isAddress cfg.t3Gateway.bindHost;
        message = "services.mend.bind.host, services.mend.ssh.bindHost and services.mend.t3Gateway.bindHost must be literal IPv4 or IPv6 addresses.";
      }
      {
        assertion =
          t3 == null
          || !lib.elem t3.port [
            cfg.bind.port
            cfg.ssh.port
          ];
        message = "services.mend.t3Gateway.port must differ from services.mend.bind.port and services.mend.ssh.port: the gateway needs a port of its own.";
      }
      {
        assertion =
          t3 == null
          || !edge
          || !lib.elem t3.port [
            80
            443
          ];
        message = "With the edge, services.mend.t3Gateway.port must not be 80 or 443: the edge has them.";
      }
      {
        assertion = t3 == null || !edge || isLoopback t3.bindHost;
        message = "With the edge, services.mend.t3Gateway.bindHost stays on loopback, as Mend's own port does. Set services.mend.t3Gateway.host to serve the gateway through the edge.";
      }
      {
        assertion = cfg.t3Gateway.host == null || (cfg.t3Gateway.enable && edge);
        message = "services.mend.t3Gateway.host needs services.mend.t3Gateway.enable and services.mend.edge.enable: it is the edge that serves the gateway on a host of its own.";
      }
      {
        assertion =
          cfg.t3Gateway.host == null || (isDnsName cfg.t3Gateway.host && cfg.t3Gateway.host != cfg.edge.host);
        message = "services.mend.t3Gateway.host must be a lowercase DNS name of its own, such as t3.${cfg.edge.host}, not services.mend.edge.host: a T3 Code client always uses a server's root path.";
      }
      {
        assertion = !lib.elem "t3code-gateway" cfg.declared || cfg.t3Gateway.enable;
        message = "services.mend.declared names t3code-gateway, but services.mend.t3Gateway.enable is off: the exposure gate lists that item only while the gateway runs.";
      }
      {
        assertion = cfg.bind.port != cfg.ssh.port;
        message = "services.mend.bind.port and services.mend.ssh.port must differ.";
      }
      {
        assertion = !edge || cfg.url == "https://${cfg.edge.host}";
        message = "With services.mend.edge.enable, services.mend.url must be https://${cfg.edge.host}, the one origin the edge serves.";
      }
      {
        assertion = !edge || isLoopback cfg.bind.host;
        message = "With the edge, services.mend.bind.host stays on loopback: Mend's own port is reached through the edge alone.";
      }
      {
        assertion =
          !edge
          || lib.all (port: port != 80 && port != 443) [
            cfg.bind.port
            cfg.ssh.port
          ];
        message = "With the edge, services.mend.bind.port and services.mend.ssh.port must not be 80 or 443.";
      }
      {
        assertion =
          cfg.exposure != "loopback"
          || (
            !edge && isLoopback cfg.bind.host && isLoopback sshReach && (t3 == null || isLoopback t3.bindHost)
          );
        message = "services.mend.exposure = \"loopback\" contradicts the edge or a port published beyond loopback.";
      }
      {
        assertion = cfg.exposure != "public" || edge;
        message = "services.mend.exposure = \"public\" needs services.mend.edge.enable: without it nothing sets an https origin or MEND_TRUSTED_PROXIES, and the server refuses to start as public.";
      }
      {
        assertion =
          cfg.exposure != "public" || isLoopback sshReach || lib.elem "workspace-ssh" cfg.declared;
        message = "services.mend.exposure = \"public\" with workspace SSH published beyond loopback needs \"workspace-ssh\" in services.mend.declared, once you checked who reaches that port.";
      }
      {
        assertion = atLeastOneGiB cfg.mirrors.npm.maxSize && atLeastOneGiB cfg.mirrors.docker.maxSize;
        message = "services.mend.mirrors.*.maxSize must be at least 1g.";
      }
      {
        assertion = lib.all (file: !lib.hasInfix " " (toString file)) cfg.extraComposeFiles;
        message = "services.mend.extraComposeFiles paths must not contain spaces.";
      }
    ];

    virtualisation.docker.enable = true;

    # Every workspace's Docker service is rootless and creates a user namespace, which these
    # settings would refuse (packages/domain/src/workbench/host-user-namespaces.ts).
    security.allowUserNamespaces = true;
    security.unprivilegedUsernsClone = true;
    boot.kernel.sysctl = mkIf config.security.apparmor.enable {
      "kernel.apparmor_restrict_unprivileged_userns" = 0;
    };

    networking.firewall = mkIf cfg.openFirewall (
      if edge then
        {
          allowedTCPPorts = [
            80
            443
          ];
          allowedUDPPorts = [ 443 ];
        }
      else
        {
          allowedTCPPorts =
            lib.optional (!isLoopback cfg.bind.host) cfg.bind.port
            ++ lib.optional (!isLoopback sshReach) cfg.ssh.port
            ++ lib.optional (t3 != null && !isLoopback t3.bindHost) t3.port;
        }
    );

    systemd.services.mend = {
      description = "Mend";
      wantedBy = [ "multi-user.target" ];
      after = [
        "docker.service"
        "network-online.target"
      ];
      requires = [ "docker.service" ];
      wants = [ "network-online.target" ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        ExecStart = "${lib.getExe server} start ${plan}";
        ExecStop = "${lib.getExe server} stop ${plan}";
        RuntimeDirectory = "mend";
        RuntimeDirectoryMode = "0700";
        TimeoutStartSec = "45min";
        TimeoutStopSec = "5min";
      };
    };
  };
}
