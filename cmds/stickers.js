import {
  MAX_VIDEO_SECONDS,
  MAX_STATIC_AUDIO_SECONDS,
  MAX_ANIMATED_AUDIO_SECONDS,
  addStickerExif,
  isAnimatedWebp,
  createSticker,
  prepareStickerAudio,
  sendAudioSticker,
  downloadStickerAudio,
  stickerToMedia,
  extractAudioToMp3,
} from '../lib/exif.js';

export const MAX_INPUT_BYTES = 60 * 1024 * 1024; // 60 MB
const PAIRING_TTL_MS = 2 * 60 * 1000;
const pendingPairings = new Map();

const CREATE_CMDS = new Set([
  's',
  'sticker',
  'st',
  'scrop',
  'sfull',
  'scircle',
  'sredondo',
  'saudio',
  'sa',
  'ssound',
  'stickeraudio',
]);
const AUDIO_CMDS = new Set(['saudio', 'sa', 'ssound', 'stickeraudio']);
const CROP_CMDS = new Set(['scrop', 'sfull']);
const CIRCLE_CMDS = new Set(['scircle', 'sredondo']);
const WM_CMDS = new Set(['wm', 'take', 'robar']);
const TOVID_CMDS = new Set(['toimg', 'tovid', 'tomp4']);
const TOAUD_CMDS = new Set(['toaud', 'tomp3']);

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of pendingPairings) {
    if (entry.expiresAt <= now) pendingPairings.delete(key);
  }
}, 60_000);
cleanupTimer.unref?.();

function getPending(key) {
  const entry = pendingPairings.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    pendingPairings.delete(key);
    return null;
  }
  return entry;
}

function setPending(key, data) {
  pendingPairings.set(key, { ...data, expiresAt: Date.now() + PAIRING_TTL_MS });
}

function readFileLength(content) {
  const raw = content?.fileLength;
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'bigint') return Number(raw);
  if (raw && typeof raw === 'object' && typeof raw.low === 'number') {
    return (raw.high ? raw.high * 0x100000000 : 0) + (raw.low >>> 0);
  }
  return Number(raw) || 0;
}

export function sniffBufferMedia(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { kind: 'image', mime: 'image/png' };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { kind: 'image', mime: 'image/jpeg' };
  }
  const head6 = buf.subarray(0, 6).toString('ascii');
  if (head6 === 'GIF87a' || head6 === 'GIF89a') {
    return { kind: 'gif', mime: 'image/gif' };
  }
  const head4 = buf.subarray(0, 4).toString('ascii');
  const mark8 = buf.subarray(8, 12).toString('ascii');
  if (head4 === 'RIFF' && mark8 === 'WEBP') {
    return { kind: 'sticker', mime: 'image/webp' };
  }
  if (head4 === 'RIFF' && mark8 === 'WAVE') {
    return { kind: 'audio', mime: 'audio/wav' };
  }
  if (head4 === 'OggS') {
    return { kind: 'audio', mime: 'audio/ogg' };
  }
  if (head4 === 'fLaC') {
    return { kind: 'audio', mime: 'audio/flac' };
  }
  if (
    buf.subarray(0, 3).toString('ascii') === 'ID3' ||
    (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)
  ) {
    return { kind: 'audio', mime: 'audio/mpeg' };
  }
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    return { kind: 'video', mime: 'video/webm' };
  }
  if (buf.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = buf.subarray(8, 12).toString('ascii').toLowerCase();
    if (brand.startsWith('m4a') || brand === 'mp4a') {
      return { kind: 'audio', mime: 'audio/mp4' };
    }
    if (brand === 'avif' || brand === 'heic' || brand === 'mif1') {
      return { kind: 'image', mime: 'image/avif' };
    }
    return { kind: 'video', mime: 'video/mp4' };
  }
  return null;
}

