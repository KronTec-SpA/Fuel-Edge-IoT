#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
    echo "Ejecuta este instalador como root." >&2
    exit 1
fi

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y chrony

cat > /etc/chrony/conf.d/fuel-edge-local.conf <<'EOF'
# Entrega hora a los dispositivos de la red privada del punto de carga.
allow 10.42.0.0/24
# Conserva servicio local aunque el fundo pierda temporalmente Internet.
local stratum 10
EOF

systemctl enable --now chrony
systemctl restart chrony
systemctl --no-pager --full status chrony
