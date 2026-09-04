# Actualización MIM `equipment-module-7f296c` — 2026-08-28

- Placa: Seeed Studio XIAO ESP32-C3, flash XMC de 4 MB.
- Puerto: `/dev/cu.usbmodem3101`.
- MAC: `ac:27:6e:7f:29:6c`.
- Identidad conservada: `equipment-module-7f296c`.
- Firmware anterior confirmado mediante readback: `fuel-mim 0.6.0`.
- Firmware instalado: `fuel-mim 0.6.2`, secure version 1.
- No se ejecutó borrado masivo de la flash.

## Respaldo previo

- Imagen completa de 4 MB: `backups/mim-identities/equipment-module-7f296c/linked-readback-pre-0.6.2-20260828.bin`.
- SHA-256: `20c10121d87a85a66c7925df75a9b780641563c2e4846c193e356b751109517e`.
- Permisos: `0600`.

## Artefactos privados de esta identidad

- Aplicación `firmware-0.6.2.bin` — SHA-256 `3681bc8fcb5403ce0520e7bd08d0abc07c82ce7fe41a53eb09738c7c1b784d46`.
- Imagen de fábrica `firmware-0.6.2.factory.bin` — SHA-256 `b2078ad3203de45d7873e3382686f6a43ce20ce9cb12f3c7f2e20648bdf87d2f`.
- Ambos archivos tienen permisos `0600` y fueron compilados específicamente para `equipment-module-7f296c`.

## Verificación

- `esptool` verificó correctamente bootloader, tabla de particiones, `boot_app0` y aplicación durante la escritura.
- El readback de la aplicación es idéntico byte por byte al binario compilado.
- SHA-256 de la aplicación leída: `3681bc8fcb5403ce0520e7bd08d0abc07c82ce7fe41a53eb09738c7c1b784d46`.
- La partición NVS posterior es idéntica byte por byte a la NVS del respaldo previo.
- SHA-256 de NVS antes y después: `8c53871753ffc520ba099c6897064781da68d9804ebf44bde9a8f9983798db7d`.

Resultado: **FLASH VERIFIED / IDENTITY AND NVS PRESERVED**.
