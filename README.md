<p align="center">
  <img src="assets/rem-host.png" alt="Rem — RemBot-MD" width="100%">
</p>

<h1 align="center">RemBot-MD 💙</h1>

<p align="center">
  <b>Bot de WhatsApp con la esencia de Rem</b> — descargas, grupos, menú personalizable, stickers HD y más, sobre Baileys.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D25-339933?logo=node.js&logoColor=white" alt="Node.js >=25">
  <img src="https://img.shields.io/badge/Baileys-7.0.0--rc14-25D366?logo=whatsapp&logoColor=white" alt="Baileys 7.0.0-rc14">
  <img src="https://img.shields.io/badge/License-MIT-blue" alt="License MIT">
  <img src="https://img.shields.io/badge/Autor-Jhon%20CID-ff69b4" alt="Autor Jhon CID">
</p>

<p align="center">
  <img src="https://images5.alphacoders.com/729/thumb-1920-729952.png" alt="Rem" width="32%">
  <img src="https://images.alphacoders.com/106/thumb-1920-1067640.jpg" alt="Rem" width="32%">
  <img src="https://images-cdn.9gag.com/photo/aZ0m9L9_700b.jpg" alt="Rem sonriendo" width="32%">
</p>

<p align="center"><i>Rem — Re:Zero. Imágenes: <a href="https://wall.alphacoders.com/big.php?i=729952">Wallpaper Abyss</a> · <a href="https://wall.alphacoders.com/big.php?i=1067640">Wallpaper Abyss</a></i></p>

---

## ✨ Características

| Categoría | Qué incluye |
|---|---|
| 📥 **Descargas** | MediaFire, Google Drive, Facebook, Pinterest, TikTok, Instagram, Twitter/X e imágenes |
| 👥 **Grupos** | Kick, warn, tagall, hidetag, promote/demote, abrir/cerrar, link, contadores y bienvenidas |
| 💙 **Menú y ajustes** | Menú dinámico con `` `menu `` y personalización con `` `setbanner ``, `` `setname ``, `` `seticon ``, `` `setpfp ``, `` `setstatus `` y más |
| 🎨 **Stickers HD** | Hasta 60 s, 512×512 VP8L, 12–24 fps, con audio nativo y recorte/círculo |
| 🎬 **Video** | `` `dw4 `` comprime videos a 360p (o como documento con `` `dw4 doc ``) |
| 📰 **RSS** | Suscripción a feeds con novedades traducidas al español |
| 🔄 **Actualización** | `` `gitpull `` actualiza el bot desde GitHub, con `--check`, `--force` y `--restart` |
| 🖥️ **Diagnóstico** | `` `host `` muestra el estado del servidor con la imagen de Rem |

## ⌨️ Comandos principales