export function classifyMedia(m) {
  if (!m) return null;
  const content = m.content || m.msg;
  if (!content || typeof content !== 'object') return null;
  const type = String(m.type || m.mtype || '');
  const mime = String(m.mimetype || content.mimetype || '').toLowerCase();
  const fileName = String(content.fileName || content.filename || '').toLowerCase();
  const hasMediaKey = !!(content.mediaKey || content.url || content.directPath);
  if (!hasMediaKey) return null;
  const fileLength = readFileLength(content);

  if (type === 'stickerMessage' || mime === 'image/webp' || fileName.endsWith('.webp')) {
    return {
      kind: 'sticker',
      mime: 'image/webp',
      gifPlayback: false,
      fileLength,
      audioMessage: content.audioMessage || null,
    };
  }
  if (
    (type === 'videoMessage' && content.gifPlayback) ||
    mime === 'image/gif' ||
    fileName.endsWith('.gif')
  ) {
    return {
      kind: 'gif',
      mime: mime || 'video/mp4',
      gifPlayback: true,
      fileLength,
      audioMessage: null,
    };
  }
  if (
    type === 'videoMessage' ||
    mime.startsWith('video/') ||
    /\.(mp4|mov|mkv|webm|m4v|3gp|avi)$/i.test(fileName)
  ) {
    return {
      kind: 'video',
      mime: mime || 'video/mp4',
      gifPlayback: false,
      fileLength,
      audioMessage: null,
    };
  }
  if (
    type === 'imageMessage' ||
    mime.startsWith('image/') ||
    /\.(jpe?g|png|bmp|avif|heic)$/i.test(fileName)
  ) {
    return {
      kind: 'image',
      mime: mime || 'image/jpeg',
      gifPlayback: false,
      fileLength,
      audioMessage: null,
    };
  }
  if (
    type === 'audioMessage' ||
    mime.startsWith('audio/') ||
    /\.(ogg|opus|mp3|m4a|wav|aac|flac)$/i.test(fileName)
  ) {
    return {
      kind: 'audio',
      mime: mime || 'audio/ogg',
      gifPlayback: false,
      fileLength,
      audioMessage: null,
    };
  }
  if (type === 'documentMessage') {
    return {
      kind: 'octet-stream',
      mime: mime || 'application/octet-stream',
      gifPlayback: false,
      fileLength,
      audioMessage: null,
    };
  }
  return null;
}

async function downloadTargetBuffer(target, info, sock) {
  if (info?.fileLength > MAX_INPUT_BYTES) {
    const err = new Error('El archivo supera el límite máximo permitido de 60 MB.');
    err.code = 'FILE_TOO_LARGE';
    throw err;
  }
  const buf = await (typeof target.download === 'function'
    ? target.download()
    : sock.downloadMediaMessage(target));
  if (!Buffer.isBuffer(buf) || !buf.length) {
    throw new Error('No se pudo descargar el archivo multimedia.');
  }
  if (buf.length > MAX_INPUT_BYTES) {
    const err = new Error('El archivo supera el límite máximo permitido de 60 MB.');
    err.code = 'FILE_TOO_LARGE';
    throw err;
  }
  if (info?.kind === 'octet-stream') {
    const sniffed = sniffBufferMedia(buf);
    if (sniffed) {
      info.kind = sniffed.kind;
      info.mime = sniffed.mime;
    }
  }
  return buf;
}

export function parseStickerText(rawText, msg, command = 's', isWm = false) {
  let clean = String(rawText || '').trim();
  let mode = CIRCLE_CMDS.has(command)
    ? 'circle'
    : CROP_CMDS.has(command)
      ? 'crop'
      : 'default';
  let forceAudio = AUDIO_CMDS.has(command);
  let mute = false;

  const flagTokens = [
    {
      re: /(?:^|\s)--?(?:circle|redondo)(?=\s|$)/gi,
      apply: () => {
        mode = 'circle';
      },
    },
    {
      re: /(?:^|\s)--?(?:crop|full)(?=\s|$)/gi,
      apply: () => {
        mode = 'crop';
      },
    },
    {
      re: /(?:^|\s)--?(?:audio|a)(?=\s|$)/gi,
      apply: () => {
        forceAudio = true;
      },
    },
    {
      re: /(?:^|\s)--?(?:mute|m)(?=\s|$)/gi,
      apply: () => {
        mute = true;
      },
    },
  ];

  for (const { re, apply } of flagTokens) {
    if (re.test(clean)) {
      apply();
      clean = clean.replace(re, ' ').trim();
    }
  }

  const isCancel = /^(cancelar|cancel)$/i.test(clean);
  const hasCustomMeta = clean.length > 0 && !isCancel;
  const fallbackBot = global.packname || global.dev || 'RemBot-MD';
  const fallbackPack = msg?.pushName || fallbackBot;
  const fallbackAuthor = isWm ? '' : fallbackBot;

  let packname = fallbackPack;
  let author = fallbackAuthor;
  if (hasCustomMeta) {
    if (clean.includes('|')) {
      const [p, ...rest] = clean.split('|');
      packname = p.trim();
      author = rest.join('|').trim();
    } else {
      packname = clean;
      author = '';
    }
  }
  return { mode, forceAudio, mute, isCancel, hasCustomMeta, packname, author };
}

