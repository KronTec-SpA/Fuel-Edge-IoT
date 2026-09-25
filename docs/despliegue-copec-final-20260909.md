# Kickoff productivo · tabla Copec · 09/09/2026

Despliegue activo por Tailscale, edge **0.3.23**, web **1.9.26**.
Verificación productiva: **14:35:59, hora de Chile** (17:35:59 UTC).

- Overflow confirmado: **1220 mm = 2662 L = 100 %**.
- Referencia de señal filtrada a lleno: **8,129426129 V**, ADC 3329.
- Se aplican los diez puntos completos del aforo incremental; la corrección
  final de 1220 mm sustituye la referencia previa de 1230 mm.
- Inventario esperado **2662 L**, medido **2662 L**, diferencia **0 L**.
- Ancla de cuadratura: `balance-b65b9e09-c186-4736-b4cb-9b913487bd1d`.
- K24 conserva **4229 pulsos**, factor **90 pulsos/L**.
- La recepción COPEC **45890930** sigue aprobada por **1793 L**. Sus niveles
  asociados se corrigieron de 1365 → 2500 L a **869 → 2662 L**, con revisión
  auditable. Existe una sola recepción de ese documento; no se duplicó.
- Los **66 movimientos** anteriores conservaron identificador, volumen y
  estado de revisión. No aparecieron movimientos nuevos por cambiar la curva.
- Calibración efectiva, revisión 3, confirmada por el PLC; no pendiente.
  Se conservó la fecha de visita física y el mantenimiento que estaba
  configurado: 180 días, próxima fecha 08/03/2027.
- Los cuatro servicios permanecen activos; SQLite pasa integridad y claves
  foráneas. Se preservaron también los cambios visuales de la versión 1.9.25.

## Validación

**350 pruebas Python y 123 pruebas web**, TypeScript y compilación web correctos.
Las pruebas incluyen los diez puntos, ruido cerca del overflow, escalones de
10 mm después del filtro, pulsos de presión de 15 s, caída persistente,
migración de capacidad y ausencia de recepción ficticia por recalibración.

Reproducción de **569 muestras reales** capturadas hoy: señal cruda entre
7,995116 y 8,788767 V; las ocho publicaciones filtradas resultaron **2662 L**,
sin errores de conversión. Es evidencia de esa ventana observada, no una
garantía para cualquier condición futura del sensor.

En productivo, las primeras 240 muestras tras la calibración sólo produjeron
volúmenes aceptados de 2662 L; las tres lecturas en reposo establecieron el
ancla. La pantalla se revisó visualmente con datos de prueba equivalentes:
**100,0 % · 2.662,0 L de 2.662,0 L**, sin recortes ni desbordes.

## Respaldo y detalle

Respaldo remoto: `/var/backups/fuel-edge/20260909-copec-final`.
Contiene bases previas, configuración anterior, operación de calibración,
captura de señal, hashes y verificación. El cierre añade el evento auditable
`copec_kickoff_verified`, sin fabricar lecturas ni despachos.

La curva y sus límites metrológicos están descritos en
[calibracion-final-copec-20260909.md](calibracion-final-copec-20260909.md).
La lectura completa de producción está en
[verificacion-kickoff-copec-20260909.json](verificacion-kickoff-copec-20260909.json).
