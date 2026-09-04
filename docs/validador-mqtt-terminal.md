# Validador MQTT productivo desde Terminal

La Raspberry crea la red privada `FuelEdge-RPi` en `10.42.0.1`. El Nano ESP32
se conecta a esa red y abre MQTT/TLS en el puerto `8883`. El servicio operativo
es exclusivamente `fuel-edge`; no existe una unidad paralela con relé simulado.

Durante el FAT, K24 y nivel pueden permanecer deshabilitados en
`/etc/fuel-edge/config.toml` hasta conectar sus señales. Esto no impide el
enrolamiento NFC ni la validación del enlace Raspberry ↔ validador. El relé
`R0.1` parte siempre en `LOW` y sólo se energiza después de una autorización
válida o durante la prueba de bomba protegida descrita más abajo.

## Prueba controlada de la bomba

Una cuenta maestra o administradora con permiso para gestionar el sistema puede
abrir **Sistema → Prueba de bomba** y elegir **Probar bomba**. El formulario
solicita la clave del administrador y el tiempo de habilitación, entre 5 y 60
segundos. El botón está disponible únicamente en esa pestaña y para esos roles.

La Raspberry sólo ejecuta la solicitud si reporta `LOCKED`, R0.1 está en `LOW`
y K24 está habilitado y saludable. Actúa el relé localmente sin solicitar NFC,
BLE ni conexión al validador. Al cumplirse el tiempo vuelve a `LOW`; si K24
detecta un pulso, aparece una falla o llega otro evento de control, se abre de
inmediato. Administrador, duración, inicio y resultado quedan registrados como
una transacción de prueba. Este comando no debe usarse con una carga en curso y
no reemplaza la comprobación eléctrica del circuito de potencia.

## 1. Entrar a la Raspberry

Desde el Mac, con el Ethernet conectado:

```bash
cd "/Users/ppcoloma/Documents/ChatGPT/Monitoreo IoT Petróleo"
ssh -F deploy/ssh-config-rpiplc rpiplc
```

El prompt cambiará a la Raspberry.

Los puertos Ethernet tienen funciones separadas:

- `eth0`, el puerto Gigabit clásico, se conecta al MikroTik y solicita por DHCP
  una dirección `192.168.88.x`; es la salida predeterminada a Internet.
- `eth1`, el puerto industrial W5100, se conecta al Dell Dock/Mac y conserva
  `10.10.10.20/24` para administración directa. El Mac usa
  `10.10.10.10/24`, sin gateway ni DNS, en ese enlace.

No unir `eth0` y `eth1` mediante `br0`. El W5100 refleja tramas reenviadas y
provoca aprendizaje MAC incorrecto y pérdida intermitente de paquetes. Por esta
limitación de hardware los cables no son intercambiables sin cambiar los
perfiles de red.

## 2. Levantar los servicios productivos

```bash
sudo systemctl start chrony mosquitto fuel-edge-web fuel-edge
sudo systemctl status chrony mosquitto fuel-edge-web fuel-edge --no-pager
```

Los tres servicios ya están habilitados para arrancar automáticamente:

```bash
sudo systemctl enable chrony mosquitto fuel-edge-web fuel-edge
```

`fuel-edge` queda bajo `Type=notify`: sólo pasa a `active` cuando terminó de
abrir hardware, SQLite y workers. Después envía un latido cada vuelta del bucle;
si el proceso termina o deja de avanzar durante 20 s, systemd abre el relé con
`ExecStop` y lo vuelve a iniciar tras 3 s. La política no agota reintentos.
Mosquitto tiene la misma recuperación de caídas, independiente del agente.

Los instaladores aplican estas políticas automáticamente. En una Raspberry ya
provisionada, se actualizan al volver a ejecutar el despliegue y MQTT:

```bash
sudo ./deploy/install.sh
sudo ./deploy/setup-validator-mqtt.sh
sudo systemctl enable --now mosquitto fuel-edge
```

## 3. Confirmar la red privada

```bash
nmcli -t -f NAME,TYPE,DEVICE connection show --active
ip -brief address show wlan0
ip neigh show dev wlan0
```

Debe aparecer `fuel-edge-ap`, `10.42.0.1/24` y, cuando el Nano esté encendido,
una dirección cliente `10.42.0.x`.

## 4. Ver MQTT y el agente en vivo

En una ventana:

