# Aceptación de alimentación y autonomía del MIM

El MIM usa una celda protegida 1S, 3,7 V nominal, 3000 mAh. No mide ni reporta
su estado de carga: esta prueba valida alimentación, consumo y autonomía por
medición externa.

## Ensamble

- Positivo a `BAT+` y negativo a `BAT-`/GND; 4,2 V es el máximo de una celda
  cargada.
- Conector polarizado y polaridad verificada con multímetro.
- Sin divisor resistivo hacia A0 y sin cable de lectura de batería.
- Pulsador normalmente abierto entre D1/GPIO3 y GND.
- Antena U.FL de 2,4 GHz conectada antes de cualquier prueba de radio.

## 1. Inspección sin energía

1. Verificar que no haya puentes entre BAT+, BAT-, D1, GND ni pads vecinos.
2. Confirmar continuidad de cada conductor hasta su pad.
3. Confirmar ausencia de cortocircuito permanente entre BAT+ y GND.
4. Medir el pulsador: abierto al soltar, continuidad sólo al presionar.

**Aprobado:** polaridad trazada, conexiones firmes y ningún corto.

## 2. Alta fresca por USB

1. Confirmar que el header secreto del MIM coincide con la entrada respaldada
   del registro privado.
2. Para un alta realmente fresca, borrar flash/NVS y cargar la imagen 0.6.2.
   El borrado conserva la identidad porque ésta está compilada en el binario,
   pero elimina la asignación anterior.
3. Abrir consola a 115200. Deben aparecer `boot=started firmware=0.6.2`,
   `watchdog=ready` y `lifecycle=wifi_enrollment power=awake`.
4. Con la Raspberry disponible, completar Wi‑Fi 2 y verificar el acuse. Tras el
   reinicio debe aparecer `lifecycle=unified power=deep_sleep`.

**Aprobado:** identidad esperada, enrolamiento autenticado y sueño inmediato.

## 3. Prueba de alimentación

1. Medir la celda desconectada; como criterio de banco, aceptar 3,4–4,2 V.
2. Conectar respetando polaridad y vigilar calentamiento anormal.
3. Ejecutar tres ciclos de energía y comprobar que conserva identidad y
   asignación.

**Aprobado:** sin calentamiento, reinicios espurios ni pérdida de NVS.

## 4. Botón, ventana y enlace

1. Con USB desconectado, verificar que el MIM enrolado no anuncie por sí solo.
2. Hacer un click e iniciar:

   ```bash
   sh tools/scan_mim_ble.sh --seconds 60 --inspect \
     --expect-module equipment-module-7dd8d4 --expect-firmware 0.6.2
   ```

3. Sin validador, comprobar que anuncia durante 60 s y luego duerme.
4. Con validador, comprobar `equipment=session_protocol mode=signed_v4`,
   mantener la sesión con `HOLD` y dormir inmediatamente tras `CLOSE`.
5. Repetir la autenticación completa a 5 m y 10 m con línea de vista. Registrar
   RSSI, orientación, gabinete y antena.

**Aprobado:** ventana fija, protocolo seguro, sesión sostenible y alcance real.

## 5. Consumo

Medir con un instrumento capaz de soportar los picos de radio sin provocar caída
de tensión.

- Deep sleep objetivo de diseño: ≤44 µA en el ensamble terminado.
- BLE se configura a +20 dBm; registrar corriente promedio real durante los
  60 segundos, no sólo un valor instantáneo.
- No debe existir wake periódico.

Con 80 % de 3000 mAh como presupuesto útil, 44 µA en sueño y 45 mA activos, el
límite de diseño es siete ventanas completas por día para superar 12 meses. Si
el uso esperado es mayor, se debe medir el cierre real de las sesiones, aumentar
capacidad o revisar el presupuesto antes de liberar.

**Aprobado:** sueño ≤44 µA y proyección documentada ≥12 meses para la frecuencia
real de cargas.

## Evidencia

Registrar `module_id`, versión, fecha, tensión inicial, corriente de sueño,
corriente BLE promedio, operaciones diarias asumidas, RSSI a 5/10 m y resultados
de rechazo con secreto incorrecto, replay, contador fuera de orden y timeout.