async function resolveAudioSourceFromTarget(target, targetInfo, sock, maxSeconds) {
  if (targetInfo.kind === 'sticker' && targetInfo.audioMessage) {
    return { audioMessage: targetInfo.audioMessage };
  }
  const buf = await downloadTargetBuffer(target, targetInfo, sock);
  if (targetInfo.kind === 'octet-stream') {
    const err = new Error('Documento sin pista de audio reconocida.');
    err.code = 'NO_AUDIO_STREAM';
    throw err;
  }
  return await prepareStickerAudio(buf, { maxSeconds });
}

async function sendNormalSticker(sock, chat, webpBuffer, isAnimated, quoted) {
  return await sock.sendMessage(
    chat,
    { sticker: webpBuffer, isAnimated: Boolean(isAnimated) },
    { quoted },
  );
}

async function handleStickerCreate({ msg, sock, command, usedPrefix, text }) {
  const p = usedPrefix || '`';
  const { mode, forceAudio, mute, isCancel, hasCustomMeta, packname, author } =
    parseStickerText(text, msg, command, false);
  const pairKey = `${msg.chat}_${msg.sender}`;

  if (isCancel) {
    if (pendingPairings.delete(pairKey)) {
      return msg.reply('✅ Emparejamiento de sticker con audio cancelado.');
    }
    return msg.reply('ℹ️ No tienes ningún sticker o audio pendiente por emparejar.');
  }

  const selfInfo = classifyMedia(msg);
  const quotedInfo = classifyMedia(msg.quoted);

  // Resolver documentos sin comprimir (application/octet-stream) en mensaje propio si existe
  let preloadedSelfBuf = null;
  if (selfInfo?.kind === 'octet-stream') {
    preloadedSelfBuf = await downloadTargetBuffer(msg, selfInfo, sock);
  }
  let preloadedQuotedBuf = null;
  if (quotedInfo?.kind === 'octet-stream') {
    preloadedQuotedBuf = await downloadTargetBuffer(msg.quoted, quotedInfo, sock);
  }

  const getBuf = async (target, info) => {
    if (target === msg && preloadedSelfBuf) return preloadedSelfBuf;
    if (target === msg.quoted && preloadedQuotedBuf) return preloadedQuotedBuf;
    return await downloadTargetBuffer(target, info, sock);
  };

  // 1) Combinación directa en 1 paso: imagen/video/gif/sticker en msg + audio/video/sticker-con-audio citado
  const selfIsVisual =
    selfInfo && ['image', 'video', 'gif', 'sticker'].includes(selfInfo.kind);
  const quotedHasAudioCandidate =
    quotedInfo &&
    (quotedInfo.kind === 'audio' ||
      quotedInfo.kind === 'video' ||
      (quotedInfo.kind === 'sticker' && !!quotedInfo.audioMessage));

  if (selfIsVisual && quotedHasAudioCandidate && !mute) {
    pendingPairings.delete(pairKey);
    const visualBuf = await getBuf(msg, selfInfo);
    const { buffer: webpBuffer, isAnimated } = await createSticker(visualBuf, {
      isVideo: selfInfo.kind === 'video' || selfInfo.kind === 'gif',
      mimetype: selfInfo.mime,
      mode,
      packname,
      author,
      categories: ['🔊'],
      maxSeconds: MAX_VIDEO_SECONDS,
    });
    const maxAudSec = isAnimated ? MAX_ANIMATED_AUDIO_SECONDS : MAX_STATIC_AUDIO_SECONDS;
    try {
      let audioSource;
      if (quotedInfo.kind === 'sticker' && quotedInfo.audioMessage) {
        audioSource = { audioMessage: quotedInfo.audioMessage };
      } else {
        const qBuf = await getBuf(msg.quoted, quotedInfo);
        audioSource = await prepareStickerAudio(qBuf, { maxSeconds: maxAudSec });
      }
      return await sendAudioSticker(sock, msg.chat, webpBuffer, audioSource, {
        quoted: msg,
        isAnimated,
      });
    } catch (err) {
      if (err?.code === 'NO_AUDIO_STREAM') {
        return msg.reply('⚠️ El mensaje citado no contiene pista de audio.');
      }
      throw err;
    }
  }

  // Caso simétrico en 1 paso: documento de audio con caption `s respondiendo a imagen/video/sticker
  if (
    selfInfo?.kind === 'audio' &&
    quotedInfo &&
    ['image', 'video', 'gif', 'sticker'].includes(quotedInfo.kind) &&
    !mute
  ) {
    pendingPairings.delete(pairKey);
    const [audioBuf, visualBuf] = await Promise.all([
      getBuf(msg, selfInfo),
      getBuf(msg.quoted, quotedInfo),
    ]);
    const { buffer: webpBuffer, isAnimated } = await createSticker(visualBuf, {
      isVideo: quotedInfo.kind === 'video' || quotedInfo.kind === 'gif',
      mimetype: quotedInfo.mime,
      mode,
      packname,
      author,
      categories: ['🔊'],
      maxSeconds: MAX_VIDEO_SECONDS,
    });
    const audioPrepared = await prepareStickerAudio(audioBuf, {
      maxSeconds: isAnimated ? MAX_ANIMATED_AUDIO_SECONDS : MAX_STATIC_AUDIO_SECONDS,
    });
    return await sendAudioSticker(sock, msg.chat, webpBuffer, audioPrepared, {
      quoted: msg,
      isAnimated,
    });
  }

  const target =
    selfInfo && selfInfo.kind !== 'octet-stream'
      ? msg
      : quotedInfo && quotedInfo.kind !== 'octet-stream'
        ? msg.quoted
        : null;
  const targetInfo =
    selfInfo && selfInfo.kind !== 'octet-stream'
      ? selfInfo
      : quotedInfo && quotedInfo.kind !== 'octet-stream'
        ? quotedInfo
        : null;
  const pending = !mute ? getPending(pairKey) : null;

  // 2) Completar emparejamiento en 2 pasos
  if (pending && target && targetInfo) {
    if (
      pending.step === 'audio' &&
      ['image', 'video', 'gif', 'sticker'].includes(targetInfo.kind)
    ) {
      pendingPairings.delete(pairKey);
      const visualBuf = await getBuf(target, targetInfo);
      const { buffer: webpBuffer, isAnimated } = await createSticker(visualBuf, {
        isVideo: targetInfo.kind === 'video' || targetInfo.kind === 'gif',
        mimetype: targetInfo.mime,
        mode,
        packname,
        author,
        categories: ['🔊'],
        maxSeconds: MAX_VIDEO_SECONDS,
      });
      return await sendAudioSticker(sock, msg.chat, webpBuffer, pending.audioPrepared, {
        quoted: msg,
        isAnimated,
      });
    }

    if (
      pending.step === 'sticker' &&
      (targetInfo.kind === 'audio' ||
        targetInfo.kind === 'video' ||
        (targetInfo.kind === 'sticker' && !!targetInfo.audioMessage))
    ) {
      try {
        const maxAudSec = pending.isAnimated
          ? MAX_ANIMATED_AUDIO_SECONDS
          : MAX_STATIC_AUDIO_SECONDS;
        let audioSource;
        if (targetInfo.kind === 'sticker' && targetInfo.audioMessage) {
          audioSource = { audioMessage: targetInfo.audioMessage };
        } else {
          const aBuf = await getBuf(target, targetInfo);
          audioSource = await prepareStickerAudio(aBuf, { maxSeconds: maxAudSec });
        }
        pendingPairings.delete(pairKey);
        const finalWebp = hasCustomMeta
          ? await addStickerExif(pending.webpBuffer, {
              packname,
              author,
              categories: ['🔊'],
            })
          : pending.webpBuffer;
        return await sendAudioSticker(sock, msg.chat, finalWebp, audioSource, {
          quoted: msg,
          isAnimated: pending.isAnimated,
        });
      } catch (err) {
        if (err?.code === 'NO_AUDIO_STREAM') {
          return msg.reply(
            '⚠️ El video citado no tiene audio. Responde a un audio o video con sonido.',
          );
        }
        throw err;
      }
    }
  }

  if (!target || !targetInfo) {
    return msg.reply(
      `Responde a una imagen, video (hasta 60 s), sticker o audio con *${p}${command}*.\n` +
        `• *${p}s* sobre video → sticker HD animado fluido con su audio hasta 60 s (*-mute* para silenciar).\n` +
        `• *${p}scrop* / *${p}scircle* (o flags *-crop*, *-circle*) → recorte cuadrado o circular.\n` +
        `• Imagen/video con *${p}s* citando un audio → sticker con sonido en 1 paso.\n` +
        `• *${p}s* o *${p}saudio* sobre un audio → guarda el sonido 2 min para tu siguiente *${p}s*.`,
    );
  }

  // 3) Iniciar paso 1 sobre un audio
  if (targetInfo.kind === 'audio') {
    if (mute) {
      return msg.reply(
        `Envía o responde a una imagen o video con *${p}s* para crear un sticker sin sonido.`,
      );
    }
    const audioBuf = await getBuf(target, targetInfo);
    const audioPrepared = await prepareStickerAudio(audioBuf, {
      maxSeconds: MAX_ANIMATED_AUDIO_SECONDS,
    });
    setPending(pairKey, { step: 'audio', audioPrepared });
    return msg.reply(
      `🎵 Audio guardado (${audioPrepared.seconds} s). Tienes 2 minutos para enviar o responder con *${p}s* a una imagen, video o sticker (usa *${p}s cancelar* para anular).`,
    );
  }

  // 4) `saudio / -audio sobre imagen/sticker/gif (o video mudo): guarda el WebP esperando audio
  if (forceAudio) {
    if (targetInfo.kind === 'video' && !mute) {
      const videoBuf = await getBuf(target, targetInfo);
      const { buffer: webpBuffer, isAnimated } = await createSticker(videoBuf, {
        isVideo: true,
        mimetype: targetInfo.mime,
        mode,
        packname,
        author,
        categories: ['🔊'],
        maxSeconds: MAX_VIDEO_SECONDS,
      });
      try {
        const audioPrepared = await prepareStickerAudio(videoBuf, {
          maxSeconds: MAX_ANIMATED_AUDIO_SECONDS,
        });
        return await sendAudioSticker(sock, msg.chat, webpBuffer, audioPrepared, {
          quoted: msg,
          isAnimated,
        });
      } catch (err) {
        if (err?.code !== 'NO_AUDIO_STREAM') throw err;
        setPending(pairKey, { step: 'sticker', webpBuffer, isAnimated });
        return msg.reply(
          `🖼️ El video no tiene sonido; guardé el sticker. Responde en menos de 2 minutos con *${p}saudio* o *${p}s* a un audio (usa *${p}saudio cancelar* para anular).`,
        );
      }
    }

    const rawBuf = await getBuf(target, targetInfo);
    const { buffer: webpBuffer, isAnimated } = await createSticker(rawBuf, {
      isVideo: targetInfo.kind === 'gif',
      mimetype: targetInfo.mime,
      mode,
      packname,
      author,
      categories: ['🔊'],
      maxSeconds: MAX_VIDEO_SECONDS,
    });
    setPending(pairKey, { step: 'sticker', webpBuffer, isAnimated });
    return msg.reply(
      `🖼️ Sticker guardado. Tienes 2 minutos para responder con *${p}saudio* o *${p}s* a un audio o video con sonido (usa *${p}saudio cancelar* para anular).`,
    );
  }

  // 5) Video + `s / `scrop / `scircle: hasta 60s de video fluido + audio automático salvo GIF o -mute
  if (targetInfo.kind === 'video') {
    const videoBuf = await getBuf(target, targetInfo);
    const { buffer: webpBuffer, isAnimated } = await createSticker(videoBuf, {
      isVideo: true,
      mimetype: targetInfo.mime,
      mode,
      packname,
      author,
      maxSeconds: MAX_VIDEO_SECONDS,
    });
    if (!mute && !targetInfo.gifPlayback) {
      try {
        const audioPrepared = await prepareStickerAudio(videoBuf, {
          maxSeconds: MAX_ANIMATED_AUDIO_SECONDS,
        });
        const withSoundEmoji = await addStickerExif(webpBuffer, {
          packname,
          author,
          categories: ['🔊'],
        });
        return await sendAudioSticker(sock, msg.chat, withSoundEmoji, audioPrepared, {
          quoted: msg,
          isAnimated,
        });
      } catch (err) {
        if (err?.code !== 'NO_AUDIO_STREAM') throw err;
      }
    }
    return await sendNormalSticker(sock, msg.chat, webpBuffer, isAnimated, msg);
  }

  // 6) `s / `scrop / `scircle sobre un sticker existente (reencuadra si mode !== 'default' y conserva audio salvo -mute)
  if (targetInfo.kind === 'sticker') {
    const rawWebp = await getBuf(target, targetInfo);
    let newWebp;
    let isAnim;
    if (mode !== 'default') {
      const reframed = await createSticker(rawWebp, {
        mode,
        packname,
        author,
        categories: targetInfo.audioMessage && !mute ? ['🔊'] : [''],
        maxSeconds: MAX_VIDEO_SECONDS,
      });
      newWebp = reframed.buffer;
      isAnim = reframed.isAnimated;
    } else {
      newWebp = await addStickerExif(rawWebp, {
        packname,
        author,
        categories: targetInfo.audioMessage && !mute ? ['🔊'] : [''],
      });
      isAnim = await isAnimatedWebp(newWebp);
    }

    if (targetInfo.audioMessage && !mute) {
      return await sendAudioSticker(
        sock,
        msg.chat,
        newWebp,
        { audioMessage: targetInfo.audioMessage },
        { quoted: msg, isAnimated: isAnim },
      );
    }
    return await sendNormalSticker(sock, msg.chat, newWebp, isAnim, msg);
  }

  // 7) Imagen o GIF + `s / `scrop / `scircle -> sticker HD 512x512 VP8L lossless o animado fluido
  const mediaBuf = await getBuf(target, targetInfo);
  const { buffer: webpBuffer, isAnimated } = await createSticker(mediaBuf, {
    isVideo: targetInfo.kind === 'gif',
    mimetype: targetInfo.mime,
    mode,
    packname,
    author,
    maxSeconds: MAX_VIDEO_SECONDS,
  });
  return await sendNormalSticker(sock, msg.chat, webpBuffer, isAnimated, msg);
}

