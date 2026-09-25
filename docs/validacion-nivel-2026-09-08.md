# Validación de fluctuaciones antes de la carga por Tailscale

Fecha: 8 de septiembre de 2026. Consulta de las bases del PLC en modo lectura,
sin modificar servicios, configuración ni datos de terreno.

**Resultado: ruido pequeño de presentación corregido y probado. La carga total
todavía requiere resolver o caracterizar los cambios prolongados de unos 23 L.**
Esta revisión no certifica que toda fluctuación del OCIO esté eliminada.

**Actualización documental posterior:** la [tabla BFM02500DG del fabricante](verificacion-tabla-fabricante-fm2500.md)
no coincide con el modelo geométrico normalizado. También debe resolverse la
curva de conversión antes de la carga total. Este hallazgo no altera la
extracción de campo ni las exclusiones de los días 1 y 3.

## Evidencia consultada

- Base edge: `/var/lib/fuel-edge/edge.db`.
- Base web: `/var/lib/fuel-edge-web/fuel-edge.sqlite3`.
- Extracción de series y volúmenes, sin cuentas, credenciales ni datos personales.
- Captura iniciada a las 18:16:45 UTC / 15:16:45 de Chile.
- Extracción original: 57.285 lecturas publicadas del edge, del 16 de agosto al 8 de septiembre.
- Extracción original: 55.609 lecturas históricas web, del 19 de agosto al 8 de septiembre.
- Seis registros eléctricos y movimientos K24 para contextualizar los cambios.
- Huella SHA-256 de la extracción:
  `31e27130b7f152992fb74217d3a12f3da38fec4654bb7983d8630b36d3f00159`.

### Exclusión de las pruebas de descalibración

Por indicación del operador se excluyen **el 1 y el 3 de septiembre de 2026,
según `America/Santiago`**, completos. En ambas fechas el desfase es UTC−04:00;
se usan intervalos desde medianoche local incluida hasta la siguiente excluida.
No se eliminan registros de terreno: la exclusión se aplica al análisis.

| Serie | Extracción original | Excluidas el 1 | Excluidas el 3 | Conservadas |
|---|---:|---:|---:|---:|
| Edge | 57.285 | 3.672 | 2.139 | **51.474** |
| Histórica web | 55.609 | 3.672 | 2.139 | **49.798** |

Las diferencias se calculan sólo entre observaciones consecutivas originales:
no se unen los extremos de un día excluido. Se omiten cambios de sesión cuando
ese dato existe, y para estadísticas de fluctuación se limitan los pares a
180 s de separación. La serie web exportada no incluye identificador de sesión.
Quedan 49.791 pares web con esa separación; su cambio absoluto observado tiene
mediana 2,5 L, percentil 90 de 10,0 L y percentil 99 de 22,4 L. **No son una
medida aislada de ruido:** el conjunto conserva operaciones reales y posibles
ajustes de otros días. Excluir estas dos fechas tampoco demuestra que los
ajustes físicos anteriores y posteriores coincidan; no deben tomarse como una
misma calibración para reconstruir inventario sin verificar ese dato.

La [salida reproducible del análisis](ocio-field-analysis-2026-09-08.json)
incluye conteos, intervalos, método y huella del original. Se obtiene con:

```sh
python3 tools/analyze_ocio_field.py /ruta/exportacion.json --exclude-local-date 2026-09-01 --exclude-local-date 2026-09-03
```

El PLC aún no tiene la tabla `ocio_signal_diagnostics`: las lecturas disponibles
son las publicadas por el filtro antiguo, no muestras continuas del ADC. En la
serie web conservada, la mediana del intervalo entre publicaciones es 24,928 s y el
percentil 90 es 60,174 s. No se rellenaron esos huecos ni se presentaron valores
interpolados como volts medidos. La base local de la vista de desarrollo sólo
tenía una lectura; no se utilizó como evidencia de terreno.

## Ruido pequeño y presentación

En dos horas del 26 de agosto, 02:00–04:00 de Chile, se conservaron 120 muestras
sin despachos K24 registrados en esa ventana. El nivel publicado varió de
1.025,641 a 1.026,893 L: una excursión de 1,252 L. La presentación anterior a una
decimal cambiaba 26 veces.

Se añadió una referencia visual persistente, en litros enteros, con histéresis
de 2,5 L respecto del valor mostrado. No es una tolerancia nueva para las alarmas.
Para la misma secuencia real, el dashboard muestra **1.027 L / 41,1 %**, sin
cambios de litros ni porcentaje. Las 120 observaciones originales siguen
disponibles y no se usan los litros de presentación para cuadrar inventario.

La referencia se guarda en la base de la aplicación, por lo que recargar o
abrir otra pantalla no reinicia la histéresis. Se recalcula cuando cambia la
sesión del controlador, hay una interrupción de más de tres minutos, cambia
entre lectura puntual e intervalo o la desviación supera 2,5 L. Un descenso
progresivo no queda oculto por acumulación de pequeñas diferencias. Cero y
capacidad completa se actualizan expresamente. La fecha de vigencia sigue
siendo la de la observación recibida; una actualización de estado no la renueva.

La interfaz comprueba que la referencia pertenezca a la misma muestra y sesión,
que esté dentro de capacidad y de la banda permitida. Los límites originales
de un intervalo continúan determinando la cuadratura. El detalle permite ver
la observación original, aunque el número principal se haya estabilizado.

## Cambios prolongados: condición todavía abierta

