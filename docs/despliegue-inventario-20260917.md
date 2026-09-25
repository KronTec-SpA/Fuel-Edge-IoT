# Detección de pérdidas y cuadratura: producción del 17 de septiembre de 2026

La política `inventory-evidence-v2` está activa en el RPi de Fundo Santa Isabel, con edge **0.3.26** y web **1.9.29**. La activación comenzó a las 15:21:26 y finalizó a las 15:22:48, hora de Chile. El operador autorizó implementar y desplegar después de validar, y resolver todas las alertas pendientes tituladas «Verificación de inventario pendiente».

## Problema corregido

El diagnóstico encontró 185 avisos de espera dentro del período examinado. Todos tuvieron después una comprobación compatible con el margen de los instrumentos. La espera de cinco minutos era demasiado sensible a la estabilización de la señal; además, se evaluaba el vencimiento antes de procesar la lectura que podía completar la comprobación en ese mismo ciclo.

Los registros de medición y las comprobaciones se conservan. El cliente recibe una alarma cuando hay evidencia persistente de un descenso no explicado. Una demora de medición se presenta como estado técnico de la cuadratura.

## Política implementada

- **Comparaciones:** referencia fija de inventario, ventana anterior al descenso y ventanas comparables de hace 1, 3 y 7 días. Se descuentan consumos K24 y se incorporan recepciones conciliadas. Los días se calculan en `America/Santiago`, con tolerancia horaria de ±3 horas para buscar una referencia disponible.
- **Holgura conservadora:** se mantienen los márgenes OCIO/K24 y la envolvente completa de las lecturas. Una mediana no se trata como una medición más precisa. Los umbrales siguientes se aplican al faltante mínimo que queda **después** de esa holgura, no a la diferencia bruta de litros.
- **Pérdida grande:** faltante residual de al menos 100 L en tres publicaciones distintas que abarquen al menos dos minutos; ninguna separación entre publicaciones supera tres minutos. Esta vía compara con la referencia fija.
- **Descenso persistente o acumulado:** faltante residual de al menos 20 L en dos ventanas independientes, separadas al menos nueve minutos y no más de veinte. La lectura actual también debe sostener el descenso.
- **Ventanas válidas:** bloques de diez minutos, con al menos cinco publicaciones que abarquen cuatro minutos, sin separaciones superiores a tres minutos. Se exige reposo del contador, K24 saludable y coincidencia de referencia, calibración y factor de pulsos. Una recepción dentro de la ventana impide usarla como referencia de reposo.
- **Un incidente por pérdida persistente:** se actualiza la misma alerta cuando aumenta la evidencia. Se respeta el cierre humano. Una nueva agravación de al menos 100 L residuales respecto del máximo revisado puede generar un nuevo incidente. Una hora de evidencia compatible permite considerar recuperada la condición, sin cerrar automáticamente la alerta del operador.
- **Salud de medición separada:** después de quince minutos sin poder verificar se mantiene una condición técnica agrupada, con recuperación tras una hora de comprobaciones válidas. No se crean alertas repetidas de posible robo por cada vencimiento.

La evaluación ocurre en el servicio web local del RPi al recibir evidencia. Consultar el panel no crea alarmas. El monitor edge conserva las comprobaciones originales y publica salud de medición cada minuto. Los reintentos conservan identificadores y no duplican incidentes. Un retroceso del contador o una calibración incompatible impiden confirmar pérdidas con esa evidencia.

El panel diferencia «Cuadratura en actualización», «Diferencia en observación» y una pérdida persistente confirmada por el criterio. La alerta se llama «Descenso de inventario no explicado»: requiere revisión y no certifica un robo.

## Validación

