# Revisión de alarmas, cuadratura y gemelo FM2500

**Actualización del 9 de septiembre:** para la curva calibrada Copec de 2.662 L,
la [política de márgenes OCIO/K24](margen-cuadratura-ocio-k24-20260909.md)
amplía ambos extremos observados por el error de los instrumentos. Los umbrales
de 20/40/60 L se aplican al faltante residual, después de esa ampliación.
El resto de este documento conserva la revisión histórica del 8 de septiembre.

Revisión del código y configuración del proyecto, 8 de septiembre de 2026.
No se han leído los ajustes físicos actuales del OCIO ni desplegado cambios al PLC.
Los umbrales enumerados son los del repositorio; no una certificación de la instalación.

La [validación con la base real del 8 de septiembre](validacion-nivel-2026-09-08.md)
añade histéresis visual de 2,5 L y documenta un límite pendiente: mesetas
reversibles de unos 23 L durante varios minutos. Las pruebas de pulsos de 15 s
no certifican ese caso; la carga total queda pendiente de cerrar esa validación.
El análisis actualizado excluye las pruebas de descalibración del 1 y 3 de
septiembre en fecha chilena. La [tabla completa cada 10 mm](tabla-nivel-fm2500.md)
documenta la ecuación y distingue resolución del visor, conversión eléctrica
y error físico de medición.

## Alarmas existentes antes de esta revisión

| Alarma persistente | Disparo | Prioridad / actuación |
|---|---|---|
| Flujo de petróleo sin autorización | Pulsos K24 fuera de una autorización activa | Crítica/urgente. Incidente y conteo independientes; no requiere que el relé esté habilitado. Se consolida después de 40 s sin flujo para suministros ≥0,12 L. |
| Habilitación de bomba sin carga | Incidente de pulsos sin autorización que termina por debajo de 0,12 L y sin suministro posterior durante la ventana de inicio | Informativa/baja; clasificación de presurización. Ventana de inicio configurada: 60 s. |
| Prueba de relé interrumpida por flujo K24 | K24 detecta flujo durante una prueba de R0.1 | Crítica/urgente; abre el relé inmediatamente. |
| Falla de la cadena de control | Evento CONTROL_FAULT, incluido error de persistencia o relé que permanece energizado al cerrar | Crítica/urgente; estado de falla y orden de corte. |
| Falla de telemetría | Evento TELEMETRY_FAULT; el adaptador K24 lo emite si no puede leer pulsos | Crítica/urgente. No equivale automáticamente a corte: el núcleo conserva su estado y marca la salud K24. |
| Validador sin conexión | Evento VALIDATOR_LINK_LOST del enlace | Advertencia/alta. En operación automática puede cerrar la carga; modo manual y pruebas tienen reglas específicas. |
| Carga cerrada por pérdida BLE | Pérdida de presencia autenticada durante ≥20 s, con carga autorizada/en curso y política que exige MIM | Advertencia/alta; cierre. En modo RFID-only/manual degrada evidencia sin aplicar ese cierre BLE. |

Fuentes de implementación: `src/fuel_edge/service.py`, `storage.py`, `domain.py`,
`application.py`, `config/fuel-edge.toml` y `web/worker/alerts-store.ts`.

Otros estados no deben confundirse con alarmas persistentes:

- Retiro RFID y vencimiento de presencia NFC (2,5 s) cortan; antirrebote NFC 300 ms.
- Sin inicio de flujo durante 60 s e inactividad K24 durante 40 s cierran operaciones.
- Próxima caducidad del MIM dentro de 24 h muestra un aviso visual; equipo vencido limita autorización.
- Corte eléctrico: antes de esta revisión sólo tenía registro durable por UPS y cierre del evento al arrancar. Ahora genera la alarma descrita abajo, además de la cuadratura posterior.
- Error de lectura OCIO: se escribía en el registro del proceso, sin alarma persistente específica.
- Recepción de combustible: detector de incrementos sostenidos ≥100 L, sujeto a revisión. No es detector de pérdidas.
- No encontré alarmas automáticas de nivel mínimo/máximo, batería baja ni extracción fuera de K24 en el código. El OCIO dispone de dos contactos configurables, pero sus consignas y cableado reales no constan en el proyecto.

