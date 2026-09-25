# Telemetría de combustible — agente edge

Versión actual: **Edge 0.3.26 / Web 1.9.29**. Véase el
[registro de actualización y validación](docs/version-20260925.md).

Control local y auditable para un Raspberry PLC Industrial Shields 19R. La
salida elegida para habilitar la bomba es el **relé R0.1**: con el circuito
cableado entre COM y NO, `HIGH` lo cierra y `LOW` lo abre. La selección está declarada una sola vez en
`config/fuel-edge.toml`.

## Flujo de control

```text
Arranque ──LOW──> LOCKED
                  │
                  ├─ prueba de bomba aprobada ──> R0.1 HIGH (5–60 s)
                  │                                      │
                  │            tiempo solicitado, pulso K24 o falla
                  │                                      └── R0.1 LOW / LOCKED
                  │
                  ├─ modo manual programado ──> R0.1 HIGH hasta el fin
                  │                              │
                  │       tag válido ──> segmento K24 imputado al operador
                  │                              │
                  │       retiro/cambio ──> segmento sin tag, R0.1 sigue HIGH
                  │                              │
                  │       fin, cancelación o falla ──> R0.1 LOW / LOCKED
                  │
                  ├─ credencial rechazada ──> LOW / LOCKED
                  │
                  └─ NFC válido + operador/equipo/asociación/estado válidos
                                      │
                                      └── R0.1 HIGH ──> AUTHORIZED/DISPENSING
                                                               │
                          retiro NFC, pérdida BLE, timeout o falla de control
                                                               │
                                                               └── R0.1 LOW
```

La web no actúa el relé directamente. Desde **Sistema**, un usuario autorizado
puede solicitar una prueba de bomba acotada o programar una ventana de modo
manual; la Raspberry valida el estado, conserva la autoridad sobre R0.1 y
registra cada actuación sobre el PLC.

## Modo Adopción tecnológica

La adopción se modela como un **piso gradual de evidencia**, no como un techo.
Si un operador completa RFID, MIM y asociación durante una etapa inicial, la
carga conserva inmediatamente esa trazabilidad completa. La ruta tiene tres
etapas:

1. **Aprendizaje asistido:** un administrador o supervisor programa una ventana
   acompañada. La faena puede continuar mientras el operador practica despertar
   el MIM, presentar y mantener el RFID y esperar la confirmación. K24, la
   ventana aprobada y la autoridad local sobre R0.1 siguen siendo obligatorios.
2. **Identidad RFID:** toda carga nueva exige un tag vigente y un operador
   activo. El MIM no bloquea la carga, pero cuando valida agrega equipo y
   asociación como evidencia completa.
3. **Trazabilidad completa:** RFID, MIM, equipo, asociación y asignación al fundo
   vuelven a ser el mínimo exigido.

La etapa inicial de una instalación es **Trazabilidad completa** para no reducir
silenciosamente una política existente. Sólo `master` o `administrator` con
`manage_system` pueden moverla, una etapa a la vez, dejando fundamento, fecha de
revisión y auditoría. El edge conserva la última revisión recibida en SQLite y
la interfaz no la marca como aplicada hasta observar el mismo número de revisión
en el controlador.

El sitio presenta el mismo programa desde tres perspectivas: secuencia simple y
confirmaciones para el operador; cobertura, hábito y recomendación no automática
para el encargado agrícola; y porcentaje de litros con RFID, trazabilidad
completa y sesiones asistidas para gerencia. Ninguna recomendación cambia la
etapa por sí sola.

## Organización

- `src/fuel_edge/access.py`: validaciones de credencial, operador, equipo BLE,
  asociación, punto y cadena de control.
- `src/fuel_edge/domain.py`: máquina de estados y única decisión de
  energizar/desenergizar.
- `src/fuel_edge/hardware/industrial_shields.py`: actuación segura de `R0.1`,
  conteo de flancos K24 en `I0.0` y adquisición analógica OCIO en `I0.2`
  mediante `python3-librpiplc`.
- `src/fuel_edge/rfid.py`: autenticación NFC por desafío-respuesta; nunca confía
  sólo en el UID.
- `src/fuel_edge/service.py`: une núcleo, auditoría SQLite y transacciones.
- `src/fuel_edge/application.py`: orquesta las conversaciones del validador sin
  permitirle decidir la asociación ni actuar el relé directamente.
