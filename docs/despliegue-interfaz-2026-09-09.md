# Interfaz y textos: web 1.9.21

Desplegada por SSH sobre Tailscale en `fueledge` (`100.107.8.88`). Activación
del 9 de septiembre de 2026, **07:41:45–07:41:48 America/Santiago**
(`10:41:45–10:41:48 UTC`). Sólo se reinició `fuel-edge-web`.

## Cambios

- Eje, guías y barras del resumen semanal con la misma área de trazado.
- Acceso al histórico desde el resumen semanal e ícono de tractor en la pestaña
  Por máquina.
- Indicador del estanque con carcasa, apoyos y visor de nivel; variante compacta
  en el histórico. Conserva los estados sin lectura y las variaciones observadas.
- Escala tipográfica común, indicadores de tamaño intermedio y espacios ajustados.
- Eliminación de subtítulos genéricos y notas redundantes; se mantienen fechas,
  referencias, fuentes de medición, estados e instrucciones operativas necesarias.
- Cuadratura acumulada retirada del histórico y disponible en Sistema para el
  administrador del proveedor, bajo la condición existente de mantenimiento maestro.
- Novedades y número de versión actualizados.

## Verificación

- Compilación, TypeScript, lint y **113 pruebas web** correctos.
- Paquete y scripts verificados por SHA-256 antes de preparar y activar.
- Dependencias, runtime y migraciones SQL idénticos a la versión anterior.
  La comparación excluye archivos auxiliares `._` de macOS presentes en el paquete
  anterior; éstos explicaron una primera preparación detenida antes de la activación.
- Consultas autenticadas de histórico, máquinas, cuadratura y suministro de 1, 7
  y 30 días verificadas sobre una copia desechable de la base productiva.
- Conservados los 64 movimientos, 27 alertas y seis cortes de la copia.
- Integridad SQLite y claves foráneas correctas antes y después de activar.
- Los servicios web, control, enrolamiento y OTA permanecen activos. La hora de
  arranque del controlador no cambió; su telemetría siguió vigente.
- Configuración y credenciales productivas conservadas byte por byte.
- Respuesta HTTP 200; archivo JavaScript servido idéntico al paquete y con V.1.9.21.
- Acceso por Tailscale desde el Mac confirmado en `http://100.107.8.88/`.

No se aplicaron migraciones ni se enviaron órdenes a la bomba.

## Respaldo y recuperación

- Versión: `/opt/fuel-edge-web/releases/20260909-v1.9.21-interfaz`.
- Anterior: `/opt/fuel-edge-web/releases/20260909-v1.9.20-suministro`.
- Respaldo: `/var/backups/fuel-edge/20260909-v1.9.21-interfaz`.
- Paquete y scripts: `outputs/releases/interfaz-20260909/manifest.json`.
- SHA-256 del paquete web:
  `05c53d3f4aeddb666c03be4148b50683009f0997eeacbb611afc0c67ec1b91dd`.

El instalador conserva copias SQLite anteriores a la preparación y a la activación,
además de la configuración y el entorno de autenticación bajo permisos root.
Ante un fallo de activación restaura el enlace a los ejecutables anteriores,
reinicia sólo la web y comprueba su salud, conservando la base activa para no
perder registros posteriores.
