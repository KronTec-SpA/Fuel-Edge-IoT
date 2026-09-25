# Tabla de nivel y volumen — Kingspan FuelMaster 2500

**Actualización: se encontró la tabla BFM02500DG del manual del fabricante y
no coincide con esta aproximación.** Ver la [comparación de los 14 puntos](verificacion-tabla-fabricante-fm2500.md).
Se conserva esta tabla para trazabilidad matemática; no debe utilizarse como
aforo confirmado ni como ajuste de producción. La normalización nominal del
modelo está pendiente de revisión a la luz de la nueva fuente.

Generada el 8 de septiembre de 2026 a partir de las ecuaciones de `src/fuel_edge/tank_geometry.py`. Modelo geométrico normalizado a **2.500 L**. La tabla no incorpora mediciones históricas, por lo que las pruebas de descalibración de los días 1 y 3 no afectan estos valores teóricos.

## Geometría y alcance

| Parámetro | Valor adoptado |
|---|---:|
| Diámetro circular del depósito interior | 1.255 mm |
| Radio, r | 627,5 mm |
| Longitud del tramo recto, L | 1.924 mm |
| Longitud total | 2.260 mm |
| Profundidad axial de cada fondo, a | 168 mm |
| Capacidad de la envolvente geométrica ideal | 2.657,123 L |
| Capacidad nominal usada para normalizar | 2.500 L |
| Factor de normalización, k | 0,9408673516 |

Se aproxima un cilindro horizontal nivelado, con dos fondos semielipsoidales iguales. Los planos proporcionan las cotas; la forma matemática de los fondos y la distribución uniforme de la corrección a capacidad nominal son hipótesis. Las nervaduras, el espesor real, las conexiones y un posible desnivel no se modelan individualmente. La cota de 1.300 mm de la envolvente no se utiliza como altura líquida circular.

Esta es una **tabla del modelo**, no un aforo certificado del estanque. Los decimales permiten revisar los cálculos; no expresan la exactitud del sensor ni la del recipiente real.

## Ecuación

Para una altura líquida `h` medida desde el fondo, en mm, con `0 ≤ h ≤ 1.255` y `acos` en radianes:

```text
A(h)     = r² acos((r − h) / r) − (r − h) √(2rh − h²)
Vgeom(h) = [L A(h) + π a (h² − h³ / (3r))] / 1.000.000
k        = 2.500 / Vgeom(1.255)
V(h)     = k Vgeom(h)                                   [litros]
```

El término `π a (h² − h³/(3r))` incluye ambos fondos. El volumen crece de forma continua y no lineal: un salto fijo de 10 mm no equivale a un salto fijo en litros.

## Zona observada de 440 a 460 mm

| Nivel | Volumen del modelo | Cambio hasta el siguiente nivel de 10 mm |
|---:|---:|---:|
| 430 mm | 749,325 L | 24,445 L |
| 440 mm | 773,770 L | 24,588 L |
| 450 mm | 798,359 L | 24,723 L |
| 460 mm | 823,082 L | 24,850 L |
| 470 mm | 847,932 L | 24,969 L |

Al alternar el visor entre **440 y 450 mm**, los valores calculados en esos dos puntos son **773,8 y 798,4 L**: hay **24,6 L** entre ellos. El centro aritmético es **786,1 L** y puede servir como referencia visual, manteniendo la variación y su fecha disponibles en el detalle. Ese centro no constituye una tercera medida del equipo.

Cerca de 450 mm, la sensibilidad es **2,466 L/mm**. Extraer 20 L desde 450 mm lleva el modelo a **441,87 mm**, una caída de **8,13 mm**: puede no completar un escalón de 10 mm.

## Cómo interpretar los tramos

La tabla convierte alturas geométricas en litros. Para convertir un código mostrado por el OCIO en un intervalo físico necesitamos confirmar su regla de cuantización y el modo de salida instalado. Como ejemplos matemáticos, sin atribuirlos al equipo:

| Si el visor indicara 450 mm mediante… | Intervalo ideal de altura antes de cuantizar | Volúmenes del modelo en los extremos |
|---|---|---|
| Redondeo al múltiplo de 10 mm más cercano | 445 ≤ h < 455 mm | 786,0 a 810,7 L |
| Truncamiento inferior a múltiplos de 10 mm | 450 ≤ h < 460 mm | 798,4 a 823,1 L |

Estos ejemplos sólo describen cuantización ideal. No incluyen error de calibración, presión durante la inyección de aire, deriva ni geometría. Por eso, observar 440↔450 mm **no demuestra que el nivel físico esté necesariamente dentro de 440–450 mm**.

El módulo 4–20 mA y la adquisición de tensión pueden tener resoluciones y escalados propios. No debe asignarse un voltaje exacto a cada fila ni asumirse que cada cambio del visor produce un código analógico distinto hasta verificar pares simultáneos de nivel OCIO, corriente y tensión del PLC. Según el modo configurado, la señal puede representar volumen y no altura; esa distinción cambia la conversión.

La tabla resulta útil para que la interfaz se mueva entre referencias coherentes con el instrumento. El seguimiento K24, las lecturas originales y las diferencias acumuladas deben conservarse: un tramo visual no debe borrar pérdidas pequeñas repetidas ni convertir toda lectura del mismo escalón en ausencia de pérdida.

## Ejemplo de pérdida acumulada con cuantización ideal

Este ejemplo supone que el equipo **redondeara al múltiplo de 10 mm más cercano**,
sin otros errores, y parte de 450 mm reales (798,359 L). No es una simulación del
ajuste instalado ni una promesa de detección; no incluye presión, precisión,
repetibilidad ni descalibración. No hay salidas K24 ni recepciones.

| Momento | Extracción acumulada | Altura física del modelo | Indicación supuesta | V(indicación) |
|---|---:|---:|---:|---:|
| Inicio | 0 L | 450,000 mm | 450 mm | 798,359 L |
| Lunes | 20 L | 441,870 mm | 440 mm | 773,770 L |
| Martes | 40 L | 433,703 mm | 430 mm | 749,325 L |
| Miércoles | 60 L | 425,494 mm | 430 mm | 749,325 L |

El miércoles pueden desaparecer otros 20 L sin que cambie la indicación respecto
del martes. Comparar sólo con el día anterior perdería esa información. La
referencia inicial y el balance acumulado deben mantenerse.

Si sólo se conocieran los códigos, el intervalo inicial ideal sería
786,047–810,704 L, y el de 430 mm sería 737,158–761,529 L. La diferencia mínima
frente al inicio sería 24,518 L, tanto el martes como el miércoles: hay evidencia
de pérdida bajo estas hipótesis, pero los códigos solos no permiten afirmar
si fueron exactamente 40 o 60 L. El margen real del instrumento y de la
calibración debe incorporarse antes de utilizar límites operativos.

## Sensibilidad de los tramos

| Medida | Resultado |
|---|---:|
| Menor cambio de la malla completa de 10 mm | 2,747 L, entre 0 y 10 mm |
| Mayor cambio de la malla completa de 10 mm | 25,834 L, entre 620 y 630 mm |
| Tramo 440→450 mm | 24,588 L |
| Último tramo de cierre, de 5 mm | 0,967 L, entre 1.250 y 1.255 mm |
| Máxima sensibilidad instantánea, a 627,5 mm | 2,583 L/mm |

Los mínimos y máximos de 10 mm corresponden a la malla de la tabla. El último tramo tiene sólo 5 mm y se informa por separado. El modelo es simétrico respecto de 627,5 mm; la malla de múltiplos de 10 mm no lo es porque la altura total termina en 1.255 mm.

## Tabla completa

`Δ L` es `V(nivel siguiente) − V(nivel actual)`, calculado antes del redondeo. Hay 127 niveles: 0, 10, …, 1.250 y 1.255 mm. Por redondeo, la resta de dos volúmenes impresos puede diferir en 0,001 L de la columna de incremento.

