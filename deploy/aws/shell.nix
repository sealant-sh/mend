# Tools for the AWS MicroVM POC. Enter with `nix-shell deploy/aws/shell.nix`
# (or `nix develop -f deploy/aws/shell.nix`). Nothing here is installed globally;
# the POC is meant to be torn down without leaving tools behind.
{ pkgs ? import <nixpkgs> { } }:
pkgs.mkShell {
  packages = with pkgs; [
    awscli2
    opentofu
    kubectl
    kubernetes-helm
    jq
    zip
    # boto3 signs the presigned PUT for the R1 transfer bench (`aws s3 presign` does GET only).
    (python3.withPackages (ps: [ ps.boto3 ]))
  ];
  shellHook = ''
    export AWS_REGION=''${AWS_REGION:-eu-central-1}
    export AWS_PAGER=""
    echo "mend aws poc shell · region $AWS_REGION · $(aws --version 2>/dev/null | cut -d' ' -f1) · $(tofu version | head -1)"
  '';
}
