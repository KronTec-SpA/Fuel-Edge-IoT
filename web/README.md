# Concha y Toro - Monitoreo Combustible

Aplicación web local para la operación diaria del sistema IoT de trazabilidad de
combustible. Está diseñada para ejecutarse en el mismo PLC y seguir
disponible sin Internet.

## Alcance de esta entrega

- Resumen operacional del punto, nivel del estanque y salud de dispositivos.
- Mapa operacional de MIMs enlazados al validador, con radar por RSSI Bluetooth.
- Historial de cargas y combustible con recepciones, despachos, nivel del estanque,
  filtros temporales, agregación por día/semana/mes/año y exportación CSV.
- Gestión local de operadores y estados de credenciales RFID.
- Inventario de equipos permanentes, temporales y externos.
- Asociaciones operador–equipo y vigencias.
- Flujo guiado de enrolamiento RFID normal o como tarjeta maestra de emergencia.
  El sistema mantiene una sola maestra activa y exige aprobación explícita para
  desactivar la anterior antes de abrir el enrolamiento de reemplazo.
- Detección y enrolamiento cero-touch de módulos XIAO por BLE: se asignan nombre,
  tipo (Tractor, Trilladora, Camión, Camioneta u Otro) y vencimiento; el fundo proviene de la
  PLC que lo detecta.
- Reasignación entre fundos sin reflashear: al vencer se bloquea una carga normal
  y el módulo se renueva físicamente por BLE con una nueva vigencia auditable.
- Alertas con log de acciones, criticidad operacional y reaperturas auditables.
  Cada reapertura crea un ciclo nuevo, conserva el cierre anterior para SLA y
  mantiene un tag visible durante toda su atención.
- Inicio y cierre de sesión con cuenta maestra, cookie privada y bloqueo de intentos.
- Enrolamiento de usuarios con roles, permisos efectivos y claves temporales.
- Recuperación maestra con código offline y reprovisión física de emergencia.
- Persistencia local en D1/SQLite de usuarios, activos administrables y movimientos
históricos del combustible.

La aplicación identifica su autoría como `© 2026 by KronTec`.

La interfaz no incluye inicio, detención ni modificación remota de la bomba.
`fuel-edge-control` continúa siendo el único dueño del relé y de la máquina de
estados.

## Desarrollo

Requiere Node.js 22.13 o superior y pnpm mediante Corepack.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

La aplicación queda disponible en `http://localhost:3000`.

## Configuración del acceso maestro

La clave nunca se incorpora al código ni se conserva en texto legible. Antes de
iniciar el servicio, genera el archivo protegido de hashes y secretos:

```bash
sudo python3 tools/provision_web_auth.py \
  --email pedro.coloma@krontec.cl \
  --output /etc/fuel-edge/web-auth.env
```

El instalador solicita la contraseña dos veces sin mostrarla y crea el archivo
con permisos `0600`. Para desarrollo local se puede usar como salida
`web/.dev.vars`, que está excluido del repositorio.

El mismo proceso entrega un código de recuperación que debe guardarse fuera de
el PLC. Los usuarios normales reciben una clave temporal de un solo uso y
deben reemplazarla en su primer ingreso. Si se pierde también el código maestro,
se reprovisiona físicamente la cuenta y se reinicia el servicio; la versión de
bootstrap invalida la clave anterior sin borrar la auditoría ni las demás cuentas.

## Validación

```bash
pnpm build
pnpm lint
pnpm test
```

## Ejecución en el PLC

Después de instalar dependencias y ejecutar `pnpm build`, el servidor de
producción se inicia con:

```bash
pnpm start -- -p 8080
```

El servicio de referencia está en
`deploy/systemd/fuel-edge-web.service`. En producción debe publicarse mediante
HTTPS en la red local o VPN y no directamente hacia Internet.

## Lecturas del sensor de nivel

El adaptador local del sensor OCIO registra lecturas mediante
`POST /api/fuel-history/readings`, autenticado con `FUEL_SENSOR_INGEST_KEY` en
la cabecera `x-edge-sensor-key`. El detector ignora oscilaciones pequeñas y sólo
registra una recepción automática cuando el aumento sostenido alcanza 100 L.
La confianza puede redondear a 99 % únicamente desde 120 L.
Mientras el nivel continúa subiendo, consolida el mismo evento y conserva el
nivel inicial, el nivel final y la confianza de la detección.

El frontend y esta API sólo observan y registran información. No acceden al
GPIO ni al driver del relé.
