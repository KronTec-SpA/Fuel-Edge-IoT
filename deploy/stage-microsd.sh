#!/bin/sh
# Copia un payload verificado a la partición bootfs de una microSD Raspberry Pi.

set -eu

if [ "$#" -ne 3 ]; then
    echo "Uso: $0 PAYLOAD_DIR VOLUMEN DISPOSITIVO_PARTICION" >&2
    exit 2
fi

payload_dir=$1
volume_dir=$2
expected_device=$3
cmdline_file="$volume_dir/cmdline.txt"

actual_device=$(df -P "$volume_dir" | awk 'NR == 2 { print $1 }')
if [ "$actual_device" != "$expected_device" ]; then
    echo "El volumen está en $actual_device, no en $expected_device." >&2
    exit 1
fi
if [ ! -f "$cmdline_file" ] || ! grep -q 'root=PARTUUID=' "$cmdline_file"; then
    echo "El volumen no parece una partición de arranque Raspberry Pi." >&2
    exit 1
fi
if grep -q 'systemd.run=' "$cmdline_file"; then
    echo "cmdline.txt ya contiene una instalación de primer arranque." >&2
    exit 1
fi

for required in firstrun.sh fuel-edge-release-id.txt fuel-edge-source.tar.gz \
    fuel-edge-sha256.txt fuel-edge-wheels; do
    if [ ! -e "$payload_dir/$required" ]; then
        echo "Falta $payload_dir/$required." >&2
        exit 1
    fi
done

cp -p "$cmdline_file" "$volume_dir/cmdline.txt.pre-fuel-edge"
cp -p "$payload_dir/firstrun.sh" "$volume_dir/firstrun.sh"
cp -p "$payload_dir/fuel-edge-release-id.txt" "$volume_dir/"
cp -p "$payload_dir/fuel-edge-source.tar.gz" "$volume_dir/"
cp -p "$payload_dir/fuel-edge-sha256.txt" "$volume_dir/"
mkdir -p "$volume_dir/fuel-edge-wheels"
rsync -a "$payload_dir/fuel-edge-wheels/" "$volume_dir/fuel-edge-wheels/"
chmod 0755 "$volume_dir/firstrun.sh"
if [ -s "$payload_dir/fuel-edge-ssh-key.pub" ]; then
    cp -p "$payload_dir/fuel-edge-ssh-key.pub" "$volume_dir/"
    touch "$volume_dir/ssh"
fi
if [ -s "$payload_dir/fuel-edge-password.hash" ]; then
    cp -p "$payload_dir/fuel-edge-password.hash" "$volume_dir/"
fi

sed -i '' -e 's|$| systemd.run=/boot/firmware/firstrun.sh systemd.run_success_action=reboot systemd.unit=kernel-command-line.target|' "$cmdline_file"

(cd "$volume_dir" && shasum -a 256 -c fuel-edge-sha256.txt)
grep -q 'systemd.run=/boot/firmware/firstrun.sh' "$cmdline_file"
sync

echo "Payload cargado en $expected_device y verificado."
