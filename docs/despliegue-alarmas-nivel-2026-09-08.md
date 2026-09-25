# Despliegue de alarmas y nivel — 8 de septiembre de 2026

Actualizado por SSH sobre Tailscale (`rpiplc-tailscale`, host `fueledge`).
Activación: **23:17:39–23:17:53, America/Santiago** (02:17 UTC del 9 de septiembre).
Edge **0.3.21**; web **1.9.18**. No se modificó físicamente el OCIO ni se actuó
la bomba como prueba. El cambio se hizo con el relé abierto, K24 saludable y
sin despachos, pruebas de bomba ni sesiones manuales activos.

## Configuración aplicada

- Tabla `fm2500_manufacturer`, los 14 puntos BFM02500DG del fabricante.
- Salida objetivo `linear_height`, 0–1.300 mm.
- `ocio_calibration_pending = true` hasta ajustar y contrastar el equipo.
- Entrada conservada: I0.2, 0–9,80 V, ADC 4095, mediana de cinco lecturas.
- Filtro temporal activo: 120 s, reposo de 15 s, soporte 80 %, banda equivalente
  máxima de 6,25 L con la tabla.
- K24 conservado en I0.0: **90 pulsos/L**.

El PLC registra ADC, voltios y candidatos de conversión por tabla. Esos
candidatos no se publican como litros confirmados ni alimentan la cuadratura
mientras falta la calibración física. La pantalla conserva la última lectura
histórica con el estado **Calibración pendiente**, sin renovar su fecha.
Las alarmas de flujo K24 y el registro de cortes eléctricos están operativos;
las verificaciones volumétricas requieren confirmar la calibración.

## Verificación

- 335 pruebas Python y 96 pruebas web aprobadas; compilación y tipos aprobados.
- Ambas bases: `PRAGMA quick_check = ok`, antes y después del despliegue.
- Migraciones probadas en copias: **64 movimientos conservados** sin cambios.
- Servicios `fuel-edge`, `fuel-edge-web`, `fuel-equipment-enrollment` y
  `fuel-validator-ota` activos; HTTP local responde correctamente.
- Primeras muestras reales de 2,766789–2,774115 V registradas en diagnóstico.
- Verificación posterior: **210 muestras reales** guardadas, **78 con candidato
  de volumen por tabla después del filtro**. La calidad física sigue marcada
  pendiente; ningún candidato se convirtió en una lectura confirmada.
- Estado `calibration_pending` recibido y persistido por la web.
- Sin nuevas recepciones ni falsas diferencias de volumen por el cambio.
- El reinicio generó un aviso «Validador sin conexión»; el validador ya volvió
  a reportar conectado. Se conserva el aviso para revisión, no se borra.

## Recuperación y trazabilidad

Respaldo local del PLC, protegido para root:
`/var/backups/fuel-edge/20260908-alarmas-nivel`.
Incluye ambas bases antes de preparar y de activar, configuración, hook UPS,
entorno Python anterior y metadatos del despliegue.

Versiones nuevas:

- `/opt/fuel-edge/releases/0.3.21-alarmas-20260908/venv`
- `/opt/fuel-edge-web/releases/20260908-v1.9.18-alarmas`

Las unidades existentes siguen utilizando `/opt/fuel-edge/venv` y
`/opt/fuel-edge-web/current`, ahora enlazados a las versiones nuevas. El hook
UPS carga el código nuevo mediante el mismo enlace del entorno Python.
El despliegue conserva las bases activas al revertir ejecutables: no restaura
automáticamente un respaldo que pueda eliminar movimientos posteriores.

Paquete validado: `outputs/releases/alarmas-nivel-20260908/manifest.json`.
SHA-256 del archivo transferido:
`56e83ba488ebe32df730f5cf4691fd372bb07e76093b4db1b254921608b8d7ab`.

## Calibración del 9 de septiembre

Seguir la [configuración OCIO](configuracion-ocio-tabla-kingspan.md): forma C,
1.300 × 1.000 × 1.000 mm, visor en mm, nivel contrastado físicamente y reinicio
del módulo. Verificar alturas/voltios simultáneos y el cero de la sonda.
Después, cambiar únicamente `ocio_calibration_pending` a `false` en la
configuración vigente y reiniciar el controlador con la bomba en reposo.
Se preparó un archivo `config.ocio1300.PENDING.toml` en el directorio de la
versión como referencia; no copiarlo encima de cambios posteriores de configuración.
La primera referencia confirmada inicia la cuadratura de la nueva calibración.
