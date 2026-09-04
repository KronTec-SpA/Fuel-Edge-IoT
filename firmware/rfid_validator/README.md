# Firmware del validador — Arduino Nano ESP32

Implementa el extremo ESP32 del contrato MQTT/TLS del RPi:

```text
presentation -> challenge -> proof -> decision -> credential.presence
```

Usa el cliente `esp-mqtt` incluido en el core ESP32 para publicar y suscribirse
con QoS 1 y autenticación TLS mutua. El JSON coincide con
`fuel_edge.validator_link.ValidatorMessageCodec`.

## Enrolamiento físico de piloto

1. Copiar `include/validator_secrets.example.h` a
   `include/validator_secrets.h` y completar Wi-Fi, certificados y broker.
2. Mantener `VALIDATOR_MIFARE_CLASSIC_CARD = 1` y
   `VALIDATOR_SIMULATED_CARD = 0` para el piloto físico.
3. Compilar con PlatformIO para `arduino_nano_esp32`.
4. Abrir una orden de enrolamiento desde la app y mantener una MIFARE Classic
   nueva sobre el RC522 hasta la confirmación.

Los comandos de diagnóstico son `b` para repetir la melodía y `s` para mostrar
Wi-Fi, IP, MQTT, sesión, umbral RSSI y versión detectada del RC522. `p` sólo
funciona si el modo simulado fue habilitado explícitamente.

Cada operación física reintenta la selección, autenticación y personalización
de la tarjeta frente a lecturas transitorias del RC522. El monitor serie informa
además el tipo PICC y SAK detectados: una MIFARE Classic compatible continúa el
flujo; un tag de otra tecnología se rechaza explícitamente sin dejar la ventana
web esperando una falsa confirmación. Dos tonos largos confirman un enrolamiento
terminado, mientras tres tonos cortos siguen indicando rechazo.

Desde `0.4.5`, una ventana web de enrolamiento o identificación usa WUPA para
despertar también una tarjeta que ya estaba apoyada o quedó en HALT durante la
apertura. En ese flujo basta centrar el tag y mantenerlo quieto: no es necesario
retirarlo y volver a presentarlo. Las autorizaciones normales conservan REQA
para que una credencial rechazada no reinicie sesiones en bucle.

La misma versión interpreta el payload MQTT retenido vacío del tópico de
enrolamiento como el cierre normal de la ventana. Las consultas consecutivas ya
no provocan una falsa saturación del buzón ni pagan la espera de reconexión de
15 segundos que podía acumularse más de una vez.

Durante el enrolamiento se personaliza el sector 1 con una Key A diversificada
por UID desde una raíz aleatoria del sitio. En usos posteriores el sector debe
autenticar y conservar su marcador antes de que el validador emita la prueba
HMAC hacia la Raspberry. La raíz se rota con `tools/rotate_nfc_master.py`, se
mantiene fuera del repositorio y coincide con el registro `0600` del RPi.

MIFARE Classic y RC522 siguen siendo hardware de piloto: Crypto1 es legado y no
satisface el requisito de credenciales AES modernas. Para producción definitiva
se mantiene como bloqueo la migración a DESFire EV3 (o equivalente) y un lector
compatible; el software no debe esconder esa diferencia.

## Entradas, salidas y buzzer

El montaje acordado usa el bus SPI estándar del Arduino Nano ESP32:

| Señal | Nano ESP32 | Dirección desde el Nano |
|---|---|---|
| RC522 SDA/SS | `D10` | salida |
| RC522 SCK | `D13` | salida |
| RC522 MOSI | `D11` | salida |
| RC522 MISO | `D12` | entrada |
| RC522 RST | `D5` | salida |
| Buzzer I/O | `D8` | salida |
| RC522 y buzzer VCC | `3V3` | alimentación |
| RC522 y buzzer GND | `GND` | tierra común |

`IRQ` del RC522 queda sin conectar y el RC522 nunca debe alimentarse con 5 V.
Desde `0.6.2`, el firmware controla `RST/D9` exclusivamente como salida y lo
mantiene activamente en nivel alto después de cada reinicio físico. Así evita
que `NRSTPD` quede flotante y apague el lector en módulos sin un pull-up externo
suficiente. El arranque sólo acepta versiones conocidas del RC522 (`0x88`,
`0x90`, `0x91` o `0x92`); valores espurios como `0xEE` ya no declaran el lector
listo.

Desde `0.6.3`, el montaje usa `D5` para `RST` y deja `D9` libre. La reasignación
evita la conexión intermitente observada en el validador piloto sin cambiar el
bus SPI ni el buzzer.

El buzzer pasivo se excita con una onda cuadrada de 4 kHz y emite un bip corto
al leer, uno largo si la Raspberry autoriza una carga normal y tres cortos si
rechaza. Una tarjeta maestra autorizada reproduce una fanfarria exclusiva de
Sol6–Do7–Mi7–Sol7 que dura aproximadamente 0,5 s. En un buzzer activo se usa la
firma rítmica equivalente de dos pulsos cortos y uno largo. La
frecuencia se puede ajustar con `BUZZER_FREQUENCY_HZ` si su resonancia entrega
más volumen en otro punto. Para usar un buzzer activo, configurar
`BUZZER_PASSIVE = 0`; si además es activo en nivel bajo, configurar
`BUZZER_ACTIVE_HIGH = 0`.

