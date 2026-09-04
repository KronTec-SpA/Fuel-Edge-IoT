# Lote de flasheo MIM — 2026-08-20

Firmware de producción: `0.6.0`  
Placa: Seeed Studio XIAO ESP32-C3, flash 4 MB  
Política energética: botón D1/GPIO3, ventana BLE de 60 s, +20 dBm, sin medición ni telemetría de batería.

## Alcance del QC de esta sesión

Todas las unidades se probaron alimentadas exclusivamente por USB, con la
batería desconectada. En este registro, `QC PASSED` acredita chip, USB, flash,
firmware, identidad, watchdog, estado de enrolamiento y lectura del botón según
lo indicado en cada fila. No acredita todavía polaridad ni tensión de batería,
operación autónoma, calentamiento, corriente de deep sleep, corriente BLE ni
proyección de autonomía. Esas comprobaciones permanecen como `BATTERY QC
PENDING` y deben ejecutarse con instrumental según
`docs/mim-battery-acceptance.md`.

| Unidad | MAC USB/chip | Identidad MIM | Imagen factory SHA-256 | Estado |
|---|---|---|---|---|
| 1 | `ac:27:6e:7f:29:6c` | `equipment-module-7f296c` | `12b246d64836da88c223f8e6b29e2856c4d1c49cfa4aab389064e8b096d99c64` | USB QC PASSED / BATTERY QC PENDING: `0.6.0`, watchdog y enrolamiento Wi-Fi |
| 2 | `ac:27:6e:7d:b0:48` | `equipment-module-7db048` | `06b352c117b2b327e2434749324aaa04eae0f6624614ebabcbb15333d72903cd` | USB QC PASSED / BATTERY QC PENDING: flash, `0.6.0`, watchdog, Wi-Fi y D1 liberado en HIGH |
| 3 | `ac:27:6e:7d:c5:94` | `equipment-module-7dc594` | `c08cce9b1729aa175be341585378f5e8a5a49e150b06f8c8f30cb9cdaa3a31fe` | USB QC PASSED / BATTERY QC PENDING: flash, `0.6.0`, watchdog, Wi-Fi y D1 liberado en HIGH |
| 4 | `ac:27:6e:7f:8d:a4` | `equipment-module-7dd8d4` | Readback `f73257134fa2bc0584838f205e89ba3ed9a7436cdbef8f4ce9958fb0eba2ef54` | PROTECTED / USB QC PASSED / BATTERY QC PENDING: enlazada, `fuel-mim 0.6.0`, deep sleep por USB; no reflasheada |

La identidad y el registro secreto de cada unidad se guardan bajo
`backups/mim-identities/<module_id>/` con permisos privados. Los secretos no se
incluyen en este registro operativo.

La unidad 4 fue identificada antes de cualquier escritura como el MIM ya
enlazado. Aunque su MAC termina en `7f8da4`, su identidad compilada y su NVS son
`equipment-module-7dd8d4`, coherentes con el registro privado respaldado. El
slot `app0` contiene `fuel-mim 0.6.0`, secure version 1, con checksum y hash
válidos; `app1` está vacío. Se conservó un readback privado de 4 MB y no se
ejecutó borrado ni flasheo.

Antes del borrado de la unidad 1 se tomó una copia temporal de sus 4 MB con
SHA-256 `c707fa27bd0624367c767f39816b5b98dc8248b7a018af31239eef430b20a495`.
Antes del borrado de la unidad 2 se tomó una copia temporal de sus 4 MB con
SHA-256 `be81b7108f71519a27be44d100e23ba3d06feb4624a3c1056e1da08f9b56ebff`.

Antes del borrado de la unidad 3 se tomó una copia temporal de sus 4 MB con
SHA-256 `b3273557c0f165aea6c6104aeea0de06fa0dfd1f2dda662ce92b56530393b784`.
La inspección previa identificó la aplicación de fábrica `arduino-lib-builder`
y NVS de calibración/prueba, sin firmware ni asignación MIM.

En la comprobación de botón de la unidad 2, D1 alcanzó repetidamente el umbral
de 8 s y ejecutó la limpieza de asignación. La verificación final, realizada sin
pulsar el botón, volvió a registrar `button=pressed` y
`factory_assignment_cleared`; por lo tanto la unidad no se libera hasta aislar
si el LOW proviene del cableado, del par de patas usado, del pin físico o del
propio GPIO3.

En la prueba de aislamiento posterior, se desconectó el conductor externo de
D1 y la unidad arrancó directamente en enrolamiento, sin `button=pressed`. Esto
aprueba el XIAO, GPIO3 y su pull-up interno; el troubleshooting queda acotado al
pulsador, conector, soldadura o arnés externo.

La prueba final se repitió con el ensamblaje completo y sin accionar el botón:
el arranque volvió a entrar directamente en enrolamiento, sin
`button=pressed`. Se descartó contacto pegado y se determinó que las detecciones
anteriores coincidieron con pulsaciones realizadas durante resets de consola.
La unidad 2 queda liberada como `QC PASSED`.