## Alarma de corte eléctrico incorporada

**«Corte eléctrico»**, advertencia de prioridad **alta**. Se agrega al listado
final como el tipo de alerta número 16, incluida la alerta informativa de
habilitación sin carga.

El hook UPS de GPIO24 guarda el evento y la alarma en una misma transacción
antes del apagado. Usa la hora original del corte y un identificador por evento.
Si no puede entregarse a la aplicación durante el respaldo, la cola durable la
envía al recuperar funcionamiento y conexión; no depende de completar primero
la cuadratura OCIO/K24.

Al arrancar, se completa la recuperación y duración registradas en la misma
alarma. La hora de recuperación corresponde al arranque registrado del PLC,
no a una medición independiente del instante exacto de retorno de la red.
Volver a tener energía no resuelve automáticamente la alerta: queda pendiente
de revisión, junto con la comprobación de inventario. Una resolución humana
previa tampoco se revierte por reintentos tardíos.

Los reintentos y avisos repetidos de la UPS no duplican el corte. Un reinicio
normal sin pérdida eléctrica registrada no inventa una alarma. Los cortes
importados por operador o reconstruidos también generan alerta, identificando
su origen sin atribuirlos a la UPS. No se convierten retroactivamente todos los
registros históricos ya almacenados en nuevas alarmas.

La captura depende de que el hook UPS alcance a persistir antes de agotarse el
respaldo. Sin evidencia de ese evento, el arranque sigue verificando inventario,
pero no afirma por sí solo que hubo un corte eléctrico.

## Histéresis y filtros anteriores a las correcciones

| Capa | Lógica existente |
|---|---|
| Entrada analógica | Mediana de 5 lecturas ADC; mediana temporal durante 15 s. |
| Estabilidad OCIO | Se permite una excursión de 2 puntos porcentuales de señal. Equivale a 50 L sólo bajo la interpretación lineal de % de volumen y capacidad 2.500 L. Es un criterio de estabilidad, no exactitud certificada ni umbral de robo. |
| Publicación | Banda muerta de 0,1 puntos porcentuales; publica también cada 60 s. Bajo la misma interpretación equivale a 2,5 L. |
| Recepciones web | Umbral 100 L, meseta de 5 min, confirmación de 10 min, retorno del candidato a 50 L, caducidad 45 min. Reasienta la referencia y reinicia calentamiento tras interrupciones. |

El detector de recepciones puede absorber descensos al actualizar su referencia.
Por ello la nueva cuadratura usa su propia referencia durable en el PLC.

## Corrección del ciclo de aire y saltos de 10 mm

El operador confirma una subida de presión de aproximadamente **15 segundos**;
el período entre subidas todavía no está medido. La mediana anterior de cinco
lecturas consecutivas y la ventana de 15 s podían capturar la sobrepresión como
una lectura válida. La tolerancia antigua de 50 L era excesiva para este objetivo.

El filtro activo (`ocio_filter.py`) ahora exige:

1. Muestreo temporal a aproximadamente 1 Hz. Las cinco conversiones ADC de cada
   instante sólo rechazan ruido eléctrico; no cuentan como cinco instantes.
2. Ventana de 120 s con cobertura de al menos 90 %. Una pausa de más de 2,5 s
   reinicia la evidencia de estabilidad.
3. Al menos 80 % de los puntos en una misma meseta de **0,25 puntos porcentuales
   de señal**. Es aproximadamente 6,25 L bajo escala lineal de 2.500 L; con la
   curva geométrica, la equivalencia depende del nivel. No es exactitud certificada.
4. Los últimos 15 s deben estar próximos al centro de esa meseta. Un pulso de
   aire o el inicio de un descenso no publica el valor alto ni una mediana vieja
   con fecha nueva. La publicación cada 60 s nunca fuerza una lectura inválida.
5. Si 440/450 mm alternan sin una meseta dominante, se reconoce una variación
   acotada cuando hay dos grupos estrechos: cada uno representa al menos 20 %
   de la ventana, juntos al menos 80 %, con tres alternancias o más. Los últimos
   15 s deben pertenecer a esos grupos. Se publican ambos límites como evidencia
   nueva; una tercera excursión de presión sigue bloqueando la publicación.