- `src/fuel_edge/validator_link.py` y `mqtt_validator.py`: protocolo versionado
  y transporte MQTT/TLS con QoS 1.
- `firmware/rfid_validator`: extremo Arduino Nano ESP32 del mismo protocolo.
- `firmware/equipment_module`: firmware de bajo consumo instalado en el tractor;
  despierta por botón, anuncia por BLE y prueba su identidad criptográfica.
- `src/fuel_edge/storage.py`: SQLite en WAL y bandeja de salida para sincronizar.
- `src/fuel_edge/web_sync.py`: entrega durable e idempotente de despachos,
  lecturas, alertas y estado al servidor web local.
- `src/fuel_edge/tank_level.py`: contrato de entrada para el adaptador físico
  OCIO, con límites, control de tamaño y rechazo de enlaces simbólicos.
- `src/fuel_edge/config.py`: carga y valida la configuración antes de tocar el
  hardware.
- `web/`: aplicativo Concha y Toro - Monitoreo Combustible para dashboard, mapa de MIMs
  enlazados por RSSI, trazabilidad, operadores, equipos, asociaciones, alertas,
  acceso autenticado y salud del sistema.
- `tools/provision_web_auth.py`: aprovisiona la cuenta maestra con HMAC, PBKDF2
  y secretos de sesión; no guarda el correo ni la contraseña en texto legible.
- `config/fuel-edge.toml`: versión/modelo/canal y parámetros operacionales.
- `deploy/systemd/fuel-edge.service`: arranque automático y corte explícito al
  detener el servicio.
- `deploy/install.sh`: instala sin iniciar la actuación física.

## Reglas implementadas

- Arranque, parada y falla de control ordenan `R0.1 = LOW`.
- En operación normal, sólo una autorización positiva ordena `R0.1 = HIGH`.
- Sólo una cuenta `master` o `administrator` con permiso `manage_system` puede
  solicitar desde **Sistema** una prueba de bomba. Cada solicitud vuelve a
  exigir la clave del administrador y un tiempo de habilitación entre 5 y 60
  segundos. La Raspberry sólo la acepta desde `LOCKED`, sin carga ni flujo no
  autorizado, y vuelve a `LOW` al terminar. La prueba actúa R0.1 sin depender
  del validador; un pulso K24, una falla u otro evento de control sí la
  interrumpen de inmediato. Administrador, duración, inicio y resultado quedan
  guardados como una transacción de prueba en la web y en la base local del
  edge; no existe un comando web genérico para dejar la salida en `HIGH`.
- Una cuenta `master`, `administrator` o `supervisor` puede programar desde
  **Sistema** un inicio y fin de modo manual. La Raspberry sólo inicia la
  ventana desde `LOCKED`, con K24 saludable y sin flujo pendiente; durante el
  período mantiene R0.1 en `HIGH`. El consumo comienza en un segmento sin tag
  y, al presentar una credencial válida, los pulsos K24 siguientes se imputan
  a su operador sin transferirle la propiedad del relé. El retiro, cambio o
  rechazo del tag abre un nuevo segmento sin operador y no interrumpe la bomba.
  Tras la misma inactividad K24 usada en operación normal, cada carga manual se
  cierra, se publica en el histórico y se abre un nuevo segmento conservando la
  imputación vigente, sin terminar el período ni abrir R0.1.
  El fin programado, la cancelación, una falla de control o una falla de
  persistencia abren R0.1. Los segmentos y la sesión quedan en SQLite y se
  recuperan sin duplicar litros después de un reinicio.
- Carga normal: credencial y operador activos; equipo activo, presente y
  autenticado; asociación y asignación al fundo vigentes; punto disponible;
  cadena de control sana.
- Una asignación vencida bloquea nuevas cargas. La renovación exige presencia y
  autenticación BLE del módulo, registra el nuevo fundo y deja auditoría.
- Tarjeta maestra de emergencia: autoriza sin equipo válido, pero mantiene
  operador responsable, controles de salud del punto y cadena de control. Cada
  despacho se marca explícitamente con `is_master`, conserva el equipo como
  nulo cuando corresponde y se sincroniza al histórico como carga excepcional.
- El validador libre busca anuncios BLE en cortes breves. Tras autenticar un MIM
  registrado con BLE 4/HMAC, lo mantiene visible en el mapa y abre exactamente
  60 s para presentar el tag. Una tarjeta normal reutiliza ese enlace y sólo
  autoriza si operador, equipo y asociación son válidos; la maestra conserva su
  ruta rápida de 5 s sin exigir MIM.
