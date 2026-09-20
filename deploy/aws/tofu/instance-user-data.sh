#!/bin/bash
# First boot of the control plane instance (instance.tf). Installs Docker and Compose, puts Docker's
# data root on the data volume, and keeps the edge off the instance metadata address. It holds no
# secret and starts no Mend: the operator places .env and brings Compose up over SSM
# (deploy/aws/README.md, "Single instance").
set -euo pipefail

COMPOSE_VERSION="v5.5.1"
COMPOSE_SHA256="732e3a84c1a0f67256ce80bc2598a24546b10ca05f9faa97efceb1171ece2ef7"
DATA_MOUNT="/var/lib/docker"
EDGE_SUBNET="192.168.250.0/28" # compose.edge.yaml's MEND_EDGE_SUBNET default; keep the two equal

# The data volume is attached as /dev/sdf and appears as an NVMe device on Nitro. These instance
# types have no instance store, so it is the one disk that is not the root disk.
ROOT_DISK=$(lsblk -no PKNAME "$(findmnt -no SOURCE /)")
for _ in $(seq 1 60); do
  DEVICE=$(lsblk -dnpo NAME,TYPE | awk '$2=="disk"{print $1}' | grep -vx "/dev/${ROOT_DISK}" | head -n 1 || true)
  [ -n "${DEVICE:-}" ] && break
  sleep 2
done
[ -n "${DEVICE:-}" ] || { echo "data volume not found" >&2; exit 1; }

# Format only a blank volume: a replaced instance must find the old data intact.
if ! blkid "$DEVICE" >/dev/null 2>&1; then
  mkfs.xfs -L mend-data "$DEVICE"
fi
mkdir -p "$DATA_MOUNT"
grep -q 'LABEL=mend-data' /etc/fstab || echo "LABEL=mend-data $DATA_MOUNT xfs defaults,nofail 0 2" >>/etc/fstab
mount -a

dnf install -y docker
install -d -m 0755 /usr/local/lib/docker/cli-plugins
curl -fsSL -o /usr/local/lib/docker/cli-plugins/docker-compose \
  "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-aarch64"
echo "${COMPOSE_SHA256}  /usr/local/lib/docker/cli-plugins/docker-compose" | sha256sum -c -
chmod 0755 /usr/local/lib/docker/cli-plugins/docker-compose
systemctl enable --now docker

# The Mend container needs the instance role (S3, Lambda), so the metadata hop limit is 2. The edge
# faces the Internet and needs nothing from AWS: drop its path to the metadata address. DOCKER-USER
# is evaluated before Docker's own rules and survives Docker restarts.
cat >/etc/systemd/system/mend-edge-metadata-block.service <<EOF
[Unit]
Description=Keep the Mend edge network off the instance metadata address
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c 'iptables -C DOCKER-USER -s ${EDGE_SUBNET} -d 169.254.169.254 -j DROP 2>/dev/null || iptables -I DOCKER-USER -s ${EDGE_SUBNET} -d 169.254.169.254 -j DROP'

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now mend-edge-metadata-block.service

install -d -m 0700 /opt/mend