async function handleWm({ msg, sock, command, usedPrefix, text }) {
  const p = usedPrefix || '`';
  const selfInfo = classifyMedia(msg);
  const quotedInfo = classifyMedia(msg.quoted);
  const target =
    quotedInfo?.kind === 'sticker' ? msg.quoted : selfInfo?.kind === 'sticker' ? msg : null;
  const targetInfo =
    quotedInfo?.kind === 'sticker' ? quotedInfo : selfInfo?.kind === 'sticker' ? selfInfo : null;

  if (!target || !targetInfo) {
    return msg.reply(
      `Responde a un sticker con *${p}${command} Nombre | Autor* para cambiar sus metadatos sin perder calidad.`,
    );
  }

  const { mute, packname, author } = parseStickerText(text, msg, command, true);
  const rawWebp = await downloadTargetBuffer(target, targetInfo, sock);
  const keepAudio = !!(targetInfo.audioMessage && !mute);
  const newWebp = await addStickerExif(rawWebp, {
    packname,
    author,
    categories: keepAudio ? ['🔊'] : [''],
  });
  const isAnim = await isAnimatedWebp(newWebp);

  if (keepAudio) {
    return await sendAudioSticker(
      sock,
      msg.chat,
      newWebp,
      { audioMessage: targetInfo.audioMessage },
      { quoted: msg, isAnimated: isAnim },
    );
  }
  return await sendNormalSticker(sock, msg.chat, newWebp, isAnim, msg);
}

