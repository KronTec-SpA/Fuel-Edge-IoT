# Margen de cuadratura OCIO y K24 — 9 de septiembre de 2026

Política `ocio-observed-plus-error-v1-density-8375`, incorporada en edge 0.3.24 y web 1.9.27.
Sustituye el uso exclusivo de intervalos observados y umbrales fijos en la curva
`field-copec-20260909-linear-v1-b0a652dc4528beeb` del estanque de 2.662 L.
No modifica la tabla aforada, los voltajes de referencia, el certificado de
calibración ni el ancla contable. Las lecturas históricas se conservan sin alterar.

## Parámetros y alcance

- Densidad medida en terreno, informada por el usuario: **837,5 kg/m³ = 0,8375 kg/L**.
  Es evidencia de la medición física; no se leyó ni se escribió el menú del OCIO.
- Manual OCIO M0073B: fondo de escala de **4.000 mm de agua**, exactitud **±1 % del fondo de escala**.
  No se toma 1 % de los 2.662 L ni de la altura configurada de 1.300 mm.
- Error de altura equivalente adoptado: `4.000 × 0,01 / 0,8375 = 47,761194 mm`.
- Resolución reportada: 10 mm. Se agrega medio escalón, **5 mm**, a cada extremo.
- K24: **±1 % del volumen contado** desde la referencia correspondiente.
- La repetibilidad de 0,5 % no se suma otra vez como un error independiente
  a la exactitud y la oscilación observada. No se presume que repetir/promediar
  muestras elimine errores sistemáticos.

Es un presupuesto conservador de los componentes indicados. No certifica la
incertidumbre del aforo, del convertidor, de las recepciones Copec ni de cambios
de temperatura/densidad. Tampoco supone cancelación perfecta del error del OCIO
entre la referencia inicial y la medición actual.

Fuentes: [manual OCIO M0073B](https://www.oilybits.com/downloads/PIUSI_OCIO_INSTRUCTIONS.pdf),
[especificación OCIO publicada por PIUSI](https://www.piusi.com/it/notizie/piusi-ocio-nel-monitoraggio-dei-livelli-di-acqua-in-applicazioni-antincendio),
[especificación K24 publicada por PIUSI](https://www.piusi.com/products/k24).

## Ecuaciones implementadas

Sea `V(h)` la interpolación por tramos de la tabla calibrada. Para cada lectura,
el filtro entrega dos cotas observadas `hmin`, `hmax` (iguales si no hay oscilación).

```
margen_mm = 47,761194 + 5 = 52,761194
OCIO_mínimo = V(hmin − margen_mm)
OCIO_máximo = V(hmax + margen_mm)
```

La expansión se hace alrededor de **ambos extremos**, no alrededor del promedio.
Se aplica también a los extremos de la referencia inicial. Por debajo del dominio
publicado de 135 mm, la cota inferior se abre a cero; por encima de 1.220 mm,
la superior se limita a la capacidad física de 2.662 L. No se extrapola la tabla.
Las cotas en litros se redondean hacia fuera a tres decimales.

Con `K` litros contados por K24 y `R` recepciones aprobadas desde el ancla:

```
esperado_mínimo = referencia_mínima_ampliada + R − K − 0,01 × K
esperado_máximo = referencia_máxima_ampliada + R − K + 0,01 × K
faltante_mínimo = esperado_mínimo − OCIO_máximo
faltante_máximo = esperado_máximo − OCIO_mínimo
```

El registro del consumo sigue descontando `K`, sin corregirlo artificialmente
por el OCIO. El margen K24 se aplica a las cotas de comparación.

## Decisión y presentación

- Alerta de posible pérdida cuando el **faltante mínimo después de los márgenes alcanza 20 L**.
- La cuadratura acumulada escala a 40 y 60 L residuales. No reinicia el ancla
  al cambiar de día ni absorbe diferencias pequeñas como nuevas existencias.
- Si las cotas ampliadas son compatibles con la banda de ±10 L, se muestra
  **«Compatible con el margen»**. Queda guardada la diferencia observada y su evolución.
- Entre 10 y 20 L residuales se mantiene observación; se conserva la histéresis.
- La verificación tras reinicio y el descenso sin flujo K24 usan el mismo cálculo.
  Se mantienen los filtros del compresor, intervalos y tres muestras en reposo.
- Las alarmas históricas no se borran ni se resuelven automáticamente.

El indicador principal conserva el nivel OCIO filtrado y convertido por tabla.
En Sistema → Calibración y mantenimiento, la cuadratura muestra esperado, OCIO
y diferencia observada. Las cotas ampliadas y la densidad están en el detalle.

Ejemplo sin consumo, con lectura y ancla de 2.662 L: ambas cotas ampliadas son
**2.594,113–2.662,000 L**; diferencia observada **0 L**; intervalo de diferencia
**−67,888 a +67,888 L**. No se genera una alarma por ese margen.

**Límite de detección:** una extracción aislada de 20 L puede quedar dentro de
estos márgenes. No se garantiza detectarla con el OCIO. El acumulado se conserva,
pero puede necesitar una pérdida mayor para superar el margen conservador.

## Verificación

355 pruebas Python y 125 pruebas web aprobadas; compilación y TypeScript aprobados.
Incluye expansión de ambos extremos, K24, corte/reinicio, pérdida sin flujo,
ausencia de alarma por 20 L dentro del margen, alarma por pérdida mayor,
conservación del ancla y paridad de PLC/web en 24 combinaciones de nivel/consumo.
Vista revisada en navegador con una base desechable.

Respaldo productivo: `/var/backups/fuel-edge/20260909-uncertainty`.
Despliegue activado a las 15:10 de Chile; verificación real completada a las
**15:14:37** del 9 de septiembre de 2026. Versiones comprobadas: edge 0.3.24 y
web 1.9.27. El chequeo posterior al reinicio quedó `within_uncertainty` con la
nueva política, tres muestras y diferencia observada de 0 L. La API web y
el cálculo instalado en el PLC coincidieron.

El frontend conserva **2.662,0 L / 100 %**; K24 conserva **4.229 pulsos**;
se conservaron los **66 movimientos**, el certificado de calibración y el
ancla contable. No se hizo una nueva calibración ni se creó otra recepción.

Evidencia: [verificación productiva](verificacion-margen-cuadratura-20260909.json)
y [registro de auditoría](auditoria-margen-cuadratura-20260909.json).