La base conservada después de excluir ambos días también contiene cambios
reversibles de aproximadamente 23 L, incluyendo permanencias de varios minutos.
La ventana de ruido pequeño del 26 de agosto y el siguiente ejemplo del
8 de septiembre permanecen íntegros fuera de las exclusiones:

- Antes: 704,568 L.
- Episodio que comienza alrededor de las 14:05 de Chile: mínimo de 681,518 L.
- Recuperación a 704,568 L a las 14:19:53.
- Excursión: 23,050 L; las publicaciones del episodio abarcan unos 14 min 45 s.
- Sin despacho K24, recepción ni corte registrados durante ese intervalo.

La reversibilidad es compatible con una oscilación de medición, pero no prueba
por sí sola su causa física. La ausencia de movimiento K24 tampoco excluye una
intervención externa. No se debe clasificar todo ese período como un pulso
de aire de 15 s.

El filtro preparado utiliza una ventana de 120 s. Una meseta falsa que dura
mucho más puede pasar su criterio de estabilidad. Para comprobar ese límite se
modeló una señal sintética de 729,5 → 707,1 → 729,5 L, con permanencia inferior
de 900 s y sin flujo. El filtro aceptó ambos niveles y el monitor generó avisos
de descuadre. Es un contraejemplo del alcance de los ensayos cortos, no una
reconstrucción de los volts faltantes ni prueba de robo real.

Por tanto, no está demostrado que la histéresis de presentación o el filtro
de presión eliminen esos episodios largos. Ampliar una banda para taparlos
también puede ocultar una pérdida real del orden de 20 L. Antes de aprobar
la carga total se requiere una captura continua de la señal y contraste con
el visor OCIO, en reposo, durante varios de estos episodios. Debe distinguirse
metastabilidad del instrumento, efecto neumático y conversión analógica, y
volver a ensayar cambios reales de volumen con esa evidencia.

## Propuesta de tabla y escalones de nivel

Se generó la [tabla completa del modelo FM2500](tabla-nivel-fm2500.md), con
127 alturas: 0–1.250 mm cada 10 mm y cierre en 1.255 mm. No se deriva de los
litros históricos, por lo que las descalibraciones excluidas no contaminan la
ecuación. La tabla aproxima cilindro y fondos y normaliza a 2.500 L nominales;
todavía requiere contraste físico de capacidad y altura.

Es apropiado usar una tabla única para convertir altura a volumen. **No basta
con redondear el volumen recibido al múltiplo de 25 L:** cada tramo de 10 mm
representa una cantidad distinta. Entre 440 y 450 mm son 24,588 L; entre 620
y 630 mm son 25,834 L. La semejanza con las oscilaciones históricas de unos
23 L es una hipótesis a investigar, no una identificación de su causa ni una
calibración del voltaje.

La conversión propuesta es señal eléctrica → estado/altura OCIO confirmado →
volumen geométrico. Hay que verificar si la salida representa altura o volumen
y si comparte los escalones del visor. No se asignaron voltajes inventados a
la tabla. La incertidumbre por cuantización se suma al análisis de error y
repetibilidad correspondiente; no demuestra que el volumen físico esté
siempre dentro de los extremos de dos indicaciones.

Para presentar los datos se recomienda una referencia en litros enteros y
estado de lectura con fecha, manteniendo límites y observaciones en el detalle.
La histéresis y el filtro de presión deciden cuándo actualizarla. En la lógica
de pérdidas se conserva el intervalo de evidencia y el balance acumulado K24;
ni recargar la pantalla ni cambiar de tramo debe borrar el faltante. El modelo
por escalones no se activó sobre la conversión eléctrica desconocida.

## Parámetros de terreno que debe preservar la carga

La configuración consultada usa **90 pulsos/L en K24**, no los 100 del ejemplo
original. El proyecto se alineó a 90 para preservar el ajuste instalado.
Por ejemplo, 3.504 pulsos representan 38,933 L con ese ajuste; con 100 serían
35,040 L. Esto no certifica la calibración, pero evita introducir una diferencia
adicional de 10 % al desplegar.

El nivel instalado usa 0–9,80 V, capacidad 2.500 L, ventana antigua de 15 s y
banda antigua de 2 %. El nuevo filtro todavía no está instalado. La conversión
geométrica `fm2500_horizontal` quedó retirada y fue reemplazada por la opción
`fm2500_manufacturer`, seleccionada por el usuario. Esta última exige verificar
la salida eléctrica de altura; no se activó automáticamente en el PLC.

## Validación de software

Se añadieron pruebas con las 120 muestras reales, deriva gradual, caída de 20 L,
cambio de sesión, lectura antigua, límites inválidos y persistencia al reabrir
la base. El cálculo de alertas e inventario continúa usando la evidencia
original. El archivo de prueba incluye sólo fecha y volumen de esa ventana,
con la huella y procedencia de la extracción.

Resultado de esta revisión: **316 pruebas Python y 90 pruebas web aprobadas**;
compilación y comprobación de tipos aprobadas. Las bases de prueba son aisladas.

Actualización por exclusión de pruebas: cinco ensayos adicionales del analizador
aprobados (límite de fecha chilena, día excluido sin muestras, cambios de sesión,
huecos de datos y zona horaria). Las 127 filas se cotejaron contra la función
Python del modelo con diferencia máxima de redondeo de 0,0005 L. Esta actualización
no cambió el código de adquisición ni la interfaz desplegada.

Una batería de pruebas aprobada verifica las reglas programadas. No reemplaza
el ensayo pendiente de las mesetas prolongadas observadas en terreno.