- Sólo puede existir una tarjeta maestra activa. El enrolamiento de una segunda
  muestra la tarjeta y el operador anteriores, exige aprobación de un usuario
  con permiso para gestionar operadores, desactiva la credencial previa en la
  web y en el registro privado del edge, y audita solicitud, aprobación y término.
- El llavero RFID debe permanecer presentado. El validador comprueba el mismo
  UID cada 100 ms, confirma su retiro durante 300 ms y reautentica la credencial
  cada 1 s. El retiro confirmado abre el circuito.
- Si se pierde el evento de retiro, la RPi abre el circuito al pasar 2,5 s sin
  un heartbeat RFID autenticado. Una desconexión MQTT confirmada lo abre de
  inmediato y también bloquea cargas nuevas.
- La pérdida BLE confirmada, 60 s sin iniciar flujo, 40 s sin pulsos K24 y las
  fallas de control también abren el circuito.
- Una falla de persistencia durante la autorización corta el relé y lleva el
  núcleo a `FAULT`.
- Cada transición se guarda en SQLite y en la bandeja de sincronización. Los
  pulsos se consolidan por transacción para evitar escrituras innecesarias.
- Un pulso K24 sin una autorización activa abre un incidente crítico independiente
  del estado informado por el relé. El agente acumula el volumen de forma durable,
  alerta inmediatamente y, si el ciclo alcanza 0,12 L, después de 40 s sin flujo
  registra una salida excepcional sin operador ni equipo como posible bypass.
- Un ciclo que acumula menos de 0,12 L permanece abierto durante los 60 s de la
  ventana de inicio. Si no aparece flujo adicional, se registra como
  `Habilitación de bomba`; si llega a 0,12 L o continúa el suministro, todos los
  pulsos —incluidos los iniciales— se publican como despacho clásico.
- Una caída de la web no interrumpe el PLC: los eventos quedan en SQLite y se
  reintentan con espera exponencial. Los identificadores evitan duplicados.
- La web no crea datos ficticios en producción. Cargas, histórico, nivel,
  alertas y estado se reconstruyen con información entregada por el agente.

La configuración del PLC consultada el 08/09/2026 usa
`k24.pulses_per_liter = 90.0`. El proyecto conserva ese ajuste de terreno;
no debe sustituirse por el nominal de 100 al desplegar. La exactitud debe
contrastarse con un patrón volumétrico.

## Conversación tractor ↔ validador ↔ RPi

El intercambio ocurre en la red local y no depende de Internet:

```text
Tractor ESP32       Validador          Broker MQTT/TLS              RPi
  │                     │<─ registro MIM retenido ───────────────────┤
  │                     ├─ acuse persistido ─>│─────────────────────>│
  ├─ anuncio BLE ──────>│                       │                      │
  │<─ desafío 256 bit ──┤                       │                      │
  ├─ nonce + HMAC ─────>│                       │                      │
  │                     ├─ rfid.presentation ──>│─────────────────────>│
  │                     │<─ rfid.challenge ─────│<─────────────────────┤
  │                     ├─ rfid.proof ─────────>│─────────────────────>│
  │                     │<─ rfid.decision ──────│<─────────────────────┤
  │<─ hold-awake ───────┤                       │          SQLite + R0.1
  │     llavero presentado; heartbeat RFID 1 s │                      │
  │                     ├─ credential.presence ─>│─────────────────────>│
  │     retiro confirmado 300 ms                │                      │
  │                     ├─ credential.presence ─>│─────────────────────>│ LOW
  │      pérdida BLE continua 20 s              │                      │
  │                     ├─ equipment.presence ─>│─────────────────────>│ LOW
```

La raíz de tópicos es
`fuel-edge/v1/{site_id}/{module_id}/validators/{validator_id}/`. Cada sesión
recibe un desafío aleatorio de 256 bits; una prueba capturada no sirve para una
sesión posterior. El RPi valida localmente credencial, operador, equipo y
asociación: el validador aporta una observación BLE autenticada, nunca la
decisión de asociación. La pérdida BLE se acepta sólo si coincide con la sesión
y el equipo activos y cumple el umbral configurado de 20 segundos.

