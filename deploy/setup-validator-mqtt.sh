#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
    echo "Ejecuta este instalador como root." >&2
    exit 1
fi

umask 077
project_dir=${1:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}
tls_dir=/etc/mosquitto/tls
export_dir=/etc/fuel-edge/provisioning/validator-01

if ! command -v mosquitto >/dev/null 2>&1 || \
   ! command -v mosquitto_pub >/dev/null 2>&1; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y mosquitto mosquitto-clients
fi

install -d -m 0750 -o root -g mosquitto "$tls_dir"
install -d -m 0700 /etc/fuel-edge/tls "$export_dir"

if [ ! -f "$tls_dir/ca.key" ]; then
    openssl genrsa -out "$tls_dir/ca.key" 4096
    openssl req -x509 -new -sha256 -days 3650 \
        -key "$tls_dir/ca.key" -out "$tls_dir/ca.crt" \
        -subj "/CN=fuel-edge-local-ca"
fi

issue_certificate() {
    name=$1
    common_name=$2
    purpose=$3
    extension_file=$(mktemp)
    if [ "$purpose" = server ]; then
        {
            echo "basicConstraints=CA:FALSE"
            echo "keyUsage=digitalSignature,keyEncipherment"
            echo "extendedKeyUsage=serverAuth"
            echo "subjectAltName=DNS:10.42.0.1,DNS:mqtt.fundo.internal,DNS:raspberrypi.local,IP:127.0.0.1,IP:10.10.10.20,IP:10.10.11.20,IP:10.42.0.1,IP:192.168.100.102"
        } > "$extension_file"
    else
        {
            echo "basicConstraints=CA:FALSE"
            echo "keyUsage=digitalSignature,keyEncipherment"
            echo "extendedKeyUsage=clientAuth"
        } > "$extension_file"
    fi
    openssl genrsa -out "$tls_dir/$name.key" 2048
    openssl req -new -sha256 -key "$tls_dir/$name.key" \
        -out "$tls_dir/$name.csr" -subj "/CN=$common_name"
    openssl x509 -req -sha256 -days 825 \
        -in "$tls_dir/$name.csr" -CA "$tls_dir/ca.crt" \
        -CAkey "$tls_dir/ca.key" -CAcreateserial \
        -out "$tls_dir/$name.crt" -extfile "$extension_file"
    rm -f "$extension_file" "$tls_dir/$name.csr"
}

if [ "${2:-}" = "--renew-broker" ] || [ ! -f "$tls_dir/broker.crt" ]; then
    issue_certificate broker 10.42.0.1 server
fi
if [ ! -f "$tls_dir/rpi.crt" ]; then
    issue_certificate rpi rpi-rpiplc-19r-01 client
fi
if [ ! -f "$tls_dir/validator-01.crt" ]; then
    issue_certificate validator-01 validator-01 client
fi

install -m 0644 "$project_dir/deploy/mosquitto/mosquitto.conf.example" \
    /etc/mosquitto/conf.d/fuel-edge.conf
install -m 0640 -o root -g mosquitto "$project_dir/deploy/mosquitto/acl.example" \
    /etc/mosquitto/acl
install -d -m 0755 /etc/systemd/system/mosquitto.service.d
install -m 0644 "$project_dir/deploy/systemd/mosquitto-fuel-edge.conf" \
    /etc/systemd/system/mosquitto.service.d/fuel-edge-recovery.conf
chown root:mosquitto "$tls_dir"/*.key "$tls_dir"/*.crt
chmod 0640 "$tls_dir"/*.key
chmod 0644 "$tls_dir"/*.crt

install -m 0644 "$tls_dir/ca.crt" /etc/fuel-edge/tls/ca.crt
install -m 0644 "$tls_dir/rpi.crt" /etc/fuel-edge/tls/rpi.crt
install -m 0600 "$tls_dir/rpi.key" /etc/fuel-edge/tls/rpi.key
install -m 0600 "$tls_dir/ca.crt" "$export_dir/ca.crt"
install -m 0600 "$tls_dir/validator-01.crt" "$export_dir/client.crt"
install -m 0600 "$tls_dir/validator-01.key" "$export_dir/client.key"

openssl verify -CAfile "$tls_dir/ca.crt" \
    "$tls_dir/broker.crt" "$tls_dir/rpi.crt" "$tls_dir/validator-01.crt"
systemctl daemon-reload
systemctl enable --now mosquitto
systemctl restart mosquitto
systemctl is-enabled --quiet mosquitto
systemctl is-active --quiet mosquitto
# Comprueba de extremo a extremo listener, mTLS, identidad y ACL sin depender
# de que el Nano ya esté encendido.
mosquitto_pub -h 127.0.0.1 -p 8883 \
    --cafile "$tls_dir/ca.crt" \
    --cert "$tls_dir/rpi.crt" \
    --key "$tls_dir/rpi.key" \
    -q 1 \
    -t fuel-edge/v1/concha-y-toro-piloto/rpiplc-19r-01/validators/validator-health-probe/challenge \
    -m '{"version":1,"type":"health.probe"}'
systemctl --no-pager --full status mosquitto
