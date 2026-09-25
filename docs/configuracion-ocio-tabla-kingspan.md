# Configuración OCIO para la tabla Kingspan BFM02500DG

Propuesta del 8 de septiembre de 2026. El usuario solicita habilitar la tabla
en el PLC hoy; el ajuste físico del OCIO queda para el 9 de septiembre.
La configuración usa `ocio_calibration_pending = true`: conserva la adquisición
y los candidatos por tabla en diagnóstico, sin registrarlos como inventario
confirmado. El dashboard indica «Calibración pendiente» sobre la última lectura
histórica. Tras contrastar altura y señal, cambiar esa marca a `false`.

El volumen procede de los 14 puntos del fabricante, con interpolación lineal
entre ellos. La forma rectangular siguiente sirve exclusivamente para transmitir
altura por la salida analógica. No representa la geometría del FuelMaster.

## Valores en el OCIO

| Menú o parámetro | Ajuste propuesto |
|---|---|
| Acceso a configuración | `CANC + ENTER`; PIN: últimas dos cifras del número de serie |
| `UNIT / LEV / VOL` | `MM / L` |
| `TANK / SHAPE` | `C`: rectangular/paralelepípedo |
| `HEIGHT` | **1.300 mm** |
| Ancho `W` | **1.000 mm** |
| Profundidad `D` | **1.000 mm** |
| Indicación habitual | **`LEVEL … MM`** |
| Compresor | Funcionamiento automático |

Los dos lados de 1.000 mm producen una capacidad virtual de 1.300 L. Los
litros y el porcentaje de volumen del visor OCIO ya no representan el contenido
real del FuelMaster: usar su indicación en mm. El dashboard calcula litros con
la tabla Kingspan y porcentaje con la capacidad nominal de 2.500 L.

La altura de 1.300 mm es una escala de transmisión elegida para cubrir el plano
y los puntos publicados, no una nueva medición de la altura útil del estanque.

[Manual PIUSI M0073B, configuración y uso](https://commercialfuelsolutions.co.uk/downloads/manuals/Piusi_Ocio_manual.pdf).

## Calibración física

Usar `CALIBRATION → LEVEL` con la altura medida mediante una varilla fiable,
el mismo combustible y la sonda correctamente apoyada en el fondo. Medir desde
el mismo cero que se usará para la tabla. Introducir la altura realmente medida,
no una altura inferida de los litros que se espera encontrar.

PIUSI indica efectuar esta calibración al menos al 70 % de la altura máxima a
medir. Para la escala propuesta, usar **910 mm o más**, dentro del llenado
permitido del estanque. `LEVEL` calcula la densidad; no sobrescribir después
ese resultado con el valor de fábrica. Como referencia inicial de gasóleo, el
manual usa **0,840 kg/dm³ a 20 °C**; no es una medición del combustible instalado.

[Manual PIUSI M0073B, calibración](https://commercialfuelsolutions.co.uk/downloads/manuals/Piusi_Ocio_manual.pdf).

## Señal y cambio coordinado

El módulo documentado transmite porcentaje de volumen cuando hay una forma
configurada. En un prisma rectangular ese porcentaje es `h / 1.300`; por eso
esta configuración obtiene una señal lineal en altura. Es una deducción de la
geometría y del funcionamiento documentado, pendiente de contrastar en el equipo.

`I(h) = 4 + 16 × h / 1.300` mA.

Si se confirma que el convertidor instalado mantiene 4 mA → 0,00 V y
20 mA → 9,80 V, la tensión ideal es `U(h) = 9,80 × h / 1.300` V.
No cambiar sus puentes de alimentación activa/pasiva por esta configuración.
Tras guardar el ajuste, apagar y encender el OCIO y su módulo para que relean
los parámetros.

[Manual PIUSI del módulo 4–20 mA, pp. 3–4](https://www.tanksrus.co.uk/assets/media/2021/06/18/piusi-ocio-4-20ma-gauge-instructions.pdf).

Ejemplos de comprobación, antes de cuantización y tolerancias eléctricas:

| Altura | Corriente ideal | Tensión ideal | Litros por tabla |
|---|---|---|---|
| 440 mm | 9,415 mA | 3,317 V | 869 L |
| 450 mm | 9,538 mA | 3,392 V | 895 L |
| 460 mm | 9,662 mA | 3,468 V | 922 L |

El bloque correspondiente para incorporar a `[tank_level]` al poner en servicio
el software es:

```toml
volume_conversion = "fm2500_manufacturer"
ocio_output_mode = "linear_height"
ocio_height_at_zero_percent_mm = 0.0
ocio_height_at_full_percent_mm = 1300.0
capacity_liters = 2500.0
ocio_calibration_pending = true
```

Conservar/ajustar `input_empty_volts` y `input_full_volts` según mediciones del
convertidor, no según este ejemplo. La tabla queda seleccionada ahora, con la
conversión de 0–1.300 mm pendiente de confirmar físicamente. No retirar la
marca de calibración pendiente antes de ajustar el OCIO y comprobar la señal.

Si los relés de alarma del OCIO están en uso, hay que conservar sus umbrales
físicos recalculando los porcentajes: `porcentaje nuevo = 100 × altura / 1.300`.
Copiar sus porcentajes anteriores cambiaría el nivel al que actúan. No se
proponen aquí umbrales nuevos sin conocer los existentes. Su histéresis interna
documentada de 2 puntos porcentuales pasa a equivaler a 26 mm; no sustituye
la detección de robo/fuga y la cuadratura del PLC.

## Resolución y límites

El DAC documentado usa pasos de 78,125 µA. Esta escala equivale a unos
**6,35 mm por paso analógico**, frente a **19,53 mm** del modo sin estanque
(4 m). Es una mejora de transmisión, no de precisión del sensor. Los saltos
observados de 10 mm y los pulsos de presión de unos 15 s siguen requiriendo el
filtro temporal y validación en terreno.

La tabla sólo publica 135–1.125 mm. Por fuera se conserva el último volumen
válido con su antigüedad y se informa la indisponibilidad de conversión; no se
extrapolan litros. A 440–450 mm hay 26 L entre escalones, así que este ajuste
no garantiza detectar individualmente todas las extracciones de 20 L.
