# RCA — dos alertas «Validador sin conexión» del 22-08-2026

## Conclusión ejecutiva

Las alertas de las **19:19** y **20:12** no corresponden a dos fallas autónomas demostradas del validador RFID. En ambos casos, el enlace MQTT cayó como consecuencia inmediata de que la Raspberry PLC/edge estaba entrando en una secuencia de apagado ordenado.

La causa física más probable es que el circuito UPS detectó una pérdida de la alimentación principal y activó la entrada de apagado **GPIO24**. La configuración instalada coincide exactamente con el mecanismo documentado por Industrial Shields: `gpio-shutdown` convierte la caída de GPIO24 en un evento `KEY_POWER`, y `systemd-logind` inicia el apagado seguro. El primer corte fue breve y el equipo volvió a arrancar 16 s después; el segundo mantuvo el edge apagado durante 1 h 53 min 10 s.

Existe además un defecto contribuyente en Fuel Edge 0.3.15: el cierre MQTT intencional ejecutado durante un `poweroff`, `reboot` o detención normal del servicio se procesa igual que una desconexión inesperada. Por ello se genera una alerta de prioridad alta titulada «Validador sin conexión» aunque el origen real sea el apagado del controlador edge.

### Nivel de certeza

- **Causa inmediata — apagado del edge:** confirmada.
- **La alerta se genera durante el cierre normal del servicio:** confirmada por auditoría y código desplegado.
- **Disparador físico — señal UPS por pérdida de alimentación principal:** confianza alta, pero no absoluta. El journal de los boots afectados no se conservó porque `journald` está configurado con `Storage=volatile`. No es posible distinguir retrospectivamente entre pérdida real de 12–24 V, apertura de un interruptor, falso contacto, señal espuria del UPS/GPIO24 o un `poweroff` manual local.

## Línea de tiempo

Horas en `America/Santiago` (UTC−4). Las marcas de auditoría originales están en UTC.

| Evento | Primera ocurrencia | Segunda ocurrencia |
|---|---:|---:|
| Auditoría `validator_link_lost` | 19:19:46.675 | 20:12:41.826 |
| `manual_mode_aborted`, razón `service_stopping`; relé 1 → 0 | 19:19:46.682 | 20:12:41.835 |
| Sistema registra apagado ordenado | 19:19:48 | 20:12:43 |
| Nuevo boot | 19:20:04 | 22:05:53 |
| Edge vuelve a asignarse/operar | 19:20:43.669 | 22:06:31.441 |
| Modo manual se reanuda | 19:20:47.139 | 22:06:34.927 |
| Alerta pendiente se sincroniza a la web | 19:20:49 | 22:06:37 |

La primera alerta quedó en la outbox durante el reinicio y llegó a la web después de volver el servicio. La segunda quedó retenida durante casi dos horas y también se sincronizó recién después del siguiente boot.

## Evidencia

### 1. Base de datos entregada

- Las alertas se originaron a `2026-08-22T23:19:46.675Z` y `2026-08-23T00:12:41.826Z`, equivalentes a 19:19 y 20:12 locales.
- OCIO continuó hasta inmediatamente antes de cada apagado:
  - Primera ventana: 19:19:11.074 → 19:20:59.669; brecha de 1 min 48,595 s y nivel estable en 1.045,7 L.
  - Segunda ventana: 20:12:26.914 → 22:06:47.451; brecha de 1 h 54 min 20,537 s, coherente con el tiempo sin edge.
- No hay un despacho de combustible coincidente con las dos alertas. El sistema sí estaba en modo manual con el relé habilitado, y el cierre del servicio lo desenergizó de forma segura.

### 2. Auditoría durable del edge

Para ambas ocurrencias, `validator_link_lost` fue seguido entre 7 y 10 ms después por:

```text
manual_mode_aborted | manual_mode -> locked | relay_energized=0
reason=service_stopping
```

Esto demuestra que la alarma apareció dentro de la secuencia de detención del proceso, no como un incidente aislado ocurrido mientras el host seguía operando normalmente.

### 3. Registro de boots del sistema

`last -x -F` conserva las siguientes secuencias:

```text
shutdown  2026-08-22 19:19:48
reboot    2026-08-22 19:20:04

shutdown  2026-08-22 20:12:43
reboot    2026-08-22 22:05:53
```

Ambos son apagados gestionados por el sistema operativo. Un corte abrupto sin respaldo o un watchdog duro no producirían la misma marca ordenada de `shutdown` inmediatamente después de que Fuel Edge registró `service_stopping`.

### 4. Mecanismo UPS instalado

La Raspberry tiene activos:

```text
dtoverlay=gpio-poweroff,gpiopin=23,active_low
dtoverlay=gpio-shutdown,gpio_pin=24,gpio_pull=up
```

El dispositivo de entrada del kernel es `soc:shutdown_button@18` —18 hexadecimal equivale a GPIO24— y genera eventos `KEY_POWER`. La documentación oficial de Industrial Shields indica que la UPS lleva GPIO24 a GND cuando pierde la alimentación externa y conserva energía suficiente para un apagado seguro:

