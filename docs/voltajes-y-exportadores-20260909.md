# Voltajes OCIO, exportadores y prioridad del equipo

Estado: **preparado y validado; activación pendiente de autorización**.
Versión preparada: edge 0.3.25 / web 1.9.28.
Versión activa al preparar: edge 0.3.24 / web 1.9.27.

## Cambios

- Retira «Detalle de la lectura» del resumen y su demostración.
- En Resumen y Cargas, la segunda columna pasa a «Equipo / operador»:
  equipo primero, 18 px; operador debajo, 15 px.
- Conserva los volts medidos en la entrada analógica OCIO del PLC, antes del
  filtro temporal y la conversión a litros. El ADC corresponde a la mediana
  de las adquisiciones del ciclo configurado; no es el voltaje de alimentación.
- El diagnóstico local conserva su ventana de 24 horas. La copia central
  `voltage_readings` conserva todas las observaciones recibidas, con fecha UTC,
  volts, ADC, calidad, sesión, fuente y referencia de calibración cuando existe.
- Envío durable en lotes de 30 muestras; reintentos idempotentes. Las cargas,
  alarmas y el estado actual tienen prioridad sobre la recuperación del histórico.
- Exportador CSV **Voltajes de entrada OCIO**, con precisión de hasta seis
  decimales y lectura del servidor en bloques de 1000 filas.
- Exportador CSV **Litros por máquina**, con litros acumulados, número de cargas,
  promedio y última carga. Agrupa por ID y separa cargas sin máquina identificada;
  excluye recepciones, habilitaciones y despachos pendientes/rechazados.
- La exportación completa JSON pasa a esquema 3 e incluye ambas colecciones.
- La activación encolará los diagnósticos locales todavía disponibles. No se
  fabrican muestras anteriores que ya hayan sido eliminadas.

## Verificación

- Compilación web y TypeScript correctos; 125 pruebas web aprobadas.
- Suite completa del controlador: 357 pruebas Python aprobadas.
- Pruebas de lotes durables, caída de conexión, reapertura de SQLite y prioridad
  del estado actual frente a una cola larga de voltajes.
- Pruebas de duplicados, lotes inválidos, control de acceso, precisión de volts,
  exportación de más de 1000 muestras y agregación de más de 5000 cargas.
- Vista previa local respondió HTTP 200. No se hicieron pruebas del relé.
- Preparación remota exitosa, con respaldos previos y migración sobre copias.
  Se conservaron 66 movimientos, un ancla de inventario y 34 muestras de balance.
  La prueba de calibración se ejecutó únicamente en la copia desechable.

## Preparación en el PLC

Paquete: `outputs/releases/voltajes-20260909/voltajes-bundle.tar.gz`.
SHA-256: `5ca47fccc5f8186caf993519232a965b7619f8bdce28d8da0ff0a24a190db305`.
Huella comprobada también después de la transferencia.

Respaldo y estado: `/var/backups/fuel-edge/20260909-voltajes`.
Instalador: `/tmp/voltajes-release-20260909/deploy-plc.py`.
Configuración preservada: SHA-256
`3c3e9c4240adde748b686ec493e34ca06dd58d292c06b8cd55567901c37d13ff`.

La revisión automática rechazó la fase `activate`: exige autorización explícita
para reiniciar servicios productivos y cambiar los ejecutables activos. Esa fase
no se ejecutó. Después de la autorización, el instalador vuelve a verificar
versión anterior, configuración, estado reciente, relé abierto y ausencia de
sesiones activas. Si no se cumplen, no activa. Si la activación falla, restaura
los ejecutables anteriores conservando las bases activas.

Tras activar, comprobar recepción de muestras nuevas y recuperación del histórico
con `/tmp/verify-voltage-release-20260909.py`, además de integridad SQLite,
conservación de movimientos/calibración y servicios saludables.
