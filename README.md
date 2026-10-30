# RemBot-MD

Bot mínimo de WhatsApp basado en Baileys. Conserva el arranque y la vinculación a WhatsApp y tiene **un solo comando**: `/dw4`, que comprime un video a 360p.

## Requisitos

- Node.js `>=25`.
- `npm install` incluye FFmpeg mediante `ffmpeg-static` en plataformas compatibles.
- Si no hay binario precompilado para el sistema/arquitectura, instala FFmpeg con H.264 (`libx264`) y AAC en el `PATH`.

## Instalar y enlazar WhatsApp

```bash
npm install
npm run start:qr
```

Escanea el QR desde WhatsApp → **Dispositivos vinculados** → **Vincular un dispositivo**. La sesión local se guarda en `Sessions/Owner/`; no compartas ni publiques esa carpeta.

## Usar `/dw4`

Responde al mensaje que contiene el video con:

```text
/dw4
```

El resultado se envía como video MP4 a 360p. Para recibirlo como documento, usa `/dw4 doc`.

El prefijo predeterminado es `/`. Se puede cambiar con `BOT_PREFIX` en `.env`, si se desea.

## Progreso en terminal

Durante cada compresión, la terminal muestra aproximadamente una actualización por segundo: porcentaje, tiempo procesado y duración, frame, FPS y velocidad de FFmpeg. Cada trabajo usa un identificador corto y no imprime el JID del chat.

## Owners

Los owners se leen desde `BOT_OWNER_NUMBER` en `.env` local; admite varios números separados por comas. `.env` está excluido por `.gitignore` y no debe publicarse.

## Alcance y seguridad

Se conservó únicamente el comando `/dw4`; no se importaron las demás ramas del plugin adjunto. Los videos temporales se eliminan al terminar el procesamiento. Se mantienen la licencia MIT y los avisos de copyright originales en `LICENSE`.
