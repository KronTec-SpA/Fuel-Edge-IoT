# Checks de estado centrados — web 1.9.25

Desplegado en `fueledge` el 9 de septiembre de 2026, 11:38:20–11:38:23 UTC
(08:38 America/Santiago).

Los checks de Estado del punto y PLC/Validador/RFID/K24 usan el mismo SVG
centrado, sin depender de la línea base de una fuente. El punto de estado sin
confirmar también queda centrado. Se mantienen tamaños, colores y disposición.
El contenedor circular no se comprime al reducir el ancho disponible.

Verificación visual con el JSX real y estilos de la pantalla en una vista local
aislada: tamaño normal, ampliación 200 % y tarjeta de 340 px. Build, TypeScript,
lint y 121 pruebas web aprobadas. No se añadieron pruebas para este ajuste visual.

En copia de producción se comprobaron suministro eléctrico (1, 7 y 30 días),
historial, balance y cierre de adopción. Conservados 64 movimientos, 27 alertas
y 6 eventos eléctricos. Cuatro servicios activos; controlador sin reiniciar.
Configuración y credenciales conservadas.

Producción responde HTTP 200 y sirve exactamente los archivos locales validados:

- `/_next/static/chunks/page-BC53yumk.js`
- `/_next/static/css/index.Dgxz7imy.css`

Release: `/opt/fuel-edge-web/releases/20260909-v1.9.25-checkmarks`.
Anterior: `/opt/fuel-edge-web/releases/20260909-v1.9.24-adopcion`.
Respaldo: `/var/backups/fuel-edge/20260909-v1.9.25-checkmarks`.
Paquete y huellas: `outputs/releases/checkmarks-20260909/manifest.json`.
