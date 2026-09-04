#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
    echo "Ejecuta este configurador como root." >&2
    exit 1
fi

host_label=${1:-fueledge}
dns_name=${2:-fueledge.conchaytoro}
web_address=${3:-10.10.10.20}

case "$host_label" in
    ""|-*|*-|*[!a-z0-9-]*)
        echo "Hostname no válido: $host_label" >&2
        exit 1
        ;;
esac

if [ "${#host_label}" -gt 63 ]; then
    echo "El hostname no puede superar 63 caracteres." >&2
    exit 1
fi

if ! printf '%s\n' "$dns_name" | grep -Eq \
    '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'; then
    echo "Nombre DNS no válido: $dns_name" >&2
    exit 1
fi

if ! printf '%s\n' "$web_address" | awk -F. '
    NF != 4 { exit 1 }
    {
        for (part = 1; part <= 4; part++) {
            if ($part !~ /^[0-9]+$/ || $part < 0 || $part > 255) exit 1
        }
    }
'; then
    echo "Dirección IPv4 no válida: $web_address" >&2
    exit 1
fi

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
avahi_service_source="$project_dir/deploy/avahi/fuel-edge-web.service"

if ! command -v hostnamectl >/dev/null 2>&1 || \
   ! command -v systemctl >/dev/null 2>&1; then
    echo "Este configurador requiere un sistema Linux con systemd." >&2
    exit 1
fi

if ! systemctl cat avahi-daemon.service >/dev/null 2>&1; then
    if ! command -v apt-get >/dev/null 2>&1; then
        echo "Falta avahi-daemon y no se encontró apt-get para instalarlo." >&2
        exit 1
    fi
    echo "Instalando avahi-daemon para publicar el nombre en la red local..."
    if ! DEBIAN_FRONTEND=noninteractive apt-get install -y avahi-daemon; then
        echo "No fue posible instalar avahi-daemon. Revisa los repositorios del PLC." >&2
        exit 1
    fi
fi

hostnamectl set-hostname "$host_label"

if grep -Eq '^127\.0\.1\.1([[:space:]]|$)' /etc/hosts; then
    sed -i "s/^127\.0\.1\.1.*/127.0.1.1\t$host_label/" /etc/hosts
else
    printf '127.0.1.1\t%s\n' "$host_label" >> /etc/hosts
fi

install -d -m 0755 /etc/avahi/services
install -m 0644 "$avahi_service_source" \
    /etc/avahi/services/fuel-edge-web.service
systemctl enable --now avahi-daemon
systemctl restart avahi-daemon
systemctl is-active --quiet avahi-daemon

local_name="$host_label.local"
echo "MDNS_NAME=active URL=http://$local_name/ ADDRESS=$web_address"
echo "IP_FALLBACK=active URL=http://$web_address/"
echo "DNS_NAME=requires_local_dns RECORD=$dns_name A $web_address"
