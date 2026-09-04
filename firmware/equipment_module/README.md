# MIM XIAO ESP32-C3

Firmware de producción `0.6.2` para el Módulo Identificador de Máquina (MIM).
El alta inicial usa Wi‑Fi privado con la Raspberry Pi; la operación de carga usa
exclusivamente BLE 4. No existe lectura ni telemetría de batería.

## Ciclo de vida

1. Un MIM sin asignación permanece despierto y se asocia al AP privado
   `FuelEdge-RPi` para completar el enrolamiento Wi‑Fi 2.
2. Raspberry y MIM se autentican mutuamente mediante HMAC-SHA256, nonces de
   256 bits y dominios separados para desafío, solicitud, respuesta y recibo.
   La clave individual nunca circula por Wi‑Fi.
3. La asignación se escribe como transacción fail-closed en NVS. Tras el acuse
   durable de la Raspberry, el MIM reinicia y entra directamente a deep sleep.
4. En operación normal no hay timer ni búsqueda autónoma. Un click en el
   pulsador D1/GPIO3 despierta el MIM y abre una ventana BLE continua y fija de
   60 segundos.
5. El validador conecta, autentica el MIM por desafío-respuesta y envía la
   primera concesión de sesión firmada. Mientras la carga siga autorizada,
   renueva una concesión de 30 segundos cada 5 segundos.
6. Un cierre firmado, el vencimiento de la concesión o 60 segundos sin enlace
   llevan nuevamente a deep sleep. Una pulsación repetida no extiende la ventana.

Un arranque en frío de un MIM ya enrolado también duerme inmediatamente. La
única excepción operacional es la autoverificación de 5 segundos posterior a
una OTA pendiente; no es un wake periódico.

## BLE 4 y seguridad

MIM y validador deben desplegarse juntos con BLE 4. El anuncio contiene sólo:

```text
magic "FE" | protocol=4 | flags
```

La identidad GATT contiene `module_id`, `equipment_id`, `site_id`, nombre,
estado de claim y firmware; no contiene batería. La potencia se configura en
`+20 dBm` tanto para anuncios como para la conexión. Los anuncios salen cada
100–150 ms durante la ventana de 60 segundos.

El enlace seguro tiene dos direcciones de autenticación:

- El validador envía un desafío aleatorio de 256 bits. El MIM genera su propio
  nonce de 256 bits y responde `module_nonce || HMAC-SHA256`, ligado a ambas
  identidades y a los dos nonces.
- Cada `HOLD` o `CLOSE` del validador lleva HMAC, ambas identidades, ambos
  nonces y un contador estrictamente creciente. Un peer que no conoce el
  secreto no puede mantener el MIM despierto ni cerrar una sesión válida.

Una conexión que no completa el primer intercambio en 5 segundos se corta. Al
desconectar se borran desafío, nonce, contador y lease. El binario de producción
del validador usa `VALIDATOR_ALLOW_LEGACY_EQUIPMENT=0`.

## Alcance

`+20 dBm` entrega margen suficiente para el objetivo de 5–10 m con línea de
vista, pero el firmware no puede garantizar por sí solo el alcance físico. La
liberación exige:

- antena U.FL de 2,4 GHz conectada antes de transmitir;
- gabinete, orientación y cableado definitivos;
- autenticación completa a 5 m y 10 m, no sólo detección del anuncio;
- RSSI medido y umbral del validador calibrado en el montaje real.

## Autonomía de referencia

Para una celda 1S de 3,7 V y 3000 mAh, usando un presupuesto conservador de
80 % de capacidad útil, 44 µA medidos en deep sleep y 45 mA promedio durante
una ventana BLE completa:

```text
sueño anual:        0,044 mA × 8760 h = 385 mAh
un click de 60 s:   45 mA × 1/60 h    = 0,75 mAh
7 clicks/día:       0,75 × 7 × 365    = 1916 mAh
total anual:                              2301 mAh < 2400 mAh útiles
```

Así, el objetivo de 12 meses se cumple con hasta siete búsquedas completas por
día bajo esas hipótesis. Un enlace que cierra antes consume menos. La aceptación
final debe medir corriente real de la placa, autodescarga, temperatura y número
de operaciones diarias; no se debe prometer autonomía sólo desde el datasheet.

No instalar divisor hacia A0: el MIM no mide batería y ese divisor agregaría
consumo permanente. La celda 1S protegida alimenta únicamente `BAT+` y
`BAT-`/GND, respetando polaridad y 4,2 V máximos.

## Botón

El pulsador es momentáneo, normalmente abierto, entre D1/GPIO3 y GND. El
firmware usa `INPUT_PULLUP`; en producción se recomienda un pull-up externo de
47–100 kΩ, protección ESD y alivio mecánico. El botón nunca se conecta a BAT+,
5 V ni directamente a 3V3.

Si el contacto continúa en LOW al terminar la ventana, el MIM duerme sin fuente
de wake para evitar un bucle de arranque. Tras liberar el botón se necesita un
reset o ciclo de energía para recuperar esa falla física.

## Identidad y alta fresca

Cada MIM tiene un `module_id` y secreto aleatorio exclusivos. Para limpiar una
asignación se borra NVS o se mantiene D1 durante veinte segundos en un arranque
de servicio o al despertar desde deep sleep; el firmware espera la liberación y
reinicia con la asignación limpia. Esto conserva la identidad compilada. Rotar identidad exige cambiar
atómicamente el header privado y el registro protegido de la Raspberry.

```bash
python3 tools/provision_xiao.py equipment-module-0001 \
  --header firmware/equipment_module/include/equipment_secrets.h \
  --registry equipment-registry.toml

python3 tools/configure_xiao_enrollment_network.py \
  --settings validator-ap.txt \
  --header firmware/equipment_module/include/equipment_network_secrets.h
```

Compilar y cargar:

```bash
platformio run -d firmware/equipment_module -e seeed_xiao_esp32c3
platformio run -d firmware/equipment_module -e seeed_xiao_esp32c3 \
  -t upload --upload-port /dev/cu.usbmodem101
```

Un alta de fábrica realmente fresca puede ejecutar primero `-t erase`; sólo se
hace después de comprobar que el header y el registro secreto respaldado
pertenecen a la misma unidad.

La prueba física está en
[`docs/mim-battery-acceptance.md`](../../docs/mim-battery-acceptance.md) y el
cableado del botón en
[`docs/mim-button-wakeup.md`](../../docs/mim-button-wakeup.md).