La identidad `equipment_id` del tractor seleccionado viaja dentro de
`rfid.presentation` junto con `module_id`, autenticación y RSSI. La
Raspberry es el único componente que cruza ese equipo con la credencial, el
operador, el fundo, la vigencia y `managed_associations` antes de autorizar el
relé.

La detención por fin de suministro es independiente del llavero: después del
último pulso del K24, 40 segundos continuos sin flujo llevan el relé a `LOW`.
Si nunca comienza a fluir combustible, el permiso vence a los 60 segundos. El
K24 debe estar habilitado y calibrado en terreno para aplicar esa detección.

El validador selecciona por la mediana de cinco muestras RSSI, exige superar un
umbral calibrado y autentica el par `module_id + equipment_id` contra una clave
única local. El módulo del tractor duerme entre anuncios, mantiene Wi-Fi apagado
en operación normal y sólo permanece despierto mientras recibe renovaciones de
sesión.

Un administrador puede calibrar el umbral RSSI desde **Sistema → Calibración
Bluetooth** (`-100..-35 dBm`). La RPi publica cada revisión por MQTT retenido y
la interfaz sólo la muestra como aplicada después del acuse del validador. Una
lectura menos negativa exige mayor cercanía; el último RSSI observado se conserva
como referencia de terreno.

El transporte limita los mensajes operativos a 4096 bytes y la instantánea del
registro a 8192 bytes. Correlaciona por sesión, usa QoS 1 y exige CA,
certificado de cliente y clave privada. Identificadores con `/`, `+` o `#` se
rechazan antes de formar un tópico.

La Raspberry relee cada 5 s el registro protegido
`/etc/fuel-edge/equipment-registry.toml` y distribuye por MQTT retenido hasta 32
claves MIM activas. El validador verifica una huella de generación, reemplaza la
lista de forma atómica, persiste la copia y devuelve un acuse; mientras no lo
reciba, la Raspberry reintenta cada 30 s. Así, una flota de 10 o más tractores
no requiere sincronización, comandos ni reflasheos manuales en el fundo.

El validador también se actualiza desde la Raspberry por HTTPS con TLS mutuo y
una orden MQTT autorizada. Sólo actualiza estando inactivo, comprueba versión,
tamaño y SHA-256, escribe la partición alterna y exige una autoverificación de
Wi-Fi, MQTT y RC522 después del reinicio. Si la salud no queda confirmada dentro
de 90 s, el bootloader recupera el firmware anterior. El servidor escucha sólo
en la red privada `10.42.0.1:8443`; el usuario de campo no interviene.

Para activarlo se cambia `[validator] enabled = true`, se instalan los archivos
TLS y se crea `/etc/fuel-edge/validator-registry.toml` desde
`config/validator-registry.example.toml`. El registro y la clave TLS deben tener
permisos `0600`; `validate-config` lo comprueba antes de inicializar el relé.
Los ejemplos `deploy/mosquitto/mosquitto.conf.example` y `acl.example` dejan el
broker con certificados cliente obligatorios y tópicos separados para RPi y
validador.

## Driver físico seleccionado

El PLC instalado es la referencia `012002000100`, Raspberry PLC 19R V6. La
microSD incluye `librpiplc 4.1.0` y `python3-librpiplc 4.0.1`; su mapa local
confirma esta combinación:

```toml
[plc]
version = "RPIPLC_V6"
model = "RPIPLC_19R"
pump_relay = "R0.1"
```

La secuencia física del adaptador es:

```python
rpiplc.init("RPIPLC_V6", "RPIPLC_19R", restart=False)
rpiplc.pin_mode("R0.1", rpiplc.OUTPUT)
rpiplc.digital_write("R0.1", rpiplc.LOW)   # arranque seguro
rpiplc.digital_write("R0.1", rpiplc.HIGH)  # autorización aprobada
rpiplc.digital_write("R0.1", rpiplc.LOW)   # cierre/falla/parada
```

`is_energized` representa la última orden aceptada por la biblioteca; no es una
realimentación eléctrica del contacto.

## Lectura de nivel OCIO

El PIUSI OCIO mide el nivel mediante una salida 4-20 mA. Un módulo intermedio
convierte ese lazo a tensión para el Raspberry PLC 19R V6, que expone cuatro
entradas analógicas 0-10 V (`I0.2` a `I0.5`). La instalación real usa `I0.2` y
una salida del convertidor configurada en terreno: `0.00 V` representa el 0 %
de señal y `9.80 V` el 100 %. Falta confirmar el significado físico de esos
extremos en el OCIO; no se deduce del voltaje si representan altura o volumen.
El PLC no recibe el lazo de corriente directamente.

