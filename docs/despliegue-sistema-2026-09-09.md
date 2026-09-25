# Sistema organizado: web 1.9.22

Activada en `fueledge` por Tailscale (`100.107.8.88`) el 9 de septiembre de 2026,
entre las **08:21:09 y 08:21:11 America/Santiago** (11:21 UTC).

## Cambios publicados

- Estado general con conexión del PLC, habilitación del relé, componentes y fecha
  de reporte. Los datos vencidos no confirman el estado físico actual de la bomba.
- Secciones independientes para diagnóstico, suministro eléctrico, calibración y
  mantenimiento, operación y permisos, y ajustes propuestos.
- Se conservan los paneles funcionales de OCIO, BLE, cuadratura, prueba de bomba,
  puesta en marcha, modo manual y adopción, con sus condiciones de permisos.
- Suministro eléctrico conserva la API productiva, períodos de 24 h/7/30 días,
  actualización, indicadores, gráfico, detalles y clasificación mediante alertas.
- Los ajustes de comunicación, respaldo, protecciones y auditoría son propuestas;
  seleccionarlos no cambia parámetros ni programa tareas en el PLC.

## Verificación

- Compilación, TypeScript, lint y 117 pruebas locales correctos.
- SHA-256 del paquete y scripts verificados antes de preparar y activar.
- Dependencias, runtime y migraciones idénticos a la versión anterior.
- Copia SQLite protegida antes de preparar y otra antes de activar; pruebas
  autenticadas realizadas sobre una copia desechable de la base productiva.
- Suministro: 0 eventos en 24 h, 2 en 7 días y 6 en 30 días, con 0, 1.869 y
  15.771 segundos de corte respectivamente al momento de la consulta.
- Histórico, consumo por máquina y cuadratura respondieron correctamente.
- Conservados los 64 movimientos, 27 alertas y seis cortes de la copia.
- Integridad SQLite y claves foráneas verificadas; registros anteriores conservados
  también después de activar la versión.
- Configuración y credenciales productivas conservadas byte por byte.
- Acceso desde el Mac por Tailscale: HTTP 200 y SHA-256 del JavaScript servido
  idéntico al asset del paquete validado.
- Sólo se reinició `fuel-edge-web`; la hora de arranque del controlador se mantuvo
  en `448899344179` (reloj monotónico). Los cuatro servicios permanecieron activos
  y el reporte del PLC se mantuvo vigente.

## Respaldo y recuperación

- Actual: `/opt/fuel-edge-web/releases/20260909-v1.9.22-sistema`.
- Anterior: `/opt/fuel-edge-web/releases/20260909-v1.9.21-interfaz`.
- Respaldo: `/var/backups/fuel-edge/20260909-v1.9.22-sistema`.
- Paquete y verificadores: `outputs/releases/sistema-20260909/manifest.json`.
- SHA-256 del paquete web:
  `8effa5b68ee0d6e26a19166bad4dd99a32cce9c3d9189e0425cab21ca880b682`.
- Asset principal: `/_next/static/chunks/page-DSW_PpQv.js`.
- SHA-256 del asset:
  `5e2b1adaeee7fd8defb720de86e495cda7b7a7cd2b087888651cc61121388be5`.

El instalador tiene reversión automática a los ejecutables anteriores ante un fallo
de activación, conservando la base activa para no perder registros nuevos. No se
aplicaron migraciones ni se enviaron órdenes a la bomba.