Al arrancar reproduce cuatro notas ascendentes de un arpegio de Do mayor:
Do7–Mi7–Sol7–Do8. La última nota se mantiene ligeramente más tiempo para marcar
que la inicialización terminó.

Acoplar el llavero RFID dispara el flujo físico y debe quedar presentado sobre
el RC522 durante toda la carga. Una credencial no enrolada se rechaza en
autorizaciones normales; sólo una orden de enrolamiento abierta por un
administrador permite personalizarla y vincularla a un operador.

## Permanencia de la llave y corte

Después de autorizar, el validador verifica el mismo UID cada 100 ms. Una vez
por segundo vuelve a autenticar el sector y publica `credential.presence` con
QoS 1. Una lectura ausente aislada no corta: el retiro debe mantenerse durante
300 ms para filtrar ruido del RC522. Al confirmarlo publica la ausencia y la
Raspberry desenergiza `R0.1`.

La Raspberry mantiene además un permiso de presencia de 2,5 s. Si deja de
recibir heartbeats —por reinicio, falla del Nano o pérdida no notificada— abre
el circuito. Cuando MQTT declara una desconexión, el corte se ordena de
inmediato. Para iniciar otra carga, el operador debe retirar y volver a acoplar
el llavero.

Desde `0.3.9`, el callback de red sólo suscribe y copia mensajes a un buzón
acotado; NFC, BLE y NVS se operan exclusivamente desde `loop()`. Si el buzón se
satura o llega un mensaje fragmentado fuera de contrato, el validador cierra la
sesión, cuenta el incidente y fuerza la resincronización MQTT. El arranque espera
Wi-Fi como máximo 30 s y luego sigue recuperándolo en segundo plano, con ahorro
de energía Wi-Fi desactivado para estabilizar la coexistencia con BLE.

## Enlace con el tractor

El validador elige el anuncio de equipo más fuerte, conecta de inmediato y toma
cinco muestras RSSI durante la conexión. Después lee la identidad GATT y
autentica `module_id + equipment_id` con un desafío aleatorio HMAC-SHA256. El
protocolo v3 añade un nonce nuevo generado por el propio MIM en cada conexión.
Sólo una entrada exacta en su registro MIM activo puede producir
`authenticated=true` hacia la Raspberry; módulos desconocidos, revocados,
reasignados sin autorización o con clave incorrecta se rechazan.

La Raspberry distribuye automáticamente las claves activas de
`/etc/fuel-edge/equipment-registry.toml` por el tópico MQTT/TLS retenido
`.../{validator_id}/registry`. La instantánea es autoritativa, está ordenada,
incluye una huella SHA-256 de generación y admite hasta 32 MIM por validador.
El Nano valida la instantánea completa antes de reemplazar la anterior, la
persiste en NVS y confirma por `.../{validator_id}/registry/status` la misma
generación y cantidad. Si el acuse no coincide, la Raspberry reintenta cada
30 s; si cambia el archivo protegido, detecta el cambio dentro de 5 s y publica
la nueva generación. Reiniciar cualquiera de los dos extremos no requiere una
acción del usuario: MQTT conserva la última instantánea y el Nano conserva su
copia válida.

`TRUSTED_EQUIPMENT` queda únicamente como respaldo de fábrica para arrancar sin
una copia MQTT previa. No es necesario recompilar ni reflashear el validador al
incorporar o revocar tractores. Las claves viajan sólo por la red local con TLS
mutuo y ACL: exclusivamente la identidad de la Raspberry puede escribir el
registro, y exclusivamente el validador correspondiente puede leerlo. En
producción también se exige cifrado de flash para proteger la copia NVS.

Desde `0.6.0`, cuando está libre el validador recorre BLE activamente en cortes
de 350 ms. Al detectar el anuncio de un MIM registrado, conecta de inmediato,
valida identidad, nonce y HMAC, abre una ventana exacta de 60 s y publica un
heartbeat de presencia cada segundo. El mapa puede mostrar entonces el MIM como
visible antes de que exista operador o permiso de carga; un anuncio sin esa
autenticación nunca se publica como observación confiable.

Desde `0.6.1`, cada heartbeat vuelve a consultar el RSSI de la conexión BLE y
publica esa muestra actualizada. La Raspberry reemplaza la observación y el mapa
la consulta cada segundo durante los 60 s completos. Si una consulta RSSI falla,
se conserva la última muestra válida en vez de publicar el centinela `0 dBm`.

Durante esos 60 s el operador presenta y mantiene su tag sobre el RC522. La
presentación reutiliza la sesión BLE ya autenticada, de modo que la Raspberry
valida conjuntamente credencial, operador, asociación y equipo sin un segundo
escaneo. Una tarjeta rechazada puede reemplazarse mientras quede tiempo, pero no
extiende el plazo original. Al vencerlo, el validador cierra criptográficamente
la sesión del MIM y vuelve a buscar. Si una tarjeta llega antes que el MIM, se
conserva como compatibilidad el flujo anterior con un único escaneo posterior a
`equipment_required`.