La configuración de producción usa mediana de cinco muestras y escala:

```text
porcentaje = limitar(voltios / 9.80 * 100, 0, 100)
litros = porcentaje / 100 * capacity_liters
```

La biblioteca instalada entrega la entrada del Raspberry PLC en
12 bits (`0..4095`); este fondo de escala queda explícito en la configuración
para que un cambio de hardware no altere silenciosamente el cálculo. Los valores
inferiores a `0.00 V` se limitan a 0 % y los superiores a `9.80 V`, a 100 %.
Como el mínimo válido es 0 V, la señal por sí sola no distingue un estanque vacío
de una salida desconectada; esa condición debe diagnosticarse por inspección o
supervisión adicional de la interfaz.

## Validación y despliegue

La curva de volumen elegida es la [tabla BFM02500DG del fabricante](docs/verificacion-tabla-fabricante-fm2500.md).
Está implementada como `fm2500_manufacturer`: conserva los 14 puntos,
interpola linealmente y rechaza alturas fuera de 135–1.125 mm. Requiere señal
lineal en altura y extremos eléctricos explícitos antes de su activación;
`fm2500_horizontal` fue retirado. La configuración selecciona la tabla con
escala objetivo 0–1.300 mm y `ocio_calibration_pending = true` hasta verificar
el instrumento. Se registran ADC y candidatos por tabla; el dashboard indica
«Calibración pendiente» y no se usan esos candidatos como inventario confirmado.
La curva y el escalado se identifican en cada
lectura para que su cambio no cree recepciones ni falsas diferencias de inventario.

La guía de operación del enlace Raspberry ↔ validador desde Terminal está en
[`docs/validador-mqtt-terminal.md`](docs/validador-mqtt-terminal.md).

El proyecto requiere Python 3.11 o superior.

```bash
python3 -m venv .venv
.venv/bin/pip install -e .
.venv/bin/python -m unittest discover -s tests -v
```

Compilar ambos firmware para Arduino Nano ESP32 con PlatformIO:

```bash
platformio run -d firmware/equipment_module
platformio run -d firmware/rfid_validator
```

Con Arduino CLI, agregar la biblioteca compartida del contrato:

```bash
arduino-cli compile --library firmware/common --fqbn arduino:esp32:nano_nora firmware/equipment_module
arduino-cli compile --library firmware/common --fqbn arduino:esp32:nano_nora firmware/rfid_validator
```

En banco, `VALIDATOR_SIMULATED_CARD = 1` permite iniciar una presentación
enviando `p` por el monitor serie. En el piloto físico queda en `0` y
`VALIDATOR_MIFARE_CLASSIC_CARD = 1`: el enrolamiento personaliza el sector 1
con claves derivadas por tarjeta y las presentaciones posteriores exigen
autenticación del sector. El RC522/MIFARE Classic sirve para el piloto, pero no
es el lector/credencial definitivo: para producción de seguridad se requiere
DESFire EV3 o equivalente y un lector compatible con autenticación mutua.

Validar la configuración sin actuar el relé:

```bash
fuel-edge validate-config --config config/fuel-edge.toml
```

Ejecutar todo con relé simulado:

```bash
fuel-edge run --simulate --config config/fuel-edge.toml
```

Ejecutar el aplicativo web local:

```bash
cd web
corepack pnpm install --frozen-lockfile
pnpm dev
```

La web persiste usuarios, entidades administrables, histórico y acciones sobre
alertas en su base D1/SQLite local. Las alertas resueltas pueden reabrirse como
ciclos nuevos enlazados, sin modificar el cierre ni los tiempos históricos del
ciclo anterior. No accede al GPIO: registra la solicitud de
prueba de bomba y el agente edge decide si puede ejecutarla. El agente también le
entrega por `127.0.0.1` los despachos K24 cerrados, las lecturas OCIO, las
alertas de control y un estado de salud cada 10 segundos.

Antes de validar la configuración productiva, provisionar una sola vez los
secretos compartidos. El comando solicita la contraseña sin mostrarla y crea
dos archivos `0600` con la misma clave aleatoria de ingestión:

```bash
sudo python3 tools/provision_web_auth.py \
  --email pedro.coloma@krontec.cl \
  --recovery-output /media/usb/fuel-edge-recovery.txt
```

El OCIO se adquiere directamente desde `I0.2` después de un
aislador/convertidor 4–20 mA → 2–10 V. El agente rechaza menos de 1.8 V como
lazo abierto, toma cinco muestras, publica cambios y conserva la entrega
durable. No se acepta una lectura simulada para habilitar producción.

En el PLC, `deploy/install.sh` instala los archivos y deja el servicio detenido.
Sólo después de verificar el borne R0.1 y el circuito se habilita explícitamente:

```bash
sudo ./deploy/install.sh
sudo python3 tools/provision_web_auth.py --email pedro.coloma@krontec.cl
sudo ./deploy/install-web.sh
sudo /opt/fuel-edge/venv/bin/fuel-edge validate-config --config /etc/fuel-edge/config.toml
sudo systemctl enable --now fuel-edge
```

### Nombre amigable en la red local

El PLC puede anunciar la web por mDNS, sin Internet, gateway ni servidor DNS.
Después de instalar Nginx y la web, ejecutar una vez:

```bash
sudo ./deploy/setup-local-web-name.sh
```

El acceso queda disponible en `http://fueledge.local/` y se conserva el respaldo
por `http://10.10.10.20/`. Los equipos deben estar en el mismo enlace o VLAN y
permitir mDNS (UDP 5353 multicast). macOS, iOS, Linux con Avahi y versiones
actuales de Windows resuelven normalmente los nombres `.local`.

Nginx también acepta el nombre de marca `fueledge.conchaytoro`, pero ese dominio
privado no puede descubrirse por mDNS. Para usar exactamente esa dirección en
todos los equipos, el router o DNS de la LAN debe publicar este registro y
entregar ese DNS a los clientes:

```text
fueledge.conchaytoro.  A  10.10.10.20
```

En un enlace directo sin DNS se debe usar `fueledge.local`. El configurador es
idempotente, fija el hostname `fueledge`, publica el servicio HTTP con Avahi y
no modifica la dirección IP estática.

La unidad productiva notifica disponibilidad real a systemd y mantiene un
watchdog de 20 segundos sobre el avance del bucle. Tanto `fuel-edge` como el
broker Mosquitto tienen reinicio automático sin agotar el límite de intentos;
el AP deshabilita ahorro de energía y reintenta su autoconexión indefinidamente.
Una desconexión MQTT durante la publicación del registro MIM se trata como
transitoria y se reintenta, sin terminar el controlador.

La revisión de [alarmas, cuadratura acumulada y calibración FM2500](docs/alarmas-y-calibracion.md)
documenta la detección de descenso sin flujo K24, las verificaciones al reiniciar,
el seguimiento de pérdidas pequeñas entre días y las condiciones para activar
la corrección geométrica del OCIO. Incluye límites de medición y pruebas de aceptación.

La versión 0.3.11 implementa el bucle base, relé fail-safe, K24, OCIO analógico,
persistencia, sincronización web durable, enrolamiento NFC desde la app,
tarjeta maestra única con reemplazo aprobado, registro MIM, calibración RSSI
administrable, consulta RFID de baja latencia, prueba auditada de bomba por un
tiempo acotado de 5 a 60 segundos y el contrato MQTT/TLS completo. En las ventanas web el firmware
despierta también un tag que ya quedó apoyado, evitando exigir dos o tres
presentaciones por la carrera entre la apertura MQTT y el RC522. Los rangos
del histórico respetan el día calendario de `America/Santiago`, tanto en horario
de verano como de invierno, y se actualizan automáticamente mientras están
visibles. La búsqueda manual de MIM se ejecuta sólo al solicitarla, dura diez
segundos y vuelve siempre a un estado final que permite repetirla.
El despliegue instala el broker, certificados y claves únicas; el servicio de
prueba puede quedar activo sin GPIO y el servicio productivo permanece detenido
hasta aprobar la lista física. Son bloqueos de puesta en marcha, no reemplazables
por software: comprobar RC522/credencial, observar pulsos reales y calibrar K24
con patrón volumétrico, medir 2–10 V válidos del OCIO, verificar `R0.1 = LOW` y
su circuito de potencia, y migrar RC522/MIFARE Classic a la credencial definitiva
antes de clasificar la instalación como producción segura.
