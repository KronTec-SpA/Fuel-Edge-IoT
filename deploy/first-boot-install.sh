#!/bin/sh
# Instala el agente desde la partición FAT de arranque, sin usar Internet.
# El servicio de control queda deliberadamente detenido y deshabilitado.

set -u

boot_dir=/boot/firmware
release_id_file="$boot_dir/fuel-edge-release-id.txt"
source_archive="$boot_dir/fuel-edge-source.tar.gz"
checksum_file="$boot_dir/fuel-edge-sha256.txt"
wheel_dir="$boot_dir/fuel-edge-wheels"
ssh_key_file="$boot_dir/fuel-edge-ssh-key.pub"
password_hash_file="$boot_dir/fuel-edge-password.hash"
log_file="$boot_dir/fuel-edge-install.log"
status_file="$boot_dir/fuel-edge-install-status.txt"
cmdline_file="$boot_dir/cmdline.txt"

# Evita repetir este instalador en arranques posteriores, incluso si la
# instalación falla. El resultado queda visible en la partición bootfs.
sed -i 's| systemd\.[^ ]*||g' "$cmdline_file" 2>/dev/null || true

install_release() {
    release_id=$(sed -n '1{s/[^A-Za-z0-9._-]//g;p;}' "$release_id_file") || return 1
    [ -n "$release_id" ] || return 1

    cd "$boot_dir" || return 1
    sha256sum -c "$(basename "$checksum_file")" || return 1

    python3 -c 'import sys; raise SystemExit(sys.version_info < (3, 11))' || return 1

    release_dir="/opt/fuel-edge-source/releases/$release_id"
    install -d -m 0755 "$release_dir" /opt/fuel-edge /etc/fuel-edge \
        /etc/fuel-edge/tls /var/lib/fuel-edge || return 1
    install -d -m 0750 /var/lib/fuel-edge/validator-ota || return 1
    tar -xzf "$source_archive" -C "$release_dir" || return 1

    python3 -m venv --system-site-packages /opt/fuel-edge/venv || return 1
    /opt/fuel-edge/venv/bin/pip install --no-index --no-deps --upgrade \
        "$wheel_dir"/*.whl || return 1
    # Evita combinar la nueva unidad Type=notify con un wheel anterior que no
    # emita READY/WATCHDOG y quedaría reiniciando por TimeoutStartSec.
    /opt/fuel-edge/venv/bin/fuel-edge --help >/dev/null || return 1
    /opt/fuel-edge/venv/bin/python -c \
        'from fuel_edge.systemd_notify import SystemdNotifier' \
        >/dev/null || return 1
    /opt/fuel-edge/venv/bin/python -m fuel_edge.power_events \
        --database /var/lib/fuel-edge/edge.db init >/dev/null || return 1

    if [ ! -e /etc/fuel-edge/config.toml ]; then
        install -m 0600 "$release_dir/config/fuel-edge.toml" \
            /etc/fuel-edge/config.toml || return 1
    fi
    if [ ! -e /etc/fuel-edge/validator-registry.example.toml ]; then
        install -m 0600 "$release_dir/config/validator-registry.example.toml" \
            /etc/fuel-edge/validator-registry.example.toml || return 1
    fi
    if [ ! -e /etc/fuel-edge/equipment-registry.example.toml ]; then
        install -m 0600 "$release_dir/config/equipment-registry.example.toml" \
            /etc/fuel-edge/equipment-registry.example.toml || return 1
    fi
    install -m 0644 "$release_dir/deploy/systemd/fuel-edge.service" \
        /etc/systemd/system/fuel-edge.service || return 1
    install -m 0644 "$release_dir/deploy/systemd/fuel-equipment-enrollment.service" \
        /etc/systemd/system/fuel-equipment-enrollment.service || return 1
    install -m 0644 "$release_dir/deploy/systemd/fuel-validator-ota.service" \
        /etc/systemd/system/fuel-validator-ota.service || return 1
    install -d -m 0755 /etc/systemd/system/mosquitto.service.d || return 1
    install -m 0644 "$release_dir/deploy/systemd/mosquitto-fuel-edge.conf" \
        /etc/systemd/system/mosquitto.service.d/fuel-edge-recovery.conf || return 1
    install -d -m 0755 /etc/rpishutdown/hooks || return 1
    install -m 0755 "$release_dir/deploy/rpishutdown/pre-poweroff" \
        /etc/rpishutdown/hooks/pre-poweroff || return 1
    ln -sfn "$release_dir" /opt/fuel-edge-source/current || return 1

    systemctl daemon-reload || return 1
    systemctl disable fuel-edge >/dev/null 2>&1 || true
    systemctl stop fuel-edge >/dev/null 2>&1 || true
    systemctl disable fuel-equipment-enrollment >/dev/null 2>&1 || true
    systemctl stop fuel-equipment-enrollment >/dev/null 2>&1 || true
    if systemctl cat mosquitto.service >/dev/null 2>&1 && \
       command -v systemd-analyze >/dev/null 2>&1; then
        systemd-analyze verify /etc/systemd/system/fuel-edge.service || return 1
    fi
    return 0
}

configure_ssh() {
    [ -s "$ssh_key_file" ] || return 1
    id pi >/dev/null 2>&1 || return 1
    public_key=$(sed -n '1p' "$ssh_key_file") || return 1
    case "$public_key" in
        ssh-ed25519\ *) ;;
        *) return 1 ;;
    esac

    install -d -m 0700 -o pi -g pi /home/pi/.ssh || return 1
    touch /home/pi/.ssh/authorized_keys || return 1
    if ! grep -Fqx "$public_key" /home/pi/.ssh/authorized_keys; then
        printf '%s\n' "$public_key" >> /home/pi/.ssh/authorized_keys || return 1
    fi
    chown pi:pi /home/pi/.ssh/authorized_keys || return 1
    chmod 0600 /home/pi/.ssh/authorized_keys || return 1
    systemctl enable ssh >/dev/null 2>&1 || return 1
    return 0
}

configure_password() {
    [ -s "$password_hash_file" ] || return 1
    id pi >/dev/null 2>&1 || return 1
    password_hash=$(sed -n '1p' "$password_hash_file") || return 1
    case "$password_hash" in
        \$6\$*|\$y\$*) ;;
        *) return 1 ;;
    esac
    usermod --password "$password_hash" pi || return 1
    rm -f "$password_hash_file" || return 1
    return 0
}

: > "$log_file"
chmod 0600 "$log_file" 2>/dev/null || true
install_release >> "$log_file" 2>&1
install_exit=$?
configure_ssh >> "$log_file" 2>&1
ssh_exit=$?
configure_password >> "$log_file" 2>&1
password_exit=$?

if [ "$install_exit" -eq 0 ] && [ "$ssh_exit" -eq 0 ] && \
    [ "$password_exit" -eq 0 ]; then
    result=INSTALADO
    ssh_result=HABILITADO_SIN_PASSWORD
else
    result=ERROR
    if [ "$ssh_exit" -eq 0 ]; then
        ssh_result=HABILITADO_SIN_PASSWORD
    else
        ssh_result=ERROR
    fi
fi

{
    printf 'resultado=%s\n' "$result"
    printf 'codigo_instalacion=%s\n' "$install_exit"
    printf 'ssh=%s\n' "$ssh_result"
    printf 'codigo_ssh=%s\n' "$ssh_exit"
    printf 'password=CONFIGURADA\n'
    printf 'codigo_password=%s\n' "$password_exit"
    printf 'servicio=detenido_y_deshabilitado\n'
    printf 'log=%s\n' "$log_file"
} > "$status_file"

sync
# systemd.run_success_action=reboot debe ejecutarse aun cuando la instalación
# haya fallado; el estado y el log conservan el error para diagnóstico.
exit 0
