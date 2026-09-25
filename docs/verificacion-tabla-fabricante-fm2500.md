# Verificación de la tabla BFM02500DG

Revisión: 8 de septiembre de 2026. **Tabla del fabricante seleccionada por el
usuario como referencia de volumen e implementada en el software local.**
Los 14 pares coinciden con la fuente. El usuario identifica el modelo como
`BFM0250DG`; se conserva el código `BFM02500DG` tal como está impreso en la
tabla. La placa corrobora Kingspan FuelMaster y la fila de 2.500 L. La activación
en el PLC requiere comprobar la correspondencia eléctrica y el cero de altura.

## Procedencia verificada

- [Manual FuelMaster en español, versión 4/2008](https://www.dog.cl/fuelmaster/ES/Fuelmaster/FuelMaster_ES.pdf#page=29): sección 8, página impresa 27, página 29 del PDF. La portada interior identifica a Kingspan Environmental Sp. z o.o. y BFM02500DG.
- [Manual FuelMaster en inglés, revisión 4/2008](https://commercialfuelsolutions.co.uk/downloads/manuals/titan_fuelmaster.pdf#page=27): página impresa 26, página 27 del PDF. Repite los mismos pares y la distribución de la captura aportada.

Son copias del documento del fabricante alojadas por terceros. Se verificó la
página completa en español, incluyendo encabezado, columnas y notas. No se
afirma haber encontrado un aforo individual ni la última revisión aplicable
al número de serie instalado.

Huella SHA-256 del PDF español consultado:
`a3ddd6e0db071ee3747f7de7e7e1c086ff4d879229edf74b283d4232c2b22d6b`.

El asterisco indica **«Valor aproximado»** y la nota menciona el efecto térmico
del polietileno; no asigna una tolerancia numérica a esta tabla. La página
impresa 3 distingue capacidad nominal y de desbordamiento: la primera es el
95 % de la segunda. El ±1 % allí indicado corresponde a dimensiones del
producto, no a exactitud de volumen ni al sensor OCIO.
[Fuente: manual del fabricante, pp. 3 y 27](https://www.dog.cl/fuelmaster/ES/Fuelmaster/FuelMaster_ES.pdf#page=5).

La tabla relaciona nivel de combustible con litros; no es una tabla de señal
eléctrica. Su uso con OCIO requiere alinear el origen físico del nivel con
la medición instalada. La página no proporciona un offset específico para
la punta del tubo OCIO ni una regla de redondeo del instrumento.

## Comparación de los 14 puntos

### Contraste con la placa de la unidad

La fotografía posterior aportada por el usuario muestra **Kingspan Environmental**
y **FuelMaster**. Es una etiqueta común a varias capacidades. En su fila de
2.500 L se leen largo 2.460 mm, ancho 1.460 mm y alto 1.850 mm: coinciden con
la fila BFM02500DG del manual consultado. El usuario identifica la unidad como
FuelMaster 2500 L, por lo que esta concordancia respalda esa tabla como referencia
de trabajo para la familia correspondiente.

La marcación individual y las inscripciones desgastadas no permiten confirmar
con certeza el número de serie, año o revisión del molde en esta fotografía.
No se infiere un año a partir de la edición del manual ni del plano. La placa
tampoco certifica el cero del OCIO, la posición de su tubo o el ajuste de su salida.

**Los 1.850 mm son altura exterior del conjunto**, no una altura líquida para
programar el OCIO ni un extremo nuevo de la tabla de litraje. La tabla del
fabricante se mantiene como referencia documentada pendiente del contraste físico.

### Valores del manual frente al modelo anterior

La columna «modelo anterior» se calcula con `HorizontalTankGeometry.volume_liters`
y su normalización a 2.500 L en 1.255 mm. La diferencia es manual menos modelo;
no es un error de terreno medido. Datos originales también en
[JSON de referencia](bfm02500dg-manual-4-2008.json).

| Altura (mm) | Manual (L) | Modelo anterior (L) | Diferencia (L) |
|---:|---:|---:|---:|
| 135 | 182 | 138,1 | +43,9 |
| 225 | 363 | 294,7 | +68,3 |
| 310 | 545 | 470,3 | +74,7 |
| 385 | 726 | 641,3 | +84,7 |
| 455 | 908 | 810,7 | +97,3 |
| 520 | 1.090 | 973,8 | +116,2 |
| 605 | 1.271 | 1.191,9 | +79,1 |
| 670 | 1.453 | 1.359,7 | +93,3 |
| 740 | 1.634 | 1.538,9 | +95,1 |
| 810 | 1.816 | 1.714,0 | +102,0 |
| 890 | 1.998 | 1.905,5 | +92,5 |
| 970 | 2.179 | 2.083,7 | +95,3 |
| 1.070 | 2.361 | 2.279,3 | +81,7 |
| 1.125 | 2.497 | 2.369,5 | +127,5 |

El modelo anterior subestima todos estos puntos. No corresponde mantenerlo
como conversión de producción confirmada. Las pruebas de monotonía e
integración verificaron su matemática, no su equivalencia con el depósito real.

## Qué cambia en la interpretación geométrica

Se había normalizado toda la envolvente ideal a 2.500 L. La distinción del
manual entre nominal y desbordamiento cuestiona ese supuesto. Para esta
referencia, `2.500 / 0,95 = 2.631,579 L` de desbordamiento, mientras la
envolvente ideal anterior da 2.657,123 L a altura completa. Esta cercanía
de capacidades no valida la curva intermedia ni determina una consigna de llenado.

Eliminar sólo la normalización tampoco resuelve el desacuerdo: a 455 mm la
envolvente ideal da 861,7 L frente a 908 L del manual; a 1.070 mm da 2.422,6 L
frente a 2.361 L. No hay una corrección constante en litros que ajuste todos
los puntos. Deben revisarse la forma moldeada, la referencia de altura y la
correspondencia entre versiones del tanque, sin atribuir una causa única.

El PDF aportado por el usuario incluye planos BFM 2500 de una aprobación DIBt
del 15 de agosto de 2014, anexos 1.5–1.7. Confirma la familia y las cotas usadas
para la aproximación, pero no demuestra por sí solo que la tabla 4/2008 sea
el aforo de ese molde o de la unidad instalada.

## Interpolación implementada

La implementación une los puntos publicados
con segmentos rectos, sin extrapolar fuera de 135–1.125 mm:

```text
V(h) = Vi + (Vi+1 − Vi) × (h − hi) / (hi+1 − hi)
para hi ≤ h ≤ hi+1
```

Es una decisión de software para completar la tabla, no una ecuación publicada
por Kingspan ni una validación de cada milímetro intermedio.

| Altura | Interpolación del manual | Modelo anterior |
|---:|---:|---:|
| 440 mm | 869,0 L | 773,8 L |
| 450 mm | 895,0 L | 798,4 L |
| 455 mm | 908,0 L (punto publicado) | 810,7 L |
| 460 mm | 922,0 L | 823,1 L |

En el segmento 385–455 mm, la pendiente interpolada es 2,6 L/mm: un escalón
de 10 mm representa 26 L y 20 L equivalen a 7,69 mm. En 455–520 mm son
2,8 L/mm. La tabla no elimina la limitación de resolución ni las oscilaciones
del OCIO; debe mantenerse la evaluación de incertidumbre y pérdida acumulada.

No hay puntos publicados en esta tabla por debajo de 135 mm ni por encima
de 1.125 mm. Tampoco debe reinterpretarse 1.125 mm como altura física total
del recipiente sólo porque allí aparecen 2.497 L.

## Estado del proyecto tras verificar

La conversión `fm2500_manufacturer` está implementada en `src/fuel_edge/tank_table.py`
y conectada al lector analógico. El modo operativo `fm2500_horizontal` se retiró:
la configuración lo rechaza para evitar activar accidentalmente la aproximación.
La ecuación anterior se conserva sólo para análisis y trazabilidad.

La actualización de terreno solicitada el 8 de septiembre selecciona la tabla
con `ocio_calibration_pending = true` y escala objetivo 0–1.300 mm. No se
reinterpretan lecturas históricas. Los candidatos se registran sólo en el
diagnóstico hasta confirmar la señal; la pantalla informa «Calibración pendiente».
Seleccionar la tabla no identifica por sí solo el significado de sus mA/voltios.
Los días 1 y 3 de septiembre siguen excluidos del análisis de señales;
esa exclusión no cambia los valores documentales de esta tabla.

### Entrada de altura confirmada

El lector exige `ocio_output_mode = "linear_height"` y los extremos
`ocio_height_at_zero_percent_mm` / `ocio_height_at_full_percent_mm` al seleccionar
`volume_conversion = "fm2500_manufacturer"`. Deben corresponder al cero y fondo
eléctricos configurados; no son necesariamente las dimensiones del recipiente.
No se permite activar la tabla sin ellos ni aplicarla al archivo que ya contiene
litros. Una salida OCIO proporcional al volumen de un cilindro horizontal no
cumple este contrato de altura lineal. Un prisma rectangular sí lo cumple,
porque su porcentaje de volumen coincide con su fracción de altura.

Los valores 0–4.000 mm usados en pruebas son un escenario matemático, no una
instrucción para programar esa escala en terreno. La propuesta de puesta en
servicio es [forma C virtual de 1.300 × 1.000 × 1.000 mm](configuracion-ocio-tabla-kingspan.md),
con visor en mm y tabla Kingspan en el PLC. Falta contrastar cero, corriente y
tensión con alturas independientes antes de activar esa configuración.

Fuera de 135–1.125 mm, o del rango eléctrico confirmado, se publica estado de
lectura no disponible y se conserva la fecha del último volumen válido. No se
extrapola ni se satura la lectura a un volumen aparentemente válido.

### Filtro y cambio de calibración

Los intervalos convierten ambos extremos por la tabla. Para 440–450 mm quedan
869–895 L, con referencia visual de 882 L; la cuadratura usa los extremos.
Las bandas se traducen a señal usando la mayor pendiente de la tabla: la banda
de 0,25 % de capacidad sigue limitada a 6,25 L y la de publicación de 0,1 % a
2,5 L. Por ejemplo, 0,25 % aplicado directamente a una escala de 4 m serían
10 mm, demasiado ancho para agrupar los escalones sin perder información.

Cada lectura lleva una firma de la curva y del escalado eléctrico. La firma
también forma parte de la referencia de inventario. Una calibración diferente
deja la cuadratura anterior como no verificable, sin adjudicar el salto a robo
ni borrar el balance acumulado anterior.

La web guarda cada transición de calibración y reinicia la referencia del
detector de recepciones en la misma transacción que la nueva lectura. No amplía
una recepción pendiente de la calibración anterior ni mezcla sus muestras en
las ventanas del nuevo detector. Conserva los movimientos previos. Una vez
conocida la calibración, rechaza nuevas lecturas que omitan su identificación.

La transición visual, las lecturas por intervalos y la cola persistente se
probaron junto con cargas reales posteriores al cambio. La nueva curva no
resuelve por sí sola el límite físico de detectar siempre 20 L ni la meseta
larga observada en terreno; esos ensayos de aceptación siguen pendientes.

### Validación de esta implementación

335 pruebas Python y 96 pruebas web aprobadas, compilación y comprobación de
tipos aprobadas. Se cotejaron los 14 puntos, los valores intermedios, los límites
de tabla y señal, la conversión de ambos extremos, los escalones de 10 mm con
pulsos de presión de 15 s, la persistencia de calibración y la separación de
recepciones entre calibraciones. La vista `/nivel-demo` usa ahora los valores
869–895 L de la tabla para su caso 440–450 mm, con referencia visual de 882 L.
