# Plan de fortalecimiento de seguridad

**Sistema:** Monitoreo IoT de combustible  
**Inicio del plan:** 20 de agosto de 2026  
**Horizonte inicial:** 15 días, seguido de mantenimiento continuo  
**Objetivo:** aumentar la seguridad sin alterar el flujo operacional aprobado ni la política actual de exportación de datos.

## 1. Decisiones funcionales que se preservan

Los siguientes comportamientos son decisiones de producto y no se tratarán como defectos:

- Las cuentas `master`, `administrator` y `supervisor` pueden programar el modo manual dentro de las reglas actuales.
- El modo manual conserva su duración máxima actual y mantiene la autoridad local del PLC.
- La pérdida del validador durante un modo manual activo no modifica por sí sola la ventana programada.
- Todo usuario autenticado puede descargar la exportación operacional sanitizada.
- La exportación continúa excluyendo contraseñas, hashes, correos, RUT, identificadores y secretos RFID, y secretos de autenticación o recuperación.
- La tarjeta maestra, la prueba de bomba, el enrolamiento y la OTA continúan disponibles bajo sus reglas actuales.

Los parches de seguridad deben proteger estos flujos mediante transporte seguro, auditoría, alertas, aislamiento y pruebas de regresión, sin cambiar su semántica sin una decisión funcional posterior.

## 2. Principios de ejecución

1. Un riesgo por parche y una versión de parche pequeña y reversible.
2. Nunca rotar o eliminar una credencial antes de comprobar que existe una copia protegida y que el reemplazo funciona.
3. Probar primero fuera del PLC productivo; después ejecutar una ventana de mantenimiento acordada.
4. Conservar siempre un paquete, configuración y base de datos de rollback verificados.
5. No publicar artefactos que incorporen secretos del dispositivo.
6. Cada cambio de seguridad debe incluir prueba automática, evidencia de despliegue y actualización de este documento.

## 3. Cronograma inicial

### Días 1–2 — Contención y línea base

**Meta:** impedir filtraciones accidentales y conocer el estado real del PLC antes de modificarlo.

- Añadir a `.gitignore` las carpetas `.pio/`, artefactos `.bin`, `.elf`, `.map` y otros productos de compilación que incorporen credenciales.
- Añadir un control automático que rechace commits con:
  - claves privadas PEM;
  - archivos reales `*_secrets.h`;
  - credenciales hexadecimales de producción;
  - artefactos de firmware generados fuera de un directorio de entrega explícito.
- Inventariar los 23 BIN/ELF locales existentes y determinar si alguna vez salieron del equipo de desarrollo. Si fueron compartidos, planificar rotación de las credenciales afectadas.
- Crear un inventario de secretos sin registrar sus valores: propietario, ubicación, propósito, fecha de emisión, vencimiento y procedimiento de rotación.
- Conectar al PLC desde la red de administración y capturar una línea base de solo lectura:
  - servicios activos y habilitados;
  - puertos en escucha e interfaces asociadas;
  - reglas de firewall;
  - configuración efectiva de SSH y Nginx;
  - propietarios y permisos de archivos sensibles;
  - versiones instaladas del agente, web, Mosquitto, Node, Python y sistema operativo;
  - huellas de claves SSH autorizadas;
  - resultado de `systemd-analyze security` para los servicios del sistema.
- Guardar la evidencia sin secretos en `outputs/security-baseline/AAAA-MM-DD/`.

**Criterio de cierre:** ningún secreto o firmware con secreto puede entrar accidentalmente al repositorio, y existe una línea base viva del PLC.

**Versión propuesta:** `0.3.13-security-hygiene`.

### Días 2–4 — Separación de claves MQTT

**Meta:** que una vulnerabilidad del broker no permita obtener la CA ni impersonar a los clientes.

- Modificar el aprovisionamiento para que el usuario/grupo `mosquitto` sólo pueda leer:
  - `ca.crt`;
  - `broker.crt`;
  - `broker.key`.
- La clave `ca.key` debe guardarse offline o, durante una transición controlada, como `root:root 0600` fuera del directorio accesible al broker.
- Las claves `rpi.key` y `validator-01.key` deben ser `root:root 0600` y residir únicamente donde el proceso que representa esa identidad las necesite.
- Después de provisionar el validador, retirar su clave privada del directorio del broker. Conservar una copia cifrada/offline sólo si el procedimiento de recuperación la exige.
- Cambiar la prueba de salud MQTT para ejecutarla como root sin ampliar permisos del broker.
- Añadir pruebas automáticas que fallen si `ca.key`, `rpi.key` o `validator-01.key` quedan legibles por `mosquitto`.
- Aplicar primero cambios de ubicación/permisos. Rotar CA y certificados en una ventana separada, después de validar que el validador puede recibir las nuevas credenciales sin perder rollback.