| Nivel actual (mm) | Volumen (L) | Nivel siguiente (mm) | Δ L hasta el siguiente |
|---:|---:|---:|---:|
| 0 | 0,000 | 10 | 2,747 |
| 10 | 2,747 | 20 | 5,061 |
| 20 | 7,808 | 30 | 6,581 |
| 30 | 14,389 | 40 | 7,812 |
| 40 | 22,201 | 50 | 8,874 |
| 50 | 31,075 | 60 | 9,820 |
| 60 | 40,895 | 70 | 10,678 |
| 70 | 51,574 | 80 | 11,469 |
| 80 | 63,042 | 90 | 12,202 |
| 90 | 75,245 | 100 | 12,889 |
| 100 | 88,134 | 110 | 13,535 |
| 110 | 101,668 | 120 | 14,145 |
| 120 | 115,813 | 130 | 14,723 |
| 130 | 130,537 | 140 | 15,273 |
| 140 | 145,810 | 150 | 15,797 |
| 150 | 161,608 | 160 | 16,298 |
| 160 | 177,906 | 170 | 16,776 |
| 170 | 194,682 | 180 | 17,235 |
| 180 | 211,916 | 190 | 17,674 |
| 190 | 229,590 | 200 | 18,095 |
| 200 | 247,685 | 210 | 18,500 |
| 210 | 266,185 | 220 | 18,889 |
| 220 | 285,074 | 230 | 19,262 |
| 230 | 304,336 | 240 | 19,622 |
| 240 | 323,958 | 250 | 19,967 |
| 250 | 343,925 | 260 | 20,300 |
| 260 | 364,225 | 270 | 20,620 |
| 270 | 384,845 | 280 | 20,927 |
| 280 | 405,772 | 290 | 21,223 |
| 290 | 426,995 | 300 | 21,507 |
| 300 | 448,503 | 310 | 21,781 |
| 310 | 470,284 | 320 | 22,044 |
| 320 | 492,327 | 330 | 22,296 |
| 330 | 514,623 | 340 | 22,538 |
| 340 | 537,161 | 350 | 22,770 |
| 350 | 559,931 | 360 | 22,992 |
| 360 | 582,923 | 370 | 23,205 |
| 370 | 606,128 | 380 | 23,409 |
| 380 | 629,537 | 390 | 23,604 |
| 390 | 653,141 | 400 | 23,789 |
| 400 | 676,930 | 410 | 23,966 |
| 410 | 700,896 | 420 | 24,134 |
| 420 | 725,031 | 430 | 24,294 |
| 430 | 749,325 | 440 | 24,445 |
| 440 | 773,770 | 450 | 24,588 |
| 450 | 798,359 | 460 | 24,723 |
| 460 | 823,082 | 470 | 24,850 |
| 470 | 847,932 | 480 | 24,969 |
| 480 | 872,901 | 490 | 25,080 |
| 490 | 897,981 | 500 | 25,183 |
| 500 | 923,164 | 510 | 25,278 |
| 510 | 948,442 | 520 | 25,366 |
| 520 | 973,808 | 530 | 25,446 |
| 530 | 999,254 | 540 | 25,518 |
| 540 | 1.024,772 | 550 | 25,583 |
| 550 | 1.050,355 | 560 | 25,640 |
| 560 | 1.075,995 | 570 | 25,690 |
| 570 | 1.101,685 | 580 | 25,733 |
| 580 | 1.127,418 | 590 | 25,768 |
| 590 | 1.153,186 | 600 | 25,795 |
| 600 | 1.178,981 | 610 | 25,815 |
| 610 | 1.204,796 | 620 | 25,828 |
| 620 | 1.230,625 | 630 | 25,834 |
| 630 | 1.256,459 | 640 | 25,832 |
| 640 | 1.282,291 | 650 | 25,823 |
| 650 | 1.308,113 | 660 | 25,806 |
| 660 | 1.333,920 | 670 | 25,782 |
| 670 | 1.359,702 | 680 | 25,751 |
| 680 | 1.385,453 | 690 | 25,712 |
| 690 | 1.411,165 | 700 | 25,666 |
| 700 | 1.436,832 | 710 | 25,613 |
| 710 | 1.462,444 | 720 | 25,552 |
| 720 | 1.487,996 | 730 | 25,483 |
| 730 | 1.513,479 | 740 | 25,407 |
| 740 | 1.538,886 | 750 | 25,323 |
| 750 | 1.564,209 | 760 | 25,232 |
| 760 | 1.589,440 | 770 | 25,132 |
| 770 | 1.614,572 | 780 | 25,025 |
| 780 | 1.639,598 | 790 | 24,911 |
| 790 | 1.664,508 | 800 | 24,788 |
| 800 | 1.689,296 | 810 | 24,657 |
| 810 | 1.713,953 | 820 | 24,518 |
| 820 | 1.738,471 | 830 | 24,371 |
| 830 | 1.762,842 | 840 | 24,215 |
| 840 | 1.787,057 | 850 | 24,051 |
| 850 | 1.811,108 | 860 | 23,879 |
| 860 | 1.834,987 | 870 | 23,698 |
| 870 | 1.858,685 | 880 | 23,507 |
| 880 | 1.882,192 | 890 | 23,308 |
| 890 | 1.905,500 | 900 | 23,100 |
| 900 | 1.928,600 | 910 | 22,882 |
| 910 | 1.951,483 | 920 | 22,655 |
| 920 | 1.974,138 | 930 | 22,418 |
| 930 | 1.996,556 | 940 | 22,171 |
| 940 | 2.018,727 | 950 | 21,914 |
| 950 | 2.040,640 | 960 | 21,646 |
| 960 | 2.062,286 | 970 | 21,367 |
| 970 | 2.083,653 | 980 | 21,077 |
| 980 | 2.104,729 | 990 | 20,775 |
| 990 | 2.125,504 | 1.000 | 20,461 |
| 1.000 | 2.145,965 | 1.010 | 20,135 |
| 1.010 | 2.166,101 | 1.020 | 19,796 |
| 1.020 | 2.185,897 | 1.030 | 19,444 |
| 1.030 | 2.205,341 | 1.040 | 19,077 |
| 1.040 | 2.224,418 | 1.050 | 18,696 |
| 1.050 | 2.243,114 | 1.060 | 18,300 |
| 1.060 | 2.261,414 | 1.070 | 17,887 |
| 1.070 | 2.279,301 | 1.080 | 17,456 |
| 1.080 | 2.296,757 | 1.090 | 17,008 |
| 1.090 | 2.313,765 | 1.100 | 16,540 |
| 1.100 | 2.330,305 | 1.110 | 16,050 |
| 1.110 | 2.346,355 | 1.120 | 15,539 |
| 1.120 | 2.361,894 | 1.130 | 15,002 |
| 1.130 | 2.376,895 | 1.140 | 14,438 |
| 1.140 | 2.391,333 | 1.150 | 13,844 |
| 1.150 | 2.405,177 | 1.160 | 13,217 |
| 1.160 | 2.418,394 | 1.170 | 12,551 |
| 1.170 | 2.430,945 | 1.180 | 11,842 |
| 1.180 | 2.442,787 | 1.190 | 11,081 |
| 1.190 | 2.453,868 | 1.200 | 10,259 |
| 1.200 | 2.464,127 | 1.210 | 9,359 |
| 1.210 | 2.473,486 | 1.220 | 8,360 |
| 1.220 | 2.481,847 | 1.230 | 7,223 |
| 1.230 | 2.489,070 | 1.240 | 5,870 |
| 1.240 | 2.494,940 | 1.250 | 4,093 |
| 1.250 | 2.499,033 | 1.255 | 0,967 |
| 1.255 | 2.500,000 | — | — |

## Verificación de la tabla

Se comprobaron los extremos 0 y 2.500 L, crecimiento estricto, las 127 filas y que la suma de los incrementos sea 2.500 L antes del redondeo. La evaluación de la expresión se contrastó con integración numérica de su derivada en nueve alturas; la mayor diferencia fue inferior a 0,001 L. Esta comprobación verifica la consistencia matemática, no sustituye el aforo ni la calibración física.