Una tarjeta maestra válida sigue usando la ruta rápida de 5 s sin requerir MIM.
Para una carga normal, el tag debe permanecer presente durante toda la carga;
su retiro corta el permiso de manera fail-safe.

Al autorizarse la carga, el validador renueva la vigilia del módulo. Si la
conexión cae intenta reautenticar; después de 20 s continuos publica la pérdida
a la Raspberry. La caída de MQTT termina la carga en modo
seguro: la Raspberry corta al detectar la desconexión o, como respaldo, al
vencer el permiso RFID de 2,5 s.

Desde `0.4.0`, la primera concesión de vigilia se envía inmediatamente después
de autenticar el MIM. Cada `hold-awake` posterior y el cierre llevan un paquete
de 40 bytes con HMAC-SHA256 sobre las dos identidades, el desafío del validador,
el nonce nuevo del MIM y un contador que comienza en 1 y sólo avanza si la
escritura GATT fue confirmada. Un comando capturado en otra conexión o repetido
en la actual se rechaza y no puede mantener el radio despierto.

### BLE 4 sin compatibilidad insegura

El binario 0.6.1 comparte BLE 4 con el MIM 0.6.0 y no recibe batería en el
anuncio, la identidad ni los mensajes MQTT. `platformio.ini` fija
`-DVALIDATOR_ALLOW_LEGACY_EQUIPMENT=0`: producción sólo acepta la respuesta de
64 bytes (`module_nonce + HMAC`) y comandos de sesión firmados de 40 bytes.

El modo aparece por serie como `equipment=session_protocol mode=signed_v4`.
Una respuesta vacía, truncada, de otra longitud o con HMAC incorrecto se
rechaza. `module_id` debe existir previamente en el registro confiable activo.
No volver a habilitar `legacy_32`, ya que sus comandos de vigilia no autentican
al validador.

El administrador cambia el umbral desde **Sistema → Calibración de proximidad
Bluetooth**. La Raspberry lo publica retenido por MQTT/TLS y la interfaz sólo lo
marca aplicado cuando el validador confirma la misma revisión. RSSI no es
porcentaje ni una distancia universal. El comando serie `s` muestra también
`mims`, `registry` y la generación aplicada para diagnóstico local. Las claves
MIM son datos privados de provisión y el archivo real no debe versionarse.

## Actualización remota desde la Raspberry

Desde `0.3.7` el Nano recibe órdenes en `.../{validator_id}/ota/command` y
responde por `.../{validator_id}/ota/status`. No expone un puerto ArduinoOTA ni
acepta una URL arbitraria: sólo descarga
`https://10.42.0.1:8443/{validator_id}/firmware.bin` desde la Raspberry local.

La actualización comienza únicamente con Wi-Fi y MQTT conectados y sin sesión,
llavero, carga ni tractor autorizado. HTTPS exige el certificado cliente único
del Nano; además se valida versión ascendente, tamaño exacto, imagen ESP32 y
SHA-256 completo antes de seleccionar la segunda partición. Tras reiniciar, el
firmware dispone de 90 s para confirmar Wi-Fi, MQTT y RC522. Si no lo logra, el
bootloader revierte automáticamente a la partición anterior.

La compilación fija el core `espressif32@55.3.39`, la tabla con dos slots OTA de
3 MiB y exige `CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE`; una configuración sin
rollback falla al compilar. En el primer arranque OTA también se exige que el
bootloader haya cambiado `ESP_OTA_IMG_NEW` a `ESP_OTA_IMG_PENDING_VERIFY`. Si
no ocurre, el firmware considera antiguo/no confiable al bootloader físico y
vuelve a la partición previa sin aceptar la actualización. Importante:
`firmware.bin` sólo actualiza la aplicación; un equipo provisionado antiguamente
con otro bootloader debe recibir una vez el `firmware.factory.bin` completo por
USB/DFU antes de habilitar OTA desatendida.

`target_firmware` y `nonce` se conservan en NVS después de `healthy` o
`rolled_back` y se vuelven a publicar en cada reconexión MQTT. El recibo se
elimina únicamente cuando el Nano recibe el payload vacío con que la Raspberry
limpia la orden OTA retenida. Así, una caída del broker entre la confirmación y
el acuse no convierte el resultado correlacionado en un `ready` anónimo.

En la Raspberry, soporte técnico sólo necesita ejecutar:

```bash
sudo /opt/fuel-edge/venv/bin/fuel-validator-ota stage \
  /ruta/firmware.bin --version 0.6.3 \
  --config /etc/fuel-edge/config.toml
```

El comando copia la imagen al almacén protegido, publica el manifiesto con QoS
1 y espera `healthy`, `current`, `failed` o `rolled_back`. El usuario de campo
no manipula cables, botones, certificados ni tópicos. Para producción final se
mantiene el requisito adicional de Secure Boot v2 y cifrado de flash mediante
eFuses provisionados en fábrica; TLS mutuo y SHA-256 no sustituyen Secure Boot
frente a acceso físico al chip.