**Pruebas obligatorias:**

- conexión mTLS RPi → broker;
- conexión mTLS validador → broker;
- rechazo de cliente anónimo;
- rechazo de certificado con CN no autorizado;
- ACL de lectura/escritura por cada tópico;
- recuperación tras reinicio de Mosquitto y del agente edge.

**Criterio de cierre:** Mosquitto no puede leer ninguna clave privada salvo `broker.key`, y la operación MQTT continúa normal.

**Versión propuesta:** `0.3.14-mqtt-key-isolation`.

### Días 4–6 — Ciclo de vida de sesiones web

**Meta:** limitar el daño de una cookie o contraseña temporal comprometida sin alterar permisos operacionales.

- Añadir una versión de sesión por usuario o una marca `credentials_changed_at` incluida y validada en el token.
- Invalidar sesiones previas al:
  - cambiar contraseña;
  - restablecer contraseña;
  - recuperar la cuenta maestra;
  - desactivar un usuario;
  - cambiar rol o permisos.
- Exigir la contraseña actual para el cambio voluntario de contraseña.
- Mientras `must_change_password` esté activo, permitir solamente consultar la sesión, cambiar la contraseña y cerrar sesión.
- Dar caducidad a contraseñas temporales y auditar su emisión, primer uso y vencimiento sin registrar su valor.
- Mantener `HttpOnly`, `SameSite=Strict` y el TTL actual; revisar el TTL sólo con una decisión funcional separada.
- Persistir el control de intentos fallidos para que un reinicio de la web no borre inmediatamente el bloqueo.

**Pruebas obligatorias:** robo simulado de cookie, cambio y reset de contraseña, recuperación maestra, desactivación, cambio de permisos y expiración de contraseña temporal.

**Criterio de cierre:** una sesión anterior deja de ser válida inmediatamente después de cualquier cambio de credenciales o privilegios.

**Versión propuesta:** `0.3.15-session-lifecycle`.

### Días 6–8 — HTTPS, SSH y firewall

**Meta:** eliminar exposición innecesaria en la red local.

- Confirmar cuál configuración Nginx está desplegada.
- Usar HTTPS como entrada normal. Mantener HTTP sólo como redirección o para una puesta en marcha explícita, temporal y documentada.
- Instalar la CA interna en los equipos autorizados para evitar que los usuarios ignoren alertas de certificado.
- Verificar que la cookie se emita siempre con `Secure` en el acceso normal.
- Endurecer SSH:
  - `PasswordAuthentication no`;
  - `PermitRootLogin no`;
  - autenticación exclusiva por Ed25519;
  - `AllowUsers pi` o cuenta administrativa dedicada;
  - límite de intentos y tiempo de login;
  - acceso sólo desde la red/VPN de administración.
- Antes de deshabilitar contraseña SSH, comprobar acceso por clave y acceso de recuperación por consola física.
- Definir firewall por lista permitida:
  - web HTTPS sólo desde redes operacionales autorizadas;
  - SSH sólo desde administración;
  - MQTT, enrolamiento y OTA sólo en loopback o la red privada del validador;
  - denegar el resto por defecto.

**Criterio de cierre:** no hay credenciales ni cookies en HTTP durante la operación normal y ningún servicio escucha en una interfaz no prevista.

**Versión propuesta:** `0.3.16-network-hardening`.

### Días 8–10 — Controles compensatorios para funciones aceptadas

**Meta:** conservar modo manual y exportación tal como fueron diseñados, aumentando detección y trazabilidad.

- Modo manual:
  - generar alerta visible al programar, iniciar, reemplazar, cancelar y finalizar;
  - incluir actor, horario, duración, estado del K24 y resultado;
  - alertar si sigue activo al cambiar de turno o si la web deja de reportar salud;
  - comprobar diariamente que el cierre por fecha límite local funciona sin web ni validador;
  - mantener pruebas que aseguren que el relé vuelve a `LOW` al finalizar, cancelar o entrar en falla.
- Exportación:
  - conservar acceso para todo usuario autenticado;
  - mantener la lista explícita de campos excluidos;
  - registrar usuario, fecha, conjunto exportado, cantidad de registros y hash del archivo, nunca el contenido completo;
  - aplicar límite razonable de frecuencia y tamaño para evitar agotamiento de recursos, sin cambiar quién puede exportar;
  - añadir encabezado o metadato que identifique el archivo como información operacional sensible;
  - incorporar pruebas que detecten la aparición accidental de secretos, RUT, correos o identificadores RFID.

**Criterio de cierre:** los comportamientos funcionales permanecen iguales y cada uso queda detectable y atribuible.

**Versión propuesta:** `0.3.17-operational-audit`.

### Días 10–15 — Integridad de entregas y recuperación

**Meta:** poder demostrar qué software se instaló y volver atrás con seguridad.