async function handleToVidOrImg({ msg, sock, command, usedPrefix }) {
  const p = usedPrefix || '`';
  const toImageOnly = command === 'toimg';
  const quotedInfo = classifyMedia(msg.quoted);
  if (!msg.quoted || quotedInfo?.kind !== 'sticker') {
    return msg.reply(`Responde a un sticker con *${p}${command}* para convertirlo.`);
  }

  const webpBuf = await downloadTargetBuffer(msg.quoted, quotedInfo, sock);
  if (toImageOnly) {
    const imgRes = await stickerToMedia(webpBuf, { toImageOnly: true });
    return await sock.sendMessage(
      msg.chat,
      { image: imgRes.buffer, mimetype: 'image/png' },
      { quoted: msg },
    );
  }

  const stickerAudio = await downloadStickerAudio(msg.quoted).catch(() => null);
  const vidRes = await stickerToMedia(webpBuf, { audioBuffer: stickerAudio });
  return await sock.sendMessage(
    msg.chat,
    { video: vidRes.buffer, mimetype: 'video/mp4' },
    { quoted: msg },
  );
}

async function handleToAud({ msg, sock, command, usedPrefix }) {
  const p = usedPrefix || '`';
  const quotedInfo = classifyMedia(msg.quoted);
  if (!msg.quoted || !quotedInfo) {
    return msg.reply(
      `Responde a un sticker con sonido, video o nota de voz con *${p}${command}* para extraer el MP3.`,
    );
  }

  if (quotedInfo.kind === 'sticker') {
    const stickerAudio = await downloadStickerAudio(msg.quoted);
    if (!stickerAudio) {
      return msg.reply(
        '⚠️ Ese sticker no contiene audio (o el mensaje original ya no está en memoria; reenvía el sticker e inténtalo de nuevo).',
      );
    }
    const mp3 = await extractAudioToMp3(stickerAudio);
    return await sock.sendMessage(
      msg.chat,
      { audio: mp3.buffer, mimetype: 'audio/mpeg', ptt: false },
      { quoted: msg },
    );
  }

  let rawBuf = null;
  if (quotedInfo.kind === 'octet-stream') {
    rawBuf = await downloadTargetBuffer(msg.quoted, quotedInfo, sock);
  }

  if (quotedInfo.kind === 'video' || quotedInfo.kind === 'audio') {
    try {
      if (!rawBuf) {
        rawBuf = await downloadTargetBuffer(msg.quoted, quotedInfo, sock);
      }
      const mp3 = await extractAudioToMp3(rawBuf);
      return await sock.sendMessage(
        msg.chat,
        { audio: mp3.buffer, mimetype: 'audio/mpeg', ptt: false },
        { quoted: msg },
      );
    } catch (err) {
      if (err?.code === 'NO_AUDIO_STREAM') {
        return msg.reply('⚠️ El video citado no contiene pista de audio.');
      }
      throw err;
    }
  }

  return msg.reply(`Responde a un sticker con sonido, video o audio con *${p}${command}*.`);
}

