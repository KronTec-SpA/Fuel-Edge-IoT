# Registro de calibración del OCIO

En **Sistema → Estado del sistema → Calibración del OCIO**, el administrador puede registrar la calibración efectuada en terreno mediante **Calibrado**. Frecuencia inicial acordada: **365 días**, editable entre 1 y 730 días. No es una periodicidad atribuida al fabricante.

El registro conserva fecha, responsable, configuración de la señal y próxima fecha. El contador se calcula desde la fecha persistida y no se reinicia al recargar la página. Al vencer, muestra **Calibración vencida**, sin desactivar automáticamente la medición ni las alarmas. Cambiar el intervalo no certifica otra calibración.

La pantalla muestra **Esperando PLC** hasta recibir su acuse durable. El controlador aplica la confirmación con la bomba en reposo, guarda el certificado en SQLite y reinicia la ventana del filtro para validar muestras posteriores al ajuste. Después de un reinicio reconoce el certificado si la configuración eléctrica y la conversión de nivel coinciden; si cambian, exige nueva calibración.

El archivo `/etc/fuel-edge/config.toml` conserva `ocio_calibration_pending=true` como estado inicial. Un certificado compatible en la base del PLC prevalece sobre ese valor; no requiere escribir el archivo protegido ni reiniciar el servicio para confirmar. **No cambiar manualmente el archivo para simular la calibración.**

Cada confirmación inicia una nueva referencia de cuadratura. La referencia anterior se archiva con todas sus muestras y estados de alarma; no se interpreta el salto del ajuste como una recepción o pérdida. El total físico de pulsos K24 permanece intacto. Las muestras encoladas con la calibración anterior no sustituyen la nueva referencia. Una recalibración requiere revisar las diferencias pendientes del ciclo anterior; no acredita que esas diferencias estén resueltas.

La confirmación y su acuse se guardan en una sola transacción en el PLC. El acuse viaja por la cola web existente y se reintenta ante errores de conexión o escritura; las respuestas duplicadas son idempotentes. En la web, archivo de referencia, historial y estado confirmado también se actualizan atómicamente.

La nueva tarjeta utiliza columnas adaptables, controles de al menos 42 px y fecha del fundo (`America/Santiago`). Se retiró el recuadro redundante «Conectividad del validador · en vivo»; los indicadores individuales permanecen.

Verificación: pruebas de aplicación en reposo, reinicio, cambio de configuración, duplicados, autorización, falla de escritura y reversión, conservación de K24/cuadratura, migración SQLite, contador y QA visual de escritorio/pantalla estrecha. El flujo del botón se probó únicamente con una base local desechable y un PLC simulado. La calibración física de producción permanece pendiente hasta la visita.