- Firmar criptográficamente manifiestos de release; un SHA-256 guardado junto al archivo no basta si ambos pueden reemplazarse.
- Verificar la firma antes de instalar en la microSD o en el PLC.
- Generar SBOM para Python, Node y firmware en cada release.
- Ejecutar en cada entrega:
  - 251+ pruebas Python o su total vigente;
  - pruebas web completas;
  - TypeScript;
  - auditoría de dependencias Python y npm;
  - escaneo de secretos;
  - compilación de firmware y comprobaciones de Secure Boot/rollback.
- Crear un paquete de rollback con firma, versión, hashes, migraciones compatibles y procedimiento probado.
- Probar restauración de configuración y bases SQLite en un entorno de ensayo.
- Documentar compatibilidad entre versión edge, web, firmware MIM y firmware validador.

**Criterio de cierre:** cada componente instalado puede trazarse a una entrega firmada y el rollback se ha ensayado.

**Versión propuesta:** `0.3.18-signed-releases`.

## 4. Rutina de actualización continua

### Cada día durante el período de cambios

- Revisar logs y alertas después de cada parche.
- Confirmar estado `LOCKED`, relé `LOW`, K24 saludable y sincronización web.
- Comprobar expiración de certificados y espacio en disco.
- Registrar cambios, pruebas, responsable y resultado.

### Cada semana

- Ejecutar auditoría de dependencias y escaneo de secretos.
- Revisar cuentas activas, roles, huellas SSH y exportaciones.
- Revisar activaciones de tarjeta maestra, modo manual, pruebas de bomba y OTA.
- Aplicar parches de seguridad de severidad alta/crítica en una ventana prioritaria.

### Cada mes

- Actualizar el sistema operativo y reiniciar de forma controlada.
- Probar recuperación de backup y rollback.
- Revisar reglas de firewall, listeners y permisos de archivos.
- Revisar certificados con menos de 90 días de vigencia.
- Comparar hashes/versiones instaladas con el manifiesto firmado.

### Cada trimestre

- Rotar claves operacionales según inventario y riesgo.
- Ejecutar una revisión de amenazas y una prueba de intrusión autorizada desde las redes operacionales.
- Revisar decisiones funcionales aceptadas y confirmar que los controles compensatorios siguen siendo suficientes.
- Ensayar pérdida de web, broker, validador, energía y conectividad, verificando el estado físico seguro.

## 5. Flujo obligatorio por parche

1. Abrir ticket con riesgo, alcance, comportamiento que debe preservarse y plan de rollback.
2. Crear rama `codex/security-<tema>` o la convención acordada.
3. Implementar el cambio y sus pruebas de regresión.
4. Revisar el diff buscando secretos, ampliación de permisos y nuevos puertos.
5. Ejecutar toda la batería automática.
6. Probar en banco con relé desacoplado o carga segura.
7. Generar release firmado, SBOM y respaldo de rollback.
8. Desplegar durante ventana controlada.
9. Ejecutar pruebas de humo y verificación física.
10. Observar al menos un ciclo operacional y cerrar el ticket con evidencia.

## 6. Criterios de suspensión y rollback

Se revierte inmediatamente el parche si ocurre cualquiera de estos eventos:

- el relé no queda en `LOW` durante arranque, parada, falla o fin de ventana;
- falla la persistencia de auditoría o aparecen movimientos duplicados;
- el validador no puede autenticarse por mTLS;
- la web queda expuesta en una interfaz o puerto no autorizado;
- una sesión revocada continúa accediendo;
- el firmware no confirma salud dentro de su ventana de validación;
- se detecta un secreto dentro del paquete o repositorio;
- no existe una ruta de recuperación comprobada.

## 7. Backlog posterior

- Realimentación eléctrica independiente del contacto del relé; actualmente el software conoce la última orden aceptada, no la posición física real.
- Registro de auditoría encadenado por hashes o réplica append-only fuera del PLC.
- Segundo factor para cuentas administrativas, sin bloquear operación local de emergencia.
- CA offline con procedimiento formal de emisión y revocación.
- Medición de integridad del arranque y evaluación de Secure Boot del Raspberry PLC.
- Segmentación mediante VLAN/VPN para separar administración, web operacional y red del validador.

## 8. Indicadores de avance

- Cero claves privadas accesibles por procesos que no las usan.
- Cero secretos o artefactos con secretos admitidos por Git.
- 100 % de accesos web operacionales mediante HTTPS.
- 100 % de sesiones invalidadas después de cambio de credenciales o privilegios.
- 100 % de releases con firma, SBOM y rollback probado.
- Cero servicios escuchando fuera de las interfaces autorizadas.
- 100 % de usos de modo manual y exportación registrados y atribuibles.
- Cero regresiones en las pruebas funcionales y de falla segura.
