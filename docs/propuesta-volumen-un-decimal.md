# Propuesta: volúmenes con un decimal

Estado: implementada localmente para revisión; pendiente de despliegue web y del controlador.

## Regla

Todo volumen presentado usa exactamente un decimal, coma decimal y punto de miles: `2.500,0 L`. Se redondea al décimo más cercano; los empates se resuelven alejándose de cero (`1,25 → 1,3`; `−1,25 → −1,3`). No se trunca sistemáticamente, para evitar subestimar los consumos. Se elimina el cero negativo.

| Medición original | Presentación |
| --- | --- |
| 38,933 L | 38,9 L |
| 1,64 L | 1,6 L |
| 6,7 L | 6,7 L |
| 17,98 L | 18,0 L |
| 0 L | 0,0 L |
| 0,01 L | 0,0 L |

Un volumen positivo menor a 0,05 L puede verse como 0,0 L. Su registro, clasificación y valor interno se conservan; un dato ausente se muestra como «—», nunca como cero.

## Alcance preparado

- Tabla de transacciones y detalle de carga.
- Resumen, adopción, historial, niveles y cuadratura de inventario.
- Ejes, etiquetas y ayudas de gráficos; los datos se suman antes del redondeo visual.
- CSV de transacciones, historial y exportación de niveles. Usan un decimal y punto decimal, sin separador de miles, para mantener la convención de intercambio existente.
- Formularios de recepción y conciliación en décimos de litro. Confirmar o modificar únicamente el respaldo documental conserva la precisión original del volumen.
- Nuevos textos de alertas web y del controlador Python, incluidos los pulsos K24 sin autorización.

## Tratamiento de incertidumbre

Los intervalos se presentan con un decimal, redondeando el límite inferior hacia abajo y el superior hacia arriba. Así, `773,77–798,36 L` se presenta como `773,7–798,4 L`, sin estrechar artificialmente el rango. Se conserva la estabilización existente de la referencia OCIO y su estimación conservadora de variación; solo cambia su formato visible.

## Integridad y despliegue posterior

No se modifica la precisión de telemetría, pulsos, base de datos, API numérica ni respaldo JSON. Tampoco se cambian umbrales de detección, calibración o clasificación. Los totales se calculan con los datos disponibles antes de formatearlos; pueden diferir de la suma manual de filas ya redondeadas.

Los textos históricos de auditoría y las notas libres se conservan tal como fueron registrados. La regla se aplica a los campos numéricos presentados y a las nuevas alertas generadas por el programa. Para estas últimas se requiere actualizar tanto la web como el controlador en el despliegue posterior. No se necesitan migraciones de datos para este cambio.

El directorio contiene trabajo previo de otras funcionalidades. Esta propuesta no autoriza ni ejecuta su despliegue; la selección de la versión a publicar debe considerar ese trabajo por separado.

## Validación

Se incluyen casos de redondeo decimal, empates positivos y negativos, cero, miles, ausencia de datos, CSV, suma antes de redondear, intervalos conservadores y conservación del volumen al revisar documentos. Se ejecutan compilación web, comprobación TypeScript y las suites web y Python.
