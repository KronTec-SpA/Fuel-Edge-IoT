# Referencia de señal aplicada el 9 de septiembre de 2026

Referencia autorizada por el usuario: **2,8547008547 V ↔ 440 mm** indicados en el OCIO. La tabla Kingspan BFM02500DG convierte esa altura en **869,0 litros** por interpolación entre 385 mm / 726 L y 455 mm / 908 L.

La conversión de señal queda:

`h(U) = 440 + (U − 2,8547008547) × 1300 / 9,8`, con `U` en voltios y `h` en milímetros.

Se aplica una corrección de **+61,315192744 mm** conservando la pendiente configurada de 132,653061224 mm/V. Esto vincula exactamente el punto aportado; una sola referencia no permite identificar a la vez pendiente y desplazamiento. La pendiente y la exactitud en otras alturas quedan pendientes de contraste durante la carga controlada. La referencia de altura procede del visor OCIO, no de una medición independiente por varilla.

La tabla del fabricante, los filtros de presión y las bandas de histéresis no cambian. El ajuste usa una nueva identidad de calibración, archiva la cuadratura anterior y evita registrar el salto como recepción o pérdida. Mantiene el total K24 y la fecha de la calibración física. El intervalo de mantenimiento que estaba guardado en producción al aplicar el ajuste era **180 días**; se conservó ese cambio realizado en el sistema.

Activado a las **12:01:06, hora de Chile**, con revisión de calibración **2**. Evidencia: [resultado de aplicación](aplicacion-referencia-ocio-440mm-20260909.json), [primera referencia registrada](referencia-ocio-440mm-20260909.json). Respaldo en el PLC: `/var/backups/fuel-edge/ocio-association-20260909-440mm-v2`.

## Registro para la carga controlada

Registrar un punto antes de comenzar y otro después de cada incremento conocido, con hora exacta y con la señal ya validada tras los ciclos de presión. Si el visor alterna, anotar ambos valores y no elegir un extremo por conveniencia. Los voltios, ADC y calidad se obtienen del diagnóstico del PLC; los litros añadidos deben provenir de una medición independiente del OCIO. El K24 sirve de referencia sólo si el combustible de esa operación pasa por él.

| Punto | Fecha y hora del punto | Litros añadidos acumulados, medidos | OCIO (mm) | Señal PLC (V) | Calidad / observaciones |
|---|---|---:|---:|---:|---|
| Referencia actual | 09-09-2026; ver ventana en la evidencia | No medidos | 440 | 2,854700855 | Referencia de visor autorizada |
| Inicio de la prueba | Por registrar | 0 | Por registrar | Por registrar | Registrar antes de iniciar |
| Incremento 1 | Por registrar | Por registrar | Por registrar | Por registrar | Esperar validación de señal |
| Incremento 2 | Por registrar | Por registrar | Por registrar | Por registrar | Esperar validación de señal |
| Incremento 3 | Por registrar | Por registrar | Por registrar | Por registrar | Esperar validación de señal |

Entre puntos, comparar **litros añadidos medidos** con `V_Kingspan(h_final) − V_Kingspan(h_inicial)`. Esto permite comprobar incrementos de volumen sin asumir que el volumen inicial sea conocido exactamente. Los 869,0 L iniciales provienen de la tabla, no de un aforo independiente. Con varios pares voltios/mm se comprobará también la pendiente de la conversión eléctrica.

Las observaciones de terreno se conservarán separadas de la tabla publicada del fabricante, con su origen y fecha. No convertir una diferencia de ajuste en un movimiento real de combustible.
