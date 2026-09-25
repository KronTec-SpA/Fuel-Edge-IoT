# Calibración de terreno · Kingspan instalado · 9 de septiembre de 2026

**Overflow: 1220 mm = 2662 L = 100 %.** Esta es la corrección final del operador;
sustituye la referencia anterior de 1230 mm. No se agregó una meseta 1220–1230.

| Altura OCIO (mm) | Entregado por Copec (L) | Inventario total (L) |
|---:|---:|---:|
|440|0|869|
|510|200|1069|
|580|400|1269|
|660|600|1469|
|730|800|1669|
|810|1000|1869|
|890|1200|2069|
|970|1400|2269|
|1070|1600|2469|
|1220|1793|2662|

Los 869 L iniciales proceden de interpolar la tabla Kingspan a 440 mm. Los
1793 L añadidos corresponden al medidor del surtidor, recepción COPEC ya
registrada y aprobada, referencia 45890930. No se crea otra recepción.
Se corrigen únicamente los niveles asociados a ese registro: 869 → 2662 L,
conservando el volumen entregado, su fecha, documento y trazabilidad.

## Conversión

Referencia inicial: ADC 1169, **2,8547008547 V = 440 mm**.
Referencia de overflow: ADC 3329, **8,1294261294 V = 1220 mm**.
La segunda referencia es la mediana de las señales aceptadas por el filtro en
la captura de 17:24:16 UTC (14:24:16 de Chile); no el pico neumático.
La captura conserva las muestras crudas y los valores aceptados.

`h = 17,8611111111 + 147,875 × U`, con U en voltios y h en milímetros.

Tras filtrar los ciclos de presión, se reproduce el escalón de 10 mm del OCIO:
`h_OCIO = 10 × floor(h / 10 + 0,5)`.
No se redondea ni se recorta la señal antes del filtro temporal. El ruido
subescalón alrededor de 1220 mm mantiene 2662 L; una señal sostenida de 1225 mm
o superior queda fuera del dominio de calibración, sin inventar litros.

Entre dos filas consecutivas `(h0,V0)` y `(h1,V1)`:

`V(h) = V0 + (V1 − V0) × (h − h0) / (h1 − h0)`.

El porcentaje mostrado es `100 × V / 2662`. La señal eléctrica del convertidor
sigue configurada en 0–9,8 V; el overflow a 8,129 V es una referencia física,
no un cambio del fondo eléctrico. El OCIO mantiene forma C, dimensiones
1300 × 1000 × 1000 mm y salida lineal de altura, como confirmó el operador.

## Alcance y continuidad del inventario

- Desde 440 hasta 1220 mm se usa la tabla de terreno completa de diez puntos.
- Bajo 440 mm se conservan los puntos originales Kingspan (135, 225, 310,
  385 mm) unidos al punto de 440 mm; ese sector no fue aforado en esta carga.
- No se extrapola bajo 135 mm. La tabla original del fabricante sigue intacta
  en el código y tiene una identidad distinta de la curva de terreno.
- Los extremos eléctricos se ajustaron con dos referencias; faltan voltajes
  emparejados con cada punto intermedio para verificar también esa linealidad.
- 2662 L es la capacidad operativa a overflow informada para este estanque.
  No implica que los 2662 L hayan sido medidos desde vacío: el total hereda la
  incertidumbre de los 869 L iniciales y del surtidor. Frente a 2500 L nominales
  son +6,48 %, por lo que no se presenta como una diferencia de ±1 %.
- El cambio crea una nueva época de calibración y de cuadratura; no una carga
  ficticia ni una pérdida. Se conserva el contador K24 y el historial.
- El inventario de arranque se confirma con lecturas reales filtradas a lleno.
  La recepción anterior al nuevo inventario inicial no vuelve a sumarse.
- Se mantienen el filtro temporal de 120 s, la comprobación de 15 s sin
  excursiones y las bandas existentes en litros. Los saltos entre escalones
  conservan su incertidumbre en la cuadratura. A 440–510 mm, 10 mm equivalen
  a 28,57 L: la resolución no garantiza detectar cada extracción aislada de
  20 L. La vigilancia de diferencias acumuladas continúa activa.
- Se conserva la fecha de calibración física y el mantenimiento configurado
  actualmente por el usuario (180 días); esto es una consolidación de software.

Implementación: `fm2500_field_20260909`, edge 0.3.23, web 1.9.26.
El resultado real de despliegue y sus verificaciones se registra por separado.
