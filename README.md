# RemBot-MD

Núcleo mínimo de un bot de WhatsApp basado en Baileys. Se conserva el arranque, la reconexión y el emparejamiento de la cuenta; se retiraron los comandos y funciones anteriores. **Por ahora no hay comandos instalados.** El plugin único de compresión a 360p se añadirá cuando lo proporciones.

## Requisitos

- Node.js `>=25` (según el `package.json` recibido).
- FFmpeg disponible en el sistema para el futuro comando de compresión.

## Instalar y enlazar WhatsApp

```bash
npm install
npm start -- --qr
```

Escanea el QR desde WhatsApp → **Dispositivos vinculados** → **Vincular un dispositivo**. El bot volverá a conectar con la sesión local guardada en `Sessions/Owner/`. No compartas ni publiques esa carpeta.

También se conserva el modo de código de vinculación del proyecto original: `npm start -- code`; este modo solicita el número en la terminal.

## Configuración del propietario

Los owners se cargan desde `BOT_OWNER_NUMBER` en `.env` local (se admiten varios números separados por comas). Ese archivo está excluido por `.gitignore`; no publiques esos números. Si no se configura, no habrá un propietario reconocido para permisos de comandos.

## Plugins

La carpeta `cmds/` está lista para el plugin que enviarás. El cargador importa los archivos JavaScript que se coloquen allí. Mantendremos el bot con un solo comando cuando recibamos el plugin de compresión a 360p.

## Seguridad y atribución

Las sesiones de WhatsApp, archivos `.env`, dependencias, bases locales y registros están excluidos por `.gitignore`. Se conservan la licencia MIT y los avisos de copyright originales incluidos en `LICENSE`.
