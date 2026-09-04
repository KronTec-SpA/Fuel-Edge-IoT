#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
    echo "Ejecuta este instalador como root." >&2
    exit 1
fi
for command_name in node pnpm; do
    if ! command -v "$command_name" >/dev/null 2>&1; then
        echo "Falta $command_name. Instala Node.js 22 y pnpm antes de continuar." >&2
        exit 1
    fi
done

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
release_id=$(date -u +%Y%m%dT%H%M%SZ)
release_dir="/opt/fuel-edge-web/releases/$release_id"

if ! id fuel-edge-web >/dev/null 2>&1; then
    useradd --system --home /var/lib/fuel-edge-web --shell /usr/sbin/nologin fuel-edge-web
fi
install -d -m 0755 /opt/fuel-edge-web/releases "$release_dir"
for entry in .openai build app db drizzle public runtime worker package.json pnpm-lock.yaml pnpm-workspace.yaml \
    cloudflare-env.d.ts drizzle.config.ts eslint.config.mjs next-env.d.ts next.config.ts \
    postcss.config.mjs tsconfig.json vite.config.ts; do
    cp -a "$project_dir/web/$entry" "$release_dir/"
done

cd "$release_dir"
pnpm install --frozen-lockfile
pnpm build
chown -R fuel-edge-web:fuel-edge-web "$release_dir"
ln -sfn "$release_dir" /opt/fuel-edge-web/current.new
mv -Tf /opt/fuel-edge-web/current.new /opt/fuel-edge-web/current
install -m 0644 "$project_dir/deploy/systemd/fuel-edge-web.service" /etc/systemd/system/fuel-edge-web.service
install -m 0644 "$project_dir/deploy/systemd/fuel-equipment-enrollment.service" /etc/systemd/system/fuel-equipment-enrollment.service
systemctl daemon-reload

if [ -f /etc/fuel-edge/web-auth.env ] && [ -f /etc/fuel-edge/web-sensor.key ]; then
    systemctl enable fuel-edge-web
    systemctl restart fuel-edge-web
    if [ -f /etc/fuel-edge/equipment-registry.toml ]; then
        systemctl enable fuel-equipment-enrollment
        systemctl restart fuel-equipment-enrollment
        echo "Servicio de enrolamiento MIM/XIAO instalado y activo."
    fi
    echo "Aplicativo web instalado y activo sólo en 127.0.0.1:8080."
else
    echo "Aplicativo instalado, aún detenido: provisiona web-auth.env y web-sensor.key." >&2
fi
