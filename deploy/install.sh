#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
    echo "Ejecuta este instalador como root." >&2
    exit 1
fi

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

install -d -m 0755 /opt/fuel-edge /etc/fuel-edge /etc/fuel-edge/tls /var/lib/fuel-edge
install -d -m 0750 /var/lib/fuel-edge/validator-ota
python3 -m venv --system-site-packages /opt/fuel-edge/venv
package_wheel=$(find "$project_dir/wheelhouse" -maxdepth 1 -type f -name 'fuel_telemetry_edge-*.whl' 2>/dev/null | sort -V | tail -n 1 || true)
if [ -n "$package_wheel" ]; then
    echo "Instalando paquete Edge offline: $(basename "$package_wheel")"
    /opt/fuel-edge/venv/bin/pip install --no-index --no-deps --force-reinstall "$package_wheel"
    /opt/fuel-edge/venv/bin/pip check
else
    /opt/fuel-edge/venv/bin/pip install --no-build-isolation "$project_dir"
fi
# No instalar Type=notify con un wheel antiguo que no emita READY/WATCHDOG.
/opt/fuel-edge/venv/bin/fuel-edge --help >/dev/null
/opt/fuel-edge/venv/bin/python -c \
    'from fuel_edge.systemd_notify import SystemdNotifier' >/dev/null
/opt/fuel-edge/venv/bin/python -m fuel_edge.power_events \
    --database /var/lib/fuel-edge/edge.db init >/dev/null
if [ ! -e /etc/fuel-edge/config.toml ]; then
    install -m 0600 "$project_dir/config/fuel-edge.toml" /etc/fuel-edge/config.toml
else
    echo "Se conservó /etc/fuel-edge/config.toml existente."
fi
if [ ! -e /etc/fuel-edge/validator-registry.example.toml ]; then
    install -m 0600 "$project_dir/config/validator-registry.example.toml" /etc/fuel-edge/validator-registry.example.toml
fi
if [ ! -e /etc/fuel-edge/equipment-registry.example.toml ]; then
    install -m 0600 "$project_dir/config/equipment-registry.example.toml" /etc/fuel-edge/equipment-registry.example.toml
fi
install -m 0644 "$project_dir/deploy/systemd/fuel-edge.service" /etc/systemd/system/fuel-edge.service
install -m 0644 "$project_dir/deploy/systemd/fuel-equipment-enrollment.service" /etc/systemd/system/fuel-equipment-enrollment.service
install -m 0644 "$project_dir/deploy/systemd/fuel-validator-ota.service" /etc/systemd/system/fuel-validator-ota.service
install -d -m 0755 /etc/systemd/system/mosquitto.service.d
install -m 0644 "$project_dir/deploy/systemd/mosquitto-fuel-edge.conf" \
    /etc/systemd/system/mosquitto.service.d/fuel-edge-recovery.conf
install -d -m 0755 /etc/rpishutdown/hooks
install -m 0755 "$project_dir/deploy/rpishutdown/pre-poweroff" \
    /etc/rpishutdown/hooks/pre-poweroff
systemctl daemon-reload

# La unidad debe quedar verificable antes de cambiar servicios.
if systemctl cat mosquitto.service >/dev/null 2>&1 && \
   command -v systemd-analyze >/dev/null 2>&1; then
    systemd-analyze verify /etc/systemd/system/fuel-edge.service
fi

if [ -f /etc/fuel-edge/equipment-registry.toml ] && [ -f /etc/fuel-edge/web-sensor.key ]; then
    systemctl enable --now fuel-equipment-enrollment
fi
if [ -f /etc/mosquitto/tls/broker.crt ] && [ -f /etc/mosquitto/tls/broker.key ] && [ -f /etc/mosquitto/tls/ca.crt ]; then
    systemctl enable --now fuel-validator-ota
fi

echo "Instalado con el servicio aún detenido."
echo "Valida: /opt/fuel-edge/venv/bin/fuel-edge validate-config --config /etc/fuel-edge/config.toml"
echo "Habilita después de comprobar el cableado: systemctl enable --now fuel-edge"