- [Raspberry Pi PLC: setup guide for UPS & RTC features](https://www.industrialshields.com/blog/raspberry-pi-for-industry-26/how-to-work-with-ups-and-rtc-in-raspberry-plc-645)
- [Documentación GateBerry](https://docs.industrialshields.com/gateberry/)

El sistema también tiene habilitados `rpishutdown-boot-watchdog.service` y `rpishutdown-pre-poweroff.service`, ambos asociados explícitamente al mecanismo UPS.

### 5. Defecto de clasificación en Fuel Edge 0.3.15

El código desplegado ejecuta esta secuencia al cerrar el transporte:

1. Marca `_started = False`.
2. Publica estado MQTT offline.
3. Llama `client.disconnect()`.
4. Paho invoca `_on_disconnect`.
5. `_on_disconnect` llama siempre al handler de falla, sin comprobar que el cierre fue intencional ni usar `reason_code`.
6. El handler aplica `validator_link_lost` y crea la alerta.

Rutas relevantes del repositorio:

- `src/fuel_edge/mqtt_validator.py`: `close()` y `_on_disconnect()`.
- `src/fuel_edge/main.py`: handler que llama `report_validator_offline()` y `process_validator_disconnect()`.
- `src/fuel_edge/service.py`: creación de «Validador sin conexión».

La alerta previa del 21-08-2026 a las 11:37 local coincide además con el despliegue/reinicio de Fuel Edge 0.3.15, lo que refuerza que una detención planificada del servicio produce el mismo falso positivo.

## Cinco porqués

1. **¿Por qué apareció «Validador sin conexión»?** Porque Fuel Edge aplicó `validator_link_lost`.
2. **¿Por qué aplicó ese evento?** Porque el callback MQTT de desconexión invoca siempre el handler de falla.
3. **¿Por qué se desconectó MQTT?** Porque el servicio Fuel Edge estaba cerrándose durante el apagado del host.
4. **¿Por qué se apagó el host?** Con alta probabilidad, la entrada UPS GPIO24 informó pérdida de alimentación principal; también es compatible con un apagado manual local.
5. **¿Por qué no puede identificarse con certeza el origen eléctrico o humano?** Porque el journal anterior se pierde en cada boot (`Storage=volatile`) y la alerta no registra `reason_code`, boot ID, uptime ni motivo de apagado.

## Impacto

- El fail-safe funcionó: en ambos casos el modo manual se abortó y el relé pasó a desenergizado en menos de 10 ms después del evento de enlace.
- Primera interrupción: aproximadamente 57 s hasta que el edge volvió a asignarse.
- Segunda interrupción: aproximadamente 1 h 53 min 50 s hasta que el edge volvió a asignarse.
- No se encontró evidencia de un despacho coincidente con los cortes.
- La alarma indujo a atribuir el incidente al validador, ocultando la causa primaria de energía/apagado del edge.

## Acciones correctivas recomendadas

### P0 — terreno y alimentación

1. Contrastar los horarios 19:19 y 20:12 con maniobras del tablero, recarga del estanque, microcortes, protecciones y registros de la fuente 12–24 V.
2. Revisar apriete y continuidad de bornes, fuente, tierra, UPS, conector interno y señales GPIO23/GPIO24.
3. Si se confirma que la alimentación nunca se retiró, capturar GPIO24 con un registrador u osciloscopio: una caída espuria también provocaría exactamente esta secuencia.

### P1 — software

1. Introducir una marca de cierre intencional en `MqttValidatorTransport`; durante `close()` se deben limpiar RPC y estado, pero no invocar el handler `validator_link_lost`.
2. Mantener el comportamiento fail-safe para desconexiones inesperadas y códigos MQTT anormales.
3. Emitir, si se desea trazabilidad, un evento distinto y de baja criticidad: `edge_service_stopping` o `edge_power_lost`.
4. Enriquecer las alertas con motivo, `reason_code`, boot ID, uptime, estado del sistema y origen (`mqtt_unexpected`, `service_stop`, `ups_gpio24`).

### P1 — observabilidad

1. Cambiar journald a almacenamiento persistente con límite de tamaño y rotación.
2. Agregar un hook UPS que registre durablemente fecha, boot ID y estado GPIO24 antes del apagado.
3. Publicar una alerta específica de pérdida/restauración de alimentación; no reutilizar «Validador sin conexión».

### P2 — pruebas de aceptación

1. `systemctl restart fuel-edge` no debe crear una alerta de desconexión.
2. `systemctl poweroff` no debe crearla; debe registrar cierre planificado.
3. Una desconexión MQTT inesperada sí debe cortar el relé y crear la alerta.
4. Una prueba controlada de pérdida de alimentación debe registrar el evento UPS y recuperar el servicio al volver la energía.

## Estado al finalizar la revisión (23-08-2026)

- `fuel-edge`, `mosquitto` y `fuel-edge-web`: activos.
- `fuel-edge` y `mosquitto`: `NRestarts=0` en el boot actual.
- Validador conectado al broker: sesión TCP establecida `10.42.0.227 → 10.42.0.1:8883`.
- Cliente edge local conectado al broker en `127.0.0.1:8883`.
- GPIO24: alto, con pull-up; no hay señal de apagado activa.
- `vcgencmd get_throttled=0x0` en el boot actual.
- Sin warnings actuales de `fuel-edge`.

## Limitación forense

No se modificó configuración ni software durante este RCA. La ausencia de logs persistentes del boot anterior impide identificar al 100 % si el flanco de GPIO24 provino de una pérdida real de alimentación, una maniobra deliberada, un falso contacto o una señal espuria. La relación causal entre apagado del edge y las dos alertas sí queda demostrada.
