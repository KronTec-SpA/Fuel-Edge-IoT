# Sistema: propuesta de interfaz en Sites

El estado general queda separado de suministro eléctrico, calibración y mantenimiento,
operación excepcional y ajustes propuestos. Se mantienen las condiciones de permiso
de calibración, cuadratura, puesta en marcha, adopción y prueba de bomba.

El diagnóstico muestra conexión, habilitación del relé, componentes confirmados y fecha
del último reporte. Con más de 30 segundos sin telemetría, fecha futura o sin datos,
el estado físico de la bomba se presenta como «Sin confirmar». El último valor queda
en el detalle técnico, marcado como histórico. Habilitar el relé no implica flujo medido.

La ruta `/sistema-demo` utiliza datos ficticios y fecha fija. Permite seleccionar siete
escenarios, recorrer la nueva organización y revisar propuestas sin llamadas al PLC.
Los ejemplos de mantenimiento son sólo de consulta; las funciones existentes
siguen disponibles en Sistema dentro de la aplicación autenticada.

Suministro eléctrico reutiliza el componente funcional de la versión local, con una fuente
de datos de ejemplo inyectada: 24 horas, 7 y 30 días, restablecer/actualizar, métricas,
gráfico, detalle de interrupciones y clasificación temporal. La fuente operacional
predeterminada sigue siendo la API existente. La demostración no llama esa API.

## Configuraciones propuestas

- **Comunicación:** aviso a los 60 segundos, escalamiento a los 5 minutos y recuperación
  registrada. Los 30 segundos de vigencia del diagnóstico permanecen independientes.
- **Respaldos:** proponer un respaldo diario a las 02:00, 14 copias diarias y aviso después
  de 24 horas sin respaldo exitoso. Verificar capacidad y restauración antes de implementar.
- **Protecciones de despacho:** consultar y auditar espera de inicio, inactividad K24 y
  pérdida de BLE. Las referencias locales son 60, 40 y 20 segundos; no se consultó la RPi.
- **Registro de configuración:** extender auditoría, valores solicitados y confirmación
  de aplicación por el controlador a los demás ajustes.

La selección de propuestas es temporal y se descarta al cambiar de sección.
No guarda configuraciones ni programa tareas reales.

## Alcance y validación

El checkout de Sites existente está en `tmp/sites-sistema`; conserva su propia identidad
y backend. El manifiesto del proyecto principal apuntaba a un sitio antiguo no disponible
y se dejó intacto. Se recuperó el sitio privado existente desde Sites, sin crear otro.

Los componentes de interfaz compartidos están también en `web/app/system-workspace.*`
y `web/shared/system-health.ts`, integrados con los paneles más recientes del proyecto local.
No se copiaron al sitio cambios previos de backend, bases de datos ni credenciales de terreno.

Validación final: compilación de ambas aplicaciones, TypeScript y lint; 117 pruebas locales
y 76 pruebas en Sites. Render de `/sistema-demo` con HTTP 200 y contenido esperado.
Las pruebas del panel eléctrico ejercitan períodos, restablecimiento, cancelación de respuestas
antiguas, errores, detalle emergente y apertura de clasificación; también verifican que la
fuente de demostración funcione sin acceder a la red.
Sin prueba automatizada de navegador. No se accedió ni desplegó a la Raspberry Pi.

Publicación privada actualizada en Sites, versión 9, el 09/09/2026 a las 11:13 UTC.
Demostración: https://petrosense-iot-petroleo.pedropcoloma.chatgpt.site/sistema-demo
Se dejó abierto Suministro eléctrico en el sitio publicado, con sus seis eventos de ejemplo.