6. Si no hay ni meseta válida ni dos grupos verificables, se conserva la última
   lectura con su fecha original. El estado «Validando lectura» o «Actualización
   pendiente» informa el proceso sin inventar una nueva medición.

La banda de estabilidad de las tres lecturas de inventario también se redujo
a **6,25 L**, y el filtro heredado de respaldo pasó de 2 % a 0,25 %.
La histéresis de alarma permanece en 10/20 L: valida diferencias de inventario,
no el ruido eléctrico. El seguimiento acumulado de 20/40/60 L sigue independiente.

El diagnóstico local `ocio_signal_diagnostics` conserva 24 h de muestras a
aproximadamente 1 Hz: ADC, volts, porcentaje crudo, porcentaje aceptado, proporción
de soporte y motivo (`warming_up`, `settling`, `ambiguous_levels`, `range`, `valid`). Se
escribe en lotes de 30 muestras; un corte abrupto puede perder el último lote
de diagnóstico en memoria, sin borrar referencias ni alarmas ya confirmadas.
Los datos rechazados no se entregan como movimientos, inventario o lectura
nueva de pantalla. La firma de calibración incluye el filtro para no comparar
sin advertencia referencias tomadas con distintos criterios.

Pruebas: pulsos de 15 s cada 120 s en distintas fases, incluyendo el arranque
durante el pulso; alternancia 440/450 mm con permanencias de 1, 10 y 30 s;
pérdida real de 20 L superpuesta al pulso; ruido ADC, ráfagas y pausas.
Se verifica la cadena lector→inventario→alerta y la persistencia de la traza.

**Límite explícito:** sin una señal que indique «compresor activo» no es posible
identificar físicamente su fase sólo por volts con certeza. Un estado falso
que se mantenga varios minutos puede parecer una meseta real. Si los pulsos
ocupan más del 20 % de la ventana, el filtro puede entregar un intervalo que
contenga ambos estados; no lo acepta como un nivel puntual estable. En las
pruebas, 15 s altos cada 60 s quedan pendientes o acotados por ambos extremos.
La variación observada no certifica el error total del instrumento. El registro
real permite ajustar la ventana sin volver a aceptar una excursión arbitraria
de 50 L. Tampoco se garantiza detectar
20 L si la propia cuantización mantiene sin cambios la salida del instrumento.

