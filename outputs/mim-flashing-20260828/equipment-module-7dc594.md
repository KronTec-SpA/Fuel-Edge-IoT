# Actualización MIM `equipment-module-7dc594` — 2026-08-28

- Placa: Seeed Studio XIAO ESP32-C3, flash XMC de 4 MB.
- Puerto: `/dev/cu.usbmodem3101`.
- MAC: `ac:27:6e:7d:c5:94`.
- Identidad conservada: `equipment-module-7dc594`.
- Firmware anterior confirmado por readback: `fuel-mim 0.6.0`.
- Firmware instalado: `fuel-mim 0.6.2`, secure version 1.
- No se ejecutó borrado masivo.

## Respaldo previo

- Archivo privado: `backups/mim-identities/equipment-module-7dc594/linked-readback-pre-0.6.2-20260828.bin`.
- Tamaño: 4 MB.
- SHA-256: `aae874742e25f4c627d19762a3b50e6fac2af13191a31c327442d8d31c86d847`.

## Artefactos privados

- Aplicación `firmware-0.6.2.bin`: `6039efd796cf4003bc83a29baa60d46173f8f4c532379776f6cff31bdcff05b8`.
- Recuperación `firmware-0.6.2.factory.bin`: `b532a8bfba0b1b2464f99c5b1da8427d3e5747a7bbc8a0bfbc5e150074b466b9`.
- Ambos archivos están almacenados con permisos `0600` en el respaldo privado de la identidad.

## Verificación

- La escritura de bootloader, tabla de particiones, selección OTA y aplicación fue verificada por `esptool`.
- El readback posterior de la aplicación coincide byte a byte con `firmware-0.6.2.bin`.
- SHA-256 de aplicación leída: `6039efd796cf4003bc83a29baa60d46173f8f4c532379776f6cff31bdcff05b8`.
- El NVS posterior coincide byte a byte con el respaldo previo.
- SHA-256 de NVS antes y después: `165b770c25ce1c3cecd51e66aa26bd8cc084ede1c2b0291be195d99db6be9308`.

Resultado: **FLASH VERIFIED / IDENTITY AND NVS PRESERVED**.