```bash
sudo tail -f /var/log/mosquitto/mosquitto.log
```

En otra conexión SSH:

```bash
sudo journalctl -fu fuel-edge
```

Mosquitto debe identificar a los clientes como `rpi-rpiplc-19r-01` y
`validator-01`.

## 5. Probar el Nano por USB

Sal de SSH con `exit` y abre el monitor serie del Mac:

```bash
screen /dev/cu.usbmodem206EF130C5302 115200
```

Comandos disponibles:

- `s`: muestra Wi-Fi, IP, MQTT, sesión, hora, RC522, cantidad de MIM y la
  generación del registro aplicada.
- `p`: ejecuta una presentación de credencial de banco.
- `b`: repite la melodía ascendente.

Una prueba correcta muestra:

```text
status wifi=connected ... mqtt=connected ... rfid=0x92 mims=12 registry=mqtt generation=...
decision=allowed ... state=authorized
rfid=removed confirmed_milliseconds=300
```

Al conectar MQTT también debe aparecer un acuse similar a:

```text
registry=updated modules=12 generation=0123456789ab
registry=ack modules=12 persisted=true generation=0123456789ab
```

No hay que copiar claves al Nano ni reflashearlo por cada tractor. La Raspberry
publica el registro automáticamente, el Nano lo guarda y ambos continúan
reintentando después de una desconexión o reinicio. Si el registro supera la
capacidad de 32 MIM activos, `fuel-edge validate-config` bloquea el arranque con
un error explícito en vez de operar con una lista incompleta.

## Actualizar el Nano sin volver a conectarlo por USB

Esta operación es para soporte técnico remoto, no para el usuario de campo. Con
el punto sin una carga activa:

```bash
sudo /opt/fuel-edge/venv/bin/fuel-validator-ota stage \
  /ruta/validator-firmware.bin --version 0.3.8 \
  --config /etc/fuel-edge/config.toml
```

Un resultado correcto termina en `success: true` y estado `healthy` o
`current`. `failed` conserva el firmware vigente; si la imagen nueva arranca
pero no confirma Wi-Fi, MQTT y RC522 en 90 s, aparecerá `rolled_back` y el Nano
volverá solo a la partición anterior. Comprobar la infraestructura con:

```bash
systemctl is-active fuel-validator-ota mosquitto fuel-edge
sudo journalctl -u fuel-validator-ota -u fuel-edge -n 50 --no-pager
```

Durante la prueba, deja el llavero acoplado al lector. El LED permanece
encendido mientras la autorización está activa. Al retirarlo, dos bips cortos
confirman la detección y la Raspberry ordena `R0.1 = LOW`; si se corta MQTT, la
orden es inmediata al detectar la desconexión y el watchdog de presencia de
2,5 s queda como respaldo.

Para salir de `screen`, presiona `Control-A`, después `\` y confirma con `y`.

## 6. Reiniciar o detener el controlador

```bash
sudo systemctl restart fuel-edge
sudo systemctl stop fuel-edge
```

Para comprobar el estado del controlador físico:

```bash
systemctl is-active fuel-edge
```

En operación productiva debe responder `active`. Al detenerlo, `ExecStop`
ordena explícitamente `R0.1 = LOW`.

## 7. Recuperar una falla

La recuperación de proceso, bloqueo del bucle, broker caído y reconexión del AP
Wi-Fi es automática. Estos comandos son para diagnosticar la causa, no para
mantener el punto operando a mano:

```bash
systemctl is-enabled mosquitto fuel-edge
systemctl is-active NetworkManager mosquitto fuel-edge
systemctl show mosquitto fuel-edge -p NRestarts -p Result -p WatchdogUSec
nmcli -t -f NAME,TYPE,DEVICE connection show --active
sudo journalctl -b -u NetworkManager -u mosquitto -u fuel-edge -n 150 --no-pager
```

Un estado `activating (auto-restart)` durante unos segundos es recuperación en
curso. Una configuración, certificado o registro inválido se ve en el journal y
debe corregirse; el proceso no puede convertir credenciales inválidas en una
condición segura por sí solo. Después de corregir el archivo, no hace falta
`reset-failed`: el siguiente intento automático lo toma.

Comprobaciones esperadas:

```text
wlan0  UP  10.42.0.1/24
chrony: active
mosquitto: active
fuel-edge-web: active
fuel-edge: active
```