El prefijo predeterminado es la comilla invertida (`` ` ``). Se puede cambiar con `BOT_PREFIX` en `.env`. Escribe `` `menu `` en el chat para ver todos los comandos.

### 📥 Descargas

```text
`mediafire <enlace>     descarga de MediaFire
`drive <enlace>         descarga de Google Drive
`facebook <enlace>      descarga video de Facebook
`pinterest <texto>      busca imágenes en Pinterest
`imagen <texto>         busca imágenes
`instagram <enlace>     descarga de Instagram / reels
`tiktok <enlace>        descarga video de TikTok
`twitter <enlace>       descarga de Twitter / X
```

### 👥 Grupos

```text
`kick @usuario           expulsa a un usuario (también `kick num +57` y `kick all`)
`warn @usuario           advierte; `warns, `delwarn y `setwarnlimit
`todos / `tagall         menciona a todos
`hidetag <texto>         mensaje con mención invisible
`promote / `demote      sube o baja a admin
`open / `close           abre o cierra el grupo
`link / `revoke          enlace de invitación
`count / `topcount      mensajes del grupo
`setwelcome <texto>      bienvenida con @user @group @desc
`setgpname / `setgpdesc / `setgpbanner
`bot on / `bot off       activa o apaga el bot en el grupo
```

### 💙 Menú y ajustes del bot

```text
`menu / `help / `ayuda   muestra el menú
`setbanner <imagen>      banner del menú
`setname <nombre>        nombre del bot
`seticon / `setpfp       foto de perfil del bot
`setstatus <texto>       estado del bot
`setlink / `setchannel   enlace y canal del bot
`setprefix <prefijo>     cambia el prefijo (`setprefix reset` lo restaura)
`setowner <número>       cambia el dueño
```

Los ajustes del bot, de los grupos, los warns y los contadores se guardan en `lib/system/botstore.json`, que se crea al primer uso. Si algún ajuste se corrompe, borrar ese archivo los resetea sin tocar la sesión de WhatsApp.

### 🎨 Stickers y más

```text
`s / `sticker            crea stickers de imagen, video o audio (hasta 60 s)
`wm <pack> <autor>       cambia el paquete/autor del sticker
`toimg / `tovid / `tomp3 convierte stickers y audio
`dw4                     comprime un video a 360p (responde al video)
`rss <feed>              suscribe un feed RSS (`rss list, `rss check...)
`host / `p               diagnóstico del servidor / latencia
`gitpull                 actualiza el bot (`--check, `--force, `--restart)
```

## 📋 Requisitos

- Node.js `>=25`.
- FFmpeg instalado en Termux y accesible como `ffmpeg` en `PATH`.

El proyecto fuerza la versión publicada de `libsignal` mediante `overrides` porque el fork de Baileys intenta cargar un binding nativo Android ARM64 que no está publicado en npm. Esto evita el error `Cannot find native binding` al instalar y ejecutar el bot en Termux.

Baileys se instala desde el registro npm (`baileys@7.0.0-rc14`) para evitar los errores `EALLOWGIT` y `EALLOWREMOTE` que aparecen en algunas instalaciones de npm para Termux cuando las dependencias se descargan mediante Git o URLs remotas.

## 📦 Dependencias de Termux

Actualiza los repositorios e instala Node.js, Git y FFmpeg:

```bash
pkg update -y && pkg upgrade -y
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

## 💾 Permiso de almacenamiento

Para permitir que Termux acceda al almacenamiento compartido de Android, ejecuta:

```bash
termux-setup-storage
```

Acepta el permiso cuando Android lo solicite. Esto crea el acceso `~/storage/`, incluyendo rutas como `~/storage/shared/` para los archivos del teléfono. El bot guarda su sesión y sus archivos temporales dentro de su propia carpeta, pero este permiso es necesario si vas a copiar vídeos desde el almacenamiento compartido o guardar resultados allí.

## 🚀 Instalar y enlazar WhatsApp en Termux

```bash
git clone https://github.com/JhonClD/RemBot-MD.git
cd RemBot-MD
npm install
npm start
```

`` `dw4 `` ejecuta el FFmpeg del sistema; no se descarga ni se incluye un binario FFmpeg en `package.json`. Si el ejecutable no se llama `ffmpeg` o no está en `PATH`, configura `FFMPEG_PATH` con la ruta al binario.

Escanea el QR desde WhatsApp → **Dispositivos vinculados** → **Vincular un dispositivo**. La sesión local se guarda en `Sessions/Owner/`; no compartas ni publiques esa carpeta.

## ⚙️ Configuración

Toma como base el archivo `.env.example`:

| Variable | Qué hace |
|---|---|
| `BOT_PREFIX` | Prefijo(s) del bot. Admite varios separados por coma o espacio (por ejemplo `BOT_PREFIX=.,/`). Por defecto: `` ` `` |
| `BOT_OWNER_NUMBER` | Números de los owners, separados por comas |
| `FFMPEG_PATH` | Ruta al binario FFmpeg si no está en `PATH` |

## 🎬 Usar `` `dw4 ``

Responde al mensaje que contiene el video con:

```text
`dw4
```

El resultado se envía como video MP4 a 360p. Para recibirlo como documento, usa `` `dw4 doc ``.

## 📰 Usar `` `rss ``

El comando RSS permite administrar fuentes y recibir automáticamente sus novedades traducidas al español:

```text
`rss https://ejemplo.com/feed.xml
`rss list
`rss ver [n]
`rss del <n>
`rss pause <n>
`rss resume <n>
`rss check
`rss test [n]
```

La configuración y los identificadores vistos se guardan localmente en `lib/system/tmp/rss-notify/feeds.json`, una ruta excluida por `.gitignore`. Agregar, eliminar, pausar, reanudar y probar feeds requiere ser owner o administrador del grupo.

## 📈 Progreso en terminal

Durante cada compresión, la terminal muestra aproximadamente una actualización por segundo: porcentaje, tiempo procesado y duración, frame, FPS y velocidad de FFmpeg. Cada trabajo usa un identificador corto y no imprime el JID del chat.

## 👑 Owners

Los owners se leen desde `BOT_OWNER_NUMBER` en `.env` local; admite varios números separados por comas. `.env` está excluido por `.gitignore` y no debe publicarse.

## 🔒 Alcance y seguridad

Los videos temporales se eliminan al terminar el procesamiento y la configuración RSS permanece fuera del repositorio. No publiques `.env`, sesiones de WhatsApp ni archivos dentro de `lib/system/tmp/`. Se mantienen la licencia MIT y los avisos de copyright originales en `LICENSE`.

## 💙 Créditos

- **Autor:** Jhon 𝗖𝗜𝗗
- **Librería:** [Baileys](https://github.com/WhiskeySockets/Baileys) (WhiskeySockets)
- **Comandos de descargas, grupos y menú:** adaptados de [YukiBot-MD](https://github.com/iamDestroy/YukiBot-MD) (iamDestroy)
- **Rem** es un personaje de *Re:Zero − Starting Life in Another World*
