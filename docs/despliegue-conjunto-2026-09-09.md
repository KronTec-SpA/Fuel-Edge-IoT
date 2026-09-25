# Despliegue conjunto: horarios, volúmenes y calibración

Instalado por SSH sobre Tailscale en `fueledge`: **edge 0.3.22 / web 1.9.19**.
Activación del 9 de septiembre de 2026, **02:42:55–02:43:03 UTC**
(8 de septiembre, **23:42:55–23:43:03 America/Santiago**).

Incluye la presentación común de fechas desde UTC en America/Santiago,
volúmenes a un decimal y confirmación durable de calibración OCIO con historial
e intervalo inicial de 365 días. Tres tareas coordinaron el cierre; el paquete
se congeló antes de transferir y una revisión independiente verificó la recuperación.

## Validación

- 342 pruebas Python y 107 pruebas web aprobadas; tipos y compilación correctos.
- Revisión visual de escritorio y ancho reducido; flujo de calibración probado
  únicamente en una base local desechable.
- Dos pruebas simuladas del instalador: timeout al detener servicios y error
  al reiniciar. La recuperación informa fallo si no verifica servicios sanos.
- Huella del paquete comprobada localmente y después de transferir por Tailscale.
- Migración en copias: 64 movimientos conservados, integridad y claves foráneas correctas.
- Activación sólo tras comprobar relé abierto, estado locked, K24 saludable y
  ausencia de despachos, pruebas de bomba o sesiones manuales activos.
- Verificación final: fuel-edge, fuel-edge-web, fuel-equipment-enrollment y
  fuel-validator-ota activos; HTTP correcto; validador conectado; NTP sincronizado.
- Ambas bases con `PRAGMA quick_check = ok`; 64 movimientos anteriores conservados.
- Configuración productiva conservada sin cambios. Calibración: intervalo 365,
  revisión 0, sin confirmación ni certificado, reporte PLC pendiente y fresco.
  La calidad de nivel permanece `calibration_pending`.

**No se confirmó la calibración física ni se accionó la bomba como prueba.**

## Respaldo y recuperación

Respaldo root: `/var/backups/fuel-edge/20260909-calibracion-conjunta`.
Contiene copias SQLite antes de preparar y antes de activar, configuración,
hook UPS y metadatos con los enlaces anteriores.

Versiones instaladas:

- `/opt/fuel-edge/releases/20260909-calibracion-conjunta/venv`
- `/opt/fuel-edge-web/releases/20260909-calibracion-conjunta`

Versiones anteriores conservadas:

- `/opt/fuel-edge/releases/0.3.21-alarmas-20260908/venv`
- `/opt/fuel-edge-web/releases/20260908-v1.9.18-alarmas`

El instalador restaura los ejecutables si falla la activación, conservando las
bases activas y la configuración. No restaura automáticamente bases antiguas
que pudieran eliminar movimientos posteriores.

Paquete: `outputs/releases/calibracion-20260909/manifest.json`.
SHA-256 del bundle: `535a6cd31135493176580bd371aee9459a72b0b92155f47a28d8292fc48f39fb`.
SHA-256 de configuración conservada: `5d8b8681031ea84dc04affa9fa7c8afd4931b31df59c97c6cf39c958d2815bf1`.

El seguimiento automático de espera quedó pausado al asumir este despliegue.
