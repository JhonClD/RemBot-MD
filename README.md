# RemBot-MD

Bot mínimo de WhatsApp basado en Baileys. Conserva el arranque y la vinculación a WhatsApp y tiene **un solo comando**: `/dw4`, que comprime un video a 360p.

## Requisitos

- Node.js `>=25`.
- FFmpeg instalado en Termux y accesible como `ffmpeg` en `PATH`.

El proyecto fuerza la versión publicada de `libsignal` mediante `overrides` porque el fork de Baileys intenta cargar un binding nativo Android ARM64 que no está publicado en npm. Esto evita el error `Cannot find native binding` al instalar y ejecutar el bot en Termux.

## Dependencias de Termux

Actualiza los repositorios e instala Node.js, Git y FFmpeg:

```bash
pkg update && pkg upgrade
pkg install nodejs git ffmpeg
```

Comprueba que las versiones cumplen los requisitos del proyecto:

```bash
node --version
npm --version
ffmpeg -version
git --version
```

La versión de Node.js debe ser `25` o superior. Si `node --version` muestra una versión anterior, actualiza los paquetes de Termux antes de continuar. Si Termux no encuentra `ffmpeg`, comprueba su ruta con `command -v ffmpeg` y configura `FFMPEG_PATH` en el archivo `.env`.

## Instalar y enlazar WhatsApp en Termux

```bash
git clone https://github.com/JhonClD/RemBot-MD.git
cd RemBot-MD
npm install
npm start
```

`/dw4` ejecuta el FFmpeg del sistema; no se descarga ni se incluye un binario FFmpeg en `package.json`. Si el ejecutable no se llama `ffmpeg` o no está en `PATH`, configura `FFMPEG_PATH` con la ruta al binario.

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