El manual describe la activación automática del compresor según las condiciones
de lectura; no establece un período fijo que pueda usarse como reloj del PLC.
[Manual PIUSI M0073B, funcionamiento y activación manual](https://www.oilybits.com/downloads/PIUSI_OCIO_INSTRUCTIONS.pdf).

## Cuadratura incorporada

`InventoryMonitor` se activa con el sensor de nivel. Verifica cada inicio del
servicio y cada interrupción de lecturas de al menos 180 s, aunque no exista
evento UPS. No confunde un reinicio del servicio con una prueba de corte eléctrico:
guarda el motivo como `startup` o `level_gap`.

1. Guarda referencias estables y un total K24 independiente del cierre de las
   transacciones. Cada lote recibido se confirma en SQLite antes de procesar la carga.
2. Al arrancar conserva la referencia anterior. Un segundo reinicio durante la
   verificación no la reemplaza por la lectura posterior al posible robo.
3. Espera tres lecturas en reposo, separadas al menos 60 s, con excursión máxima
   de 6,25 L; cuando son intervalos se verifica cada extremo por separado.
   Si hay pulsos o se energiza el relé, reinicia la ventana.
4. Rechaza lecturas anteriores al arranque, duplicadas, futuras o con más de
   90 s de antigüedad. Cambios de calibración impiden una comparación válida.
5. Calcula `esperado = referencia_anterior − consumo_K24_desde_la_referencia`.
   Compara `diferencia = esperado − nivel_posterior`.

| Nueva alarma / estado | Condición |
|---|---|
| Posible extracción durante interrupción | Diferencia observada ≥20 L; advertencia de prioridad alta. No confirma robo. |
| Aumento de inventario durante interrupción | Diferencia ≤−20 L; prioridad alta. Requiere conciliar una posible recepción. |
| Inventario sin referencia verificable | Primer arranque, referencia incompatible, contador reiniciado o K24 deshabilitado. No concluye que no hubo pérdida. |
| Verificación de inventario pendiente | 300 s sin completar la cuadratura: señal ausente/inestable, bomba activa o diferencia en banda gris. |
| Dentro de banda operacional | Diferencia absoluta ≤10 L. No demuestra ausencia de robo menor o enmascarado por incertidumbre. |
| Banda gris | Diferencia absoluta >10 y <20 L: conserva la referencia y sigue verificando. |
| Variación acotada | Dos niveles persistentes válidos: conserva ambos extremos. Si la diferencia no demuestra un faltante mínimo de 20 L, registra cuadratura en observación; no lo confunde con ausencia de señal. |

Con intervalos, la diferencia va desde `esperado_mínimo − observado_máximo`
hasta `esperado_máximo − observado_mínimo`. Se alerta por faltante cuando su
límite inferior alcanza 20 L. Para dar por cumplida la banda de ±10 L se exige
que todo el intervalo esté dentro. Completar la verificación con incertidumbre
acotada no modifica el ancla contable acumulada ni declara ausencia de pérdidas.

La evidencia y la alarma se guardan juntas; la cola web sobrevive a reinicios y
a la falta de red. Tras registrar el resultado se establece la referencia
siguiente. Las alarmas abiertas no se resuelven por el retorno del nivel ni por
la adopción de esa referencia. La banda 10/20 L evita aprobar una diferencia
limítrofe, pero no es un aumento de precisión del sensor.

Límites: no bloquea nuevas cargas durante la verificación, por lo que una
operación continua puede dejarla pendiente y provocar el aviso de cinco minutos.
No incorpora automáticamente las recepciones durante el corte: requiere revisión.
No observa pulsos durante una pérdida total de alimentación ni recupera los
pulsos aún no entregados por el adaptador al momento del corte.
Una reposición durante el corte puede compensar y ocultar una extracción.

## Descenso sin flujo y robo hormiga

Se agregó una comprobación local durante la operación: si dos niveles estables
comparables muestran una caída de al menos 20 L, sin incremento del contador K24
y con el medidor habilitado y saludable, registra **«Posible robo o fuga: descenso
sin flujo K24»**. La evidencia y la alerta se guardan en SQLite aunque no haya
internet; la entrega web se reintenta al recuperar conexión. Requiere reposo y
tres muestras separadas por 60 s. No es una detección instantánea ni identifica
la causa física. Un descenso suave puede repartirse entre muestras: para ese
caso existe además la cuadratura acumulada siguiente.

La referencia contable es independiente de la referencia de verificación de
reinicio y nunca se reajusta automáticamente con el nivel observado:

`faltante = inventario inicial + recepciones aprobadas/corregidas − litros K24 acumulados − inventario OCIO`

El contador físico persiste durante la carga, antes de cerrar la transacción.
Las muestras se conservan localmente y se envían por una cola durable a
`POST /api/inventory-balance/edge`. La base web conserva el ancla, las muestras,
el estado de alarmas y el cierre de cada día de Chile. El panel de Histórico
muestra esperado, observado, diferencia acumulada y últimos 31 días con lectura.
Las alertas se calculan al recibir cada muestra, sin depender de abrir la pantalla.
La evaluación acumulada necesita conexión con la base web; durante una caída
de red queda pendiente y se recupera con la cola. La alarma local anterior
continúa funcionando y almacenando evidencia.

| Caso con inventario inicial de 1.000 L y sin flujo K24 | OCIO | Faltante acumulado | Acción |
| --- | ---: | ---: | --- |
| Lunes: extracción externa de 20 L | 980 L | 20 L | Advertencia alta |
| Martes: otros 20 L | 960 L | 40 L | Nueva alerta de aumento |
| Miércoles: otros 20 L | 940 L | 60 L | Escala a prioridad urgente |

Cuatro extracciones de 5 L también alcanzan 20 L de diferencia acumulada.
El consumo registrado por K24 se descuenta; no se considera pérdida. Las
recepciones pendientes no se acreditan hasta revisión y nunca ocultan un
faltante positivo ya observable. Una recepción no conciliada puede dificultar
interpretar la diferencia, por lo que el balance se indica provisional.

Hay histéresis: rearme en ±10 L, primera alerta a 20 L y escaladas a 40/60 L.
No se repite una alerta del mismo escalón en el mismo episodio. Volver a la banda
no cierra las alarmas abiertas ni borra el ancla o la evidencia. El aviso local
y el contable pueden coexistir porque documentan comprobaciones distintas.
Estos umbrales son operacionales de sospecha, no límites metrológicos certificados.
Cambios de calibración, factor K24 o contador incompatible dejan el balance no
verificable. No se permite sustituir el ancla automáticamente; la conciliación
auditada para cambiarla queda como procedimiento de puesta en marcha pendiente,
sin botón de reajuste que pueda borrar pérdidas. El primer anclaje es una
medición estable, no certificación de inventario inicial.

## Correcciones de pantalla

- Una base vacía no representa un estanque vacío: muestra «Sin lectura» y porcentaje «—».
- Un cero realmente medido continúa siendo válido.
- Una lectura mayor de 180 s, otro arranque, sensor deshabilitado o controlador
  sin reporte reciente no se presenta como nivel vigente ni como OCIO conectado.
- Se conserva el último valor con la etiqueta «Última lectura disponible»,
  su fecha original y el estado «Actualización pendiente» o «Revisar sensor».
- Porcentaje y litros usan la misma muestra; el porcentaje muestra hasta una
  decimal para evitar esconder cambios pequeños por redondeo entero.
- El estado antiguo de recepción deja de presentarse como una recepción en curso.

La presentación principal usa **un volumen de referencia estable** cuando hay
variación acotada. Para las observaciones de 440/450 mm del modelo geométrico:
**786 L**, **31,4 %**, con **«Variación observada: ±13 L»** en segundo plano.
El detalle conserva 773,7703–798,3587 L. La referencia es el centro redondeado;
no se presenta como una lectura puntual recuperada ni como precisión certificada.
El margen secundario describe la variación observada, sin incluir sesgo de aforo
ni error de calibración. El caso normal conserva su volumen y no añade ese margen.

La pantalla distingue lectura vigente, validación del ciclo, actualización
pendiente, reinicio y falla. El estado del filtro viaja por separado del valor,
por lo que informar «Validando lectura» no renueva la fecha del inventario.
Se muestra la misma referencia en Resumen, Histórico y Sistema; la cuadratura
usa siempre los límites originales. Una diferencia que abarca cero se presenta
«En observación»; una pérdida demostrada por ambos límites indica «Al menos N L».

Los intervalos se guardan en `fuel_level_ranges` y el estado de validación en
`fuel_level_quality`. No se introduce el centro en el detector de recepciones
ni en la curva histórica de puntos. Al volver a lecturas puntuales, el detector
de recepciones vuelve a validar su referencia. La pantalla de ejemplo
`/nivel-demo` usa datos simulados y no escribe en el inventario de terreno.

La exactitud física de los litros aún depende de configurar y contrastar el
OCIO en terreno. La nueva presentación no cambia esa condición.

## Geometría del Kingspan FuelMaster 2500

Fuentes aportadas: `plano_especifico_fm2500.pdf`, anexo 1.7 (tanque interior),
y `PLANO ESTANQUE INTERIOR EN ESPAÑOL.png`. El PDF incluye además los anexos
1.5/1.6 de conjunto y contención exterior; sus cotas no sirven como volumen del recipiente de combustible.

Se adopta el diámetro indicado Ø1.255 mm: `r = 627,5 mm`. La indicación R628 es
compatible con redondeo del plano. Los 1.300 mm incluyen la envolvente/nervaduras;
no se toman como altura líquida circular. El tramo recto se aproxima a 1.924 mm
y el largo total es 2.260 mm; cada extremo resulta de profundidad axial 168 mm.

Hipótesis: cilindro horizontal nivelado con dos semielipsoides de revolución,
extremos iguales, sin corrección individual de paredes, nervaduras o conexiones.
El plano no define matemáticamente los fondos. Esta es una aproximación
geométrica útil, no una tabla de aforo de fábrica ni un CAD exacto del molde.

### Ecuación de volumen

Para `0 ≤ h ≤ 1.255`, con todas las longitudes en mm y arccos en radianes:

`A(h) = r² acos((r−h)/r) − (r−h) √(2rh−h²)`

`Vgeom(h) = [L A(h) + π a (h² − h³/(3r))] / 1.000.000` litros

con `r = 627,5`, `L = 1.924`, `a = 168`.

El segundo término incluye ambos fondos: juntos equivalen a un elipsoide
completo de semiejes `(a,r,r)`. El modelo ideal a lleno da **2.657,123 L**.

Como aproximación nominal de trabajo:

`V(h) = 0,9408673516 × Vgeom(h)`

El factor corresponde a `2.500 / 2.657,123`. Ajusta el extremo lleno a la
capacidad nominal, pero no prueba que la reducción por nervaduras/espesor se
distribuya uniformemente con la altura, ni que capacidad nominal sea capacidad
geométrica a rebose. El aforo permitirá sustituir esa hipótesis.

| Nivel | Gemelo normalizado | Envolvente ideal sin normalizar | Cilindro equivalente de 2.500 L |
|---:|---:|---:|---:|
| 440 mm | 773,8 L | 822,4 L | 781,6 L |
| 450 mm | 798,4 L | 848,5 L | 805,9 L |
| 460 mm | 823,1 L | 874,8 L | 830,3 L |
| 627,5 mm | 1.250,0 L | 1.328,6 L | 1.250,0 L |
| 1.255 mm | 2.500,0 L | 2.657,1 L | 2.500,0 L |

Decimales mostrados para verificar la ecuación; no expresan la precisión del equipo.

Sensibilidad:

`dV/dh = 0,9408673516 × [2L √(2rh−h²) + πa(2h−h²/r)] / 1.000.000` L/mm.

A 450 mm: **2,466 L/mm**. Pasar 450→440 mm resta **24,588 L**; retirar
20 L desde 450 mm deja aproximadamente **441,87 mm**, una caída de **8,13 mm**.

La implementación de `tank_geometry.py` incluye volumen directo, inversa,
sensibilidad y las distintas interpretaciones del módulo OCIO.

## Configuración recomendada del OCIO

Usar la [guía para la tabla Kingspan](configuracion-ocio-tabla-kingspan.md):
forma C rectangular virtual, altura 1.300 mm, ancho y profundidad 1.000 mm,
visor en mm. Su finalidad es transmitir altura lineal; los litros los obtiene
el PLC de la tabla del fabricante. Aplicar los cambios de OCIO y software
coordinadamente, después de verificar la señal y recalcular los relés en uso.

## Ajuste preliminar anterior para el OCIO — retirado

**Recomendación retirada tras encontrar la tabla del fabricante.** La
[verificación BFM02500DG](verificacion-tabla-fabricante-fm2500.md) muestra que
la curva normalizada siguiente no reproduce los puntos publicados. Los
parámetros se conservan como antecedente; no aplicar el ajuste 1.255 × 2.021 mm
con esa corrección final. Lo reemplaza la guía anterior.

| Parámetro | Valor propuesto |
|---|---|
| Unidades | mm y litros |
| Forma | Cilindro horizontal: escoger la figura de eje horizontal |
| Diámetro/altura circular | 1.255 mm |
| Longitud axial equivalente | 2.021 mm |
| Capacidad resultante del cilindro | Aproximadamente 2.500,02 L |
| Corrección posterior | Invertir el porcentaje de volumen del cilindro y aplicar V(h) del gemelo |
| Densidad | Densidad real del combustible; 0,840 kg/dm³ a 20 °C es la referencia de fábrica para gasóleo, no una medición del combustible instalado |
| Compresor | Conservar funcionamiento automático; el filtro del PLC no requiere fijar su período |

La longitud equivalente se calcula como `2.500 × 10^6 / (π × 627,5²) =
2.020,983 mm`. Es un parámetro de aproximación, no reemplaza los 2.260 mm
físicos del plano. Verificar qué casilla corresponde a diámetro y cuál al eje
longitudinal en la versión del menú instalada; no intercambiarlas.

Para corregir la altura, usar `CALIBRATION → LEVEL` con una medida independiente
y confiable desde el mismo fondo de referencia y el mismo combustible. PIUSI
recomienda un nivel de al menos 70 % del máximo a medir: para 1.255 mm son
**878,5 mm** (aproximadamente 880 mm). La sonda debe quedar correctamente apoyada.
No cambiar la densidad para forzar que los litros coincidan: eso altera el nivel.
Si se conoce con fiabilidad la densidad, puede utilizarse `CALIBRATION → DENSITY`.
[Manual PIUSI M0073B, calibración](https://www.oilybits.com/downloads/PIUSI_OCIO_INSTRUCTIONS.pdf).

El manual PIUSI del módulo 4–20 mA establece dos comportamientos:
con estanque configurado transmite porcentaje de contenido; sin estanque
configurado transmite altura respecto de 4 m. También requiere apagar y
encender después de cambiar la configuración para que el módulo la relea.
[Manual PIUSI 018280000, pp. 3–4](https://www.tanksrus.co.uk/assets/media/2021/06/18/piusi-ocio-4-20ma-gauge-instructions.pdf).

Con cilindro horizontal, la cadena correcta es:

`ADC → tensión → fracción de volumen OCIO → inversa del segmento circular → h → V(h)`.

Si `p` está entre 0 y 1, resolver `A(h)/(πr²) = p`. Es monótona y se resuelve
por bisección; no requiere un polinomio arbitrario. Después evaluar el gemelo.
La corrección respecto al cilindro nominal es como máximo unos 10,3 L **entre
estos dos modelos**, no un límite del error frente al estanque real.

**Actualización:** `fm2500_horizontal` está retirado de la configuración operativa.
Se implementó `tank_level.volume_conversion = "fm2500_manufacturer"`, con los
14 puntos de la tabla seleccionada por el usuario. La conversión geométrica
descrita arriba queda como antecedente, no como recomendación de instalación.
Por solicitud del usuario, la tabla se habilita con escala objetivo 0–1.300 mm
y `ocio_calibration_pending = true` hasta confirmar la salida de altura y sus
extremos eléctricos. Los candidatos quedan en diagnóstico, sin convertirse en
inventario confirmado. Ver el [contrato de entrada y la transición de calibración](verificacion-tabla-fabricante-fm2500.md).
La firma evita comparar como pérdida física referencias de curvas diferentes.

Calibración pendiente: posición del extremo de sonda y cero real, desnivel,
densidad configurada, respuesta del convertidor y lecturas pareadas
`nivel OCIO / porcentaje OCIO / tensión PLC / litros por patrón`. Contrastar
varios niveles, no ajustar sólo un punto. La salida instalada 0–9,80 V elimina
el cero vivo: 0 V puede significar vacío o falla; debe comprobarse en terreno.

## Qué permite concluir sobre una extracción de 20 litros

El manual especifica ±1 % del fondo de escala después de calibrar y
repetibilidad ±0,5 % del fondo de escala; no son porcentajes de los litros
restantes. Mediar muestras reduce parte del ruido, pero no elimina error de
geometría, sesgo, deriva ni cuantización.
[Manual PIUSI M0073B, especificaciones](https://www.oilybits.com/downloads/PIUSI_OCIO_INSTRUCTIONS.pdf).

El fondo de escala debe identificarse en la variante instalada; no se puede
transformar automáticamente ±1 % FS en ±25 L por llamar «2.500 L» al estanque.
Si se aplica a 4.000 mm, ±1 % son ±40 mm; en el modelo cerca de 450 mm eso
representa aproximadamente ±100 L. Para la medida hidrostática también importa
la referencia de presión/densidad indicada por el fabricante.

La salida del módulo documentado tiene DAC de 8 bits, paso 78,125 µA:
aproximadamente 0,488 puntos porcentuales del tramo 4–20 mA. Como volumen de
2.500 L equivale a unos 12,2 L; en el modo de altura 0–4 m equivale a 19,53 mm
(unos 48 L cerca de 450 mm). Una lectura ADC con más dígitos no recupera
resolución que la señal analógica nunca transmitió.

El salto físico observado de 10 mm ya representa unos 25 L en esa zona.
Por tanto, el código puede alertar una **diferencia observada de 20 L**, pero
el OCIO actual no permite garantizar que toda extracción real de 20 L se
distinga de ruido. La alarma debe decir «posible extracción», no «robo confirmado».

Para cerrar físicamente el riesgo: detección independiente de apertura/acceso
respaldada por batería, registro con respaldo eléctrico para toda la cadena de
nivel, y/o un sensor cuya incertidumbre total calibrada sea suficientemente
menor que 20 L. Un objetivo de diseño útil es error total por lectura menor de
5 L (aproximadamente 2 mm cerca de 450 mm), incluyendo aforo y electrónica.
Esto debe verificarse con ensayos; no es una prestación atribuible al OCIO.

## Ensayo de aceptación

1. Confirmar modelo/revisión del tanque, referencia de altura y curva aplicable
   tras revisar la tabla BFM02500DG; registrar los ajustes OCIO antes de cambiarlos.
2. Comparar alturas y señal en varios niveles con combustible en reposo.
3. Confirmar geometría/aforo; activar la corrección acordada en el PLC.
4. Registrar una referencia estable; hacer un despacho K24 conocido y verificar
   que no se clasifica como pérdida fuera de manguera.
5. Con operación supervisada, registrar referencia, desenergizar y extraer
   20 L medidos directamente. Al restaurar, comprobar evidencia y alerta o estado
   no verificable. Repetir a distintos niveles y sin extracción como controles.
6. Probar sensor ausente, 440↔450 mm alternante, reinicio durante verificación y
   falta de red. No aprobar la detección garantizada de 20 L sólo con una prueba favorable.

## Validación y despliegue

Las pruebas cubren reinicios, diferencias sin K24, consumo medido, banda gris,
falta de estabilidad, lecturas inválidas, nuevo arranque y cambios de calibración.
La ecuación se contrasta con integración numérica independiente, monotonía,
simetría, extremos e inversa. La pantalla y API también tienen pruebas de regresión.

Validación previa a la alarma eléctrica: **314 pruebas Python y 87 pruebas web aprobadas**, compilación
y comprobación de tipos aprobadas. Incluye 30 minutos de alternancia continua
sin falsa falla de estabilidad, rechazo del pulso de presión de 15 s, pérdida
externa superpuesta al pulso, rango conservado en pantalla y almacenamiento,
estado del filtro que no altera la fecha de lectura, y alarmas basadas en el
faltante mínimo. Los ensayos usan bases aisladas; no se insertaron muestras
de robo de prueba en el inventario de la aplicación.

La alarma eléctrica añade pruebas de persistencia sin red, recuperación tras
reinicio, actualización sin duplicados, ausencia de falsas alarmas en un reinicio
normal y reversión conjunta de evento y alarma ante un fallo de escritura.
La prueba de la API confirma que aparece en el listado de alertas con prioridad
alta, mantiene la hora original y conserva la revisión humana.
Resultado: **316 pruebas Python aprobadas** y prueba de integración de cortes
y alarmas web aprobada. Se reutiliza la API de alertas existente, sin cambios
en el código de la aplicación web.

Actualización del 8 de septiembre de 2026: se desplegó en el PLC por Tailscale
la versión edge 0.3.21 y web 1.9.18, con respaldo y migración comprobada sobre
copias. La tabla Kingspan queda activa y la calibración física pendiente para
el 9 de septiembre. Se mantienen K24, control, alarma eléctrica y adquisición
ADC; la cuadratura volumétrica espera la confirmación de calibración. Ver
[registro del despliegue](despliegue-alarmas-nivel-2026-09-08.md).
El identificador de Sites guardado en `web/.openai/hosting.json` devuelve
«Sites project not found», por lo que esa publicación no está disponible.
No se creó un sitio sustituto ni se alteró el despliegue operacional existente.