async function runStickers(ctx) {
  const { msg, command } = ctx;
  try {
    if (CREATE_CMDS.has(command)) return await handleStickerCreate(ctx);
    if (WM_CMDS.has(command)) return await handleWm(ctx);
    if (TOVID_CMDS.has(command)) return await handleToVidOrImg(ctx);
    if (TOAUD_CMDS.has(command)) return await handleToAud(ctx);
  } catch (err) {
    if (err?.code === 'FILE_TOO_LARGE') {
      return msg.reply('⚠️ El archivo supera el límite máximo permitido de 60 MB.');
    }
    throw err;
  }
}

export const __test = {
  pendingPairings,
  classifyMedia,
  sniffBufferMedia,
  parseStickerText,
  runStickers,
};

export default {
  command: [
    's',
    'sticker',
    'st',
    'scrop',
    'sfull',
    'scircle',
    'sredondo',
    'saudio',
    'sa',
    'ssound',
    'stickeraudio',
    'wm',
    'take',
    'robar',
    'toimg',
    'tovid',
    'tomp4',
    'toaud',
    'tomp3',
  ],
  category: 'stickers',
  description:
    'Stickers HD de hasta 60s (512x512 VP8L sin pérdida, animados fluidos 12-24 fps, audio nativo WhatsApp, recorte cuadrado/circular, WM y conversión inversa).',
  run: runStickers,
};
