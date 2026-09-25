# Suministro eléctrico: web 1.9.20

Actualizado por SSH sobre Tailscale en `fueledge` (`100.107.8.88`). Activación
del 9 de septiembre de 2026, **07:02:03–07:02:05 America/Santiago**
(`10:02:03–10:02:05 UTC`). Sólo se reinició `fuel-edge-web`; el proceso de control
conservó su hora de arranque y la configuración productiva.

## Cambios

- Resumen por corte con el estilo oscuro de los gráficos del sistema: inicio,
  recuperación, duración, origen y clasificación. Disponible con cursor, foco de
  teclado y toque; Escape lo descarta. Se eliminó el tooltip nativo.
- La flecha restablece 30 días y actualiza la consulta, con indicador de carga y
  fecha de actualización. Pulsar el período activo también consulta de nuevo.
  Las respuestas antiguas se cancelan y no reemplazan el período seleccionado.
- Resumen de cortes, tiempo de interrupción, corte más largo y recuperación.
  Los totales recortan los eventos al período y no duplican intervalos superpuestos.
  El detalle conserva la duración completa de cada registro.
- Se distingue el reporte del PLC de la confirmación de suministro. El tramo gris
  significa ausencia de cortes registrados. No se infiere disponibilidad del
  100 %, voltaje, frecuencia ni calidad de energía. La duración registrada puede
  incluir el arranque del PLC.
- Clasificación persistente de alertas eléctricas: **Corte programado**,
  **Corte no programado** y **Falla interna de instalación**. Es posible dejarla
  pendiente durante la investigación; es obligatoria al resolver la alerta.
  Cada seguimiento guarda la clasificación, que se conserva al reabrir. El PLC
  no sobrescribe una clasificación humana al reenviar el evento.
- Los eventos con alerta vinculada permiten abrirla desde el historial. Los
  registros antiguos sin vínculo no reciben una clasificación inventada.
- Corrección de una actualización de referencia durante render en el panel de
  calibración, detectada por lint; ahora se sincroniza en un efecto.

## Validación

- **113 pruebas web aprobadas**, compilación, TypeScript y lint correctos.
- Pruebas del componente con respuestas HTTP controladas: cambio rápido de rango,
  respuesta atrasada, período ya activo, reset, error/reintento, cursor, teclado
  y toque. No se hicieron capturas ni pruebas físicas de suministro.
- Inicio local del paquete y respuesta HTTP 200.
- Migración y consultas autenticadas de 1, 7 y 30 días sobre una **copia desechable
  de la base productiva**, conservando 64 movimientos, 27 alertas y seis cortes.
  Integridad y claves foráneas correctas. Las credenciales de esa prueba sólo
  existieron en la copia.
- Verificación productiva del enlace de versión, servicios activos, integridad
  SQLite, registros anteriores y configuración. El archivo JavaScript servido
  por HTTP coincidió byte por byte con el paquete instalado y contiene V.1.9.20.

## Respaldo

- Nueva versión: `/opt/fuel-edge-web/releases/20260909-v1.9.20-suministro`.
- Anterior: `/opt/fuel-edge-web/releases/20260909-calibracion-conjunta`.
- Respaldo root: `/var/backups/fuel-edge/20260909-v1.9.20-suministro`.
- Paquete y verificador: `outputs/releases/suministro-20260909/manifest.json`.
- SHA-256 del paquete web:
  `21b0ec960486bbf0df70b15ffe5e9cefd42c7ee18fb82acc23e859a18faa6c35`.

La migración 0036 agrega dos columnas opcionales a alertas y seguimientos. La
recuperación del instalador vuelve a los ejecutables anteriores y verifica la
salud de los servicios; conserva la base actual para no perder eventos posteriores.