| Comprobación | Resultado |
| --- | --- |
| Suite Python | 360 pruebas aprobadas |
| Suite web | 139 pruebas aprobadas |
| TypeScript, lint de archivos modificados y compilación web | Aprobados |
| Reproducción de 7.130 publicaciones históricas | 0 alarmas nuevas; 670 ventanas válidas |
| Inyección de descenso de 300 L sobre las publicaciones históricas | 1 incidente; primera alerta aproximadamente 2,03 minutos después de la primera publicación afectada |
| Inyección de escalones de 40 L diarios | 1 incidente; detección acumulada aproximadamente 52,66 horas después del primer escalón |
| Inyección aislada de 20 L | 0 alarmas: permanece dentro de la incertidumbre |
| Ensayo de migración sobre copia de la base del RPi | 72 movimientos, una referencia y 7.454 muestras conservados; 700 ventanas históricas creadas sin alarmas retrospectivas |

La reproducción opera sobre publicaciones ya filtradas: no simula la respuesta física del sensor ni el tiempo previo de estabilización. No hay robos reales etiquetados en el histórico. Estos resultados no garantizan ausencia de falsas alarmas futuras ni detección de extracciones pequeñas dentro del margen instrumental.

## Cierre auditado de alertas

Se resolvieron **189 alertas**: las 185 identificadas inicialmente y otras cuatro pendientes del mismo tipo. Cada una recibió un comentario identificado como mantenimiento autorizado y quedó con estado `resolved`. La revisión final posterior al despliegue encontró **cero pendientes** de ese título.

Texto base: «Calibración de escala de alarma: umbral de espera demasiado sensible. Cierre administrativo autorizado por el operador». El comentario identifica la comprobación posterior compatible cuando existe; cuando no existe, lo declara expresamente. También deja constancia de que se conserva la evidencia y el cierre no certifica ausencia de pérdidas. Los avisos de otros tipos conservaron su estado.

Se respaldaron los registros y comentarios originales antes de cada transacción en `/var/backups/fuel-edge/20260917-alarm-sensitivity-185/`.

## Despliegue y recuperación

Release: `20260917-inventory-evidence`. Se verificaron bomba detenida, relé desenergizado, ausencia de sesiones activas, reloj sincronizado y contador saludable antes de detener servicios. Se preservaron configuración, calibración, referencia fija, pulsos acumulados, movimientos y cierres previos. Las bases pasaron `quick_check`; la base web también pasó la revisión de claves foráneas.

Respaldo del despliegue: `/var/backups/fuel-edge/20260917-inventory-evidence/`. Incluye copias SQLite consistentes tomadas antes de la preparación y justo antes de la activación. Las versiones anteriores permanecen en `20260909-uncertainty`. El procedimiento de recuperación restaura los enlaces de ejecutables y reinicia servicios conservando las bases vivas, para no retroceder contadores ni perder movimientos nuevos.

La inspección del navegador confirmó que la página de acceso responde y muestra V.1.9.29. La sesión del navegador no estaba autenticada; el panel protegido se validó mediante las pruebas de aplicación y sus datos en el RPi.

La comprobación posterior registró una nueva cuadratura de las **15:26:32**, ya procesada por el detector desplegado. El histórico creció a 7.455 muestras y 701 ventanas, con comparaciones disponibles para 1, 3 y 7 días. Los cuatro servicios estaban activos, K24 saludable, contador en 12.210 pulsos y relé desenergizado. El canal nuevo de salud de medición se entregó sin errores ni reintentos. No había incidentes nuevos de pérdida ni alertas de verificación pendientes.

## Evidencias locales

- [Diagnóstico original](../outputs/diagnostico-alarmas-20260917/diagnostico.md).
- [Resultados de reproducción e inyecciones](../outputs/alarma-politica-20260917/replay-resultados.json).
- [Registro de activación](../outputs/alarma-politica-20260917/activacion-rpi.log).
- [Verificación posterior en producción](../outputs/alarma-politica-20260917/verificacion-productivo.json).
- [Cierre inicial de 185 alertas](../outputs/alarma-politica-20260917/cierre-185-resultado.json), [cuatro adicionales](../outputs/alarma-politica-20260917/cierre-adicional-resultado.json) y [revisión final](../outputs/alarma-politica-20260917/cierre-final-resultado.json).

El manifiesto del paquete y los hashes están en `outputs/releases/inventario-20260917/manifest.json`. El workspace contenía trabajo previo sin confirmar; se conservaron esos cambios y no se hizo un commit global.
