#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
    echo "Ejecuta este instalador como root." >&2
    exit 1
fi

umask 077
connection_name=fuel-edge-ap
ssid=FuelEdge-RPi
settings_file=/etc/fuel-edge/validator-ap.txt

install -d -m 0700 /etc/fuel-edge
if [ -f "$settings_file" ]; then
    password=$(sed -n '2p' "$settings_file")
else
    password=$(openssl rand -hex 10)
    {
        echo "$ssid"
        echo "$password"
    } > "$settings_file"
    chmod 0600 "$settings_file"
fi

if ! nmcli -t -f NAME connection show | grep -Fxq "$connection_name"; then
    nmcli connection add type wifi ifname wlan0 con-name "$connection_name" \
        ssid "$ssid"
fi

nmcli connection modify "$connection_name" \
    connection.autoconnect yes \
    connection.autoconnect-priority 100 \
    connection.autoconnect-retries 0 \
    802-11-wireless.mode ap \
    802-11-wireless.band bg \
    802-11-wireless.powersave 2 \
    802-11-wireless-security.key-mgmt wpa-psk \
    802-11-wireless-security.proto rsn \
    802-11-wireless-security.psk "$password" \
    ipv4.method shared \
    ipv4.addresses 10.42.0.1/24 \
    ipv6.method disabled

nmcli connection up "$connection_name"
echo "WIFI_AP=active SSID=$ssid ADDRESS=10.42.0.1/24"
