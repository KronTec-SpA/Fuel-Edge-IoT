# Actualización MIM — 2026-08-28

- Placa: Seeed Studio XIAO ESP32-C3, flash XMC de 4 MB.
- Puerto: `/dev/cu.usbmodem3101`.
- MAC: `ac:27:6e:7d:b0:48`.
- Identidad conservada: `equipment-module-7db048`.
- Firmware anterior confirmado por readback: `fuel-mim 0.6.0`.
- Firmware instalado: `fuel-mim 0.6.2`, secure version 1.
- No se ejecutó borrado masivo.

## Respaldo previo

- Archivo privado: `backups/mim-identities/equipment-module-7db048/linked-readback-pre-0.6.2-20260828.bin`.
- Tamaño: 4 MB.
- SHA-256: `fc57b9c41bb9f3d777d7b9a5424e43ad55a1e0adbeac5476c34968a511070f61`.

## Artefactos privados

- Aplicación `firmware-0.6.2.bin`: `a404ee9162e2e0b02b772813fcbec2ce23ccc0bb15579bce9f2f91f77e62799e`.
- Recuperación `firmware-0.6.2.factory.bin`: `d941b8a6bcd31ec63c88bc1dcd9f8c4aabeba182376721b310f06944b29accfa`.
- Ambos archivos están almacenados con permisos `0600` en el respaldo privado de la identidad.

## Verificación

- La escritura de bootloader, tabla de particiones, selección OTA y aplicación fue verificada por `esptool`.
- El readback posterior de la aplicación coincide byte a byte con `firmware-0.6.2.bin`.
- SHA-256 de aplicación leída: `a404ee9162e2e0b02b772813fcbec2ce23ccc0bb15579bce9f2f91f77e62799e`.
- El NVS posterior coincide byte a byte con el respaldo previo.
- SHA-256 de NVS antes y después: `ab9e7fcc686771fe264cd2f40dadc0051aaeaa3437c83903034dfd7935649415`.

Resultado: **FLASH VERIFIED / IDENTITY AND NVS PRESERVED**.
