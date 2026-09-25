# Cierre de adopción y limpieza de Sistema — web 1.9.24

Instalado en `fueledge` el 9 de septiembre de 2026, 11:33:19–11:33:21 UTC
(08:33 America/Santiago). HTTP 200 y recurso del navegador verificado por SHA-256.
Antes se activó 1.9.23 a las 11:28 UTC para retirar «Ajustes propuestos».

## Correcciones

- Desactivar desde Sistema cancela las ventanas asistidas programadas o activas
  en la misma transacción que restaura `full`. La reconciliación existente del
  controlador recibe la ausencia de ventana y cierra su segmento.
- Una solicitud tardía de sesión o revisión ya no puede reabrir la adopción:
  la creación comprueba el programa en el INSERT; las políticas usan revisión
  esperada. El refresco de pantalla tampoco acepta revisiones anteriores.
- Las actividades manuales independientes no reciben etiquetas de aprendizaje.
  Un período asistido cerrado no se muestra como último período manual.
- La pantalla informa desactivación pendiente hasta confirmar la revisión y la
  política completa mediante telemetría de menos de 30 segundos. No promete
  aplicación inmediata si el controlador aún no recibió el cambio.
- Se conserva la evidencia de movimientos anteriores. El modo manual
  independiente mantiene su administración separada.

## Validación

- Compilación, TypeScript y lint correctos; 121 pruebas web aprobadas.
- 16 pruebas Python de adopción y modo manual aprobadas, incluyendo cierre
  asistido, limpieza del contexto, rechazo RFID sin equipo tras volver a full,
  nueva carga completa, nuevo segmento manual y política persistida al reiniciar.
- En copia protegida de la base productiva: inicio, sesión asistida activa,
  desactivación, cancelación durable y rechazo de nuevas sesiones asistidas.
- Suministro eléctrico: rangos 1, 7 y 30 días correctos; 0, 2 y 6 eventos;
  interrupciones acumuladas 0, 1869 y 15771 segundos respectivamente.
- Conservados 64 movimientos, 27 alertas y 6 eventos eléctricos; integridad y
  claves foráneas correctas. Consultas de historial, máquinas y balance correctas.
- Cuatro servicios activos. El controlador no se reinició
  (`ExecMainStartTimestampMonotonic=448899344179`). Configuración y credenciales
  conservaron sus huellas. Las pruebas de escritura se hicieron en copias y
  simulación; no se activó adopción ni se accionó la bomba como prueba en vivo.

## Paquete y recuperación

- Release: `/opt/fuel-edge-web/releases/20260909-v1.9.24-adopcion`.
- Anterior: `/opt/fuel-edge-web/releases/20260909-v1.9.23-sistema`.
- Respaldo: `/var/backups/fuel-edge/20260909-v1.9.24-adopcion`.
- Manifest local: `outputs/releases/adopcion-cierre-20260909/manifest.json`.
- Recurso servido: `/_next/static/chunks/page-DnhPTtMZ.js`.
- SHA-256 del recurso: `540d992a90713a697eb4c5103d138c9f9c626cd1892a9c7be7b005bfba979bd0`.

El instalador prepara y activa sólo la web, con retorno automático a los
ejecutables anteriores si falla la verificación. No restaura una base antigua
que pudiera eliminar movimientos posteriores. No hay migraciones nuevas.
