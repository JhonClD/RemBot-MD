import {
  addStickerExif,
  isAnimatedWebp,
  createSticker,
  prepareStickerAudio,
  sendAudioSticker,
  downloadStickerAudio,
  stickerToMedia,
  extractAudioToMp3,
} from '../lib/exif.js';

const PAIRING_TTL_MS = 2 * 60 * 1000;
const pendingPairings = new Map();

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

function classifyMedia(m) {
  if (!m) return null;
  const content = m.content || m.msg;
  if (!content || typeof content !== 'object') return null;
  const type = String(m.type || m.mtype || '');
  const mime = String(m.mimetype || content.mimetype || '').toLowerCase();
  const fileName = String(content.fileName || content.filename || '').toLowerCase();
  const hasMediaKey = !!(content.mediaKey || content.url || content.directPath);
  if (!hasMediaKey) return null;

  if (type === 'stickerMessage' || mime === 'image/webp' || fileName.endsWith('.webp')) {
    return {
      kind: 'sticker',
      mime: 'image/webp',
      gifPlayback: false,
      audioMessage: content.audioMessage || null,
    };
  }
  if ((type === 'videoMessage' && content.gifPlayback) || mime === 'image/gif' || fileName.endsWith('.gif')) {
    return { kind: 'gif', mime: mime || 'video/mp4', gifPlayback: true, audioMessage: null };
  }
  if (
    type === 'videoMessage' ||
    mime.startsWith('video/') ||
    /\.(mp4|mov|mkv|webm|m4v|3gp|avi)$/i.test(fileName)
  ) {
    return { kind: 'video', mime: mime || 'video/mp4', gifPlayback: false, audioMessage: null };
  }
  if (
    type === 'imageMessage' ||
    mime.startsWith('image/') ||
    /\.(jpe?g|png|bmp|avif|heic)$/i.test(fileName)
  ) {
    return { kind: 'image', mime: mime || 'image/jpeg', gifPlayback: false, audioMessage: null };
  }
  if (
    type === 'audioMessage' ||
    mime.startsWith('audio/') ||
    /\.(ogg|opus|mp3|m4a|wav|aac|flac)$/i.test(fileName)
  ) {
    return { kind: 'audio', mime: mime || 'audio/ogg', gifPlayback: false, audioMessage: null };
  }
  return null;
}

function parseStickerText(rawText, msg, isWm = false) {
  let clean = String(rawText || '').trim();
  const mute = /(?:^|\s)--?mute(?:\s|$)/i.test(clean);
  if (mute) {
    clean = clean.replace(/(?:^|\s)--?mute(?=\s|$)/gi, ' ').trim();
  }
  const isCancel = /^(cancelar|cancel)$/i.test(clean);
  const hasCustomMeta = clean.length > 0 && !isCancel;
  const fallbackPack = msg?.pushName || global.dev || 'RemBot-MD';
  const fallbackAuthor = isWm ? '' : global.dev || 'RemBot-MD';

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
  return { mute, isCancel, hasCustomMeta, packname, author };
}

async function resolveAudioSourceFromTarget(target, targetInfo) {
  if (targetInfo.kind === 'sticker' && targetInfo.audioMessage) {
    return { audioMessage: targetInfo.audioMessage };
  }
  const buf = await target.download();
  return await prepareStickerAudio(buf, { maxSeconds: 10 });
}

async function handleStickerCreate({ msg, sock, command, usedPrefix, text }) {
  const p = usedPrefix || '`';
  const isSaudio = command === 'saudio' || command === 'sa';
  const { mute, isCancel, hasCustomMeta, packname, author } = parseStickerText(text, msg, false);
  const pairKey = `${msg.chat}_${msg.sender}`;

  if (isCancel) {
    if (pendingPairings.delete(pairKey)) {
      return msg.reply('✅ Emparejamiento de sticker con audio cancelado.');
    }
    return msg.reply('ℹ️ No tienes ningún sticker o audio pendiente por emparejar.');
  }

  const selfInfo = classifyMedia(msg);
  const quotedInfo = classifyMedia(msg.quoted);

  // 1) Combinación directa en 1 paso: imagen/video/gif en el mensaje + audio/video/sticker-con-audio citado
  const selfIsVisual =
    selfInfo && ['image', 'video', 'gif', 'sticker'].includes(selfInfo.kind);
  const quotedHasAudioCandidate =
    quotedInfo &&
    (quotedInfo.kind === 'audio' ||
      quotedInfo.kind === 'video' ||
      (quotedInfo.kind === 'sticker' && !!quotedInfo.audioMessage));

  if (selfIsVisual && quotedHasAudioCandidate && !mute) {
    pendingPairings.delete(pairKey);
    const visualBuf = await msg.download();
    const { buffer: webpBuffer, isAnimated } = await createSticker(visualBuf, {
      isVideo: selfInfo.kind === 'video' || selfInfo.kind === 'gif',
      mimetype: selfInfo.mime,
      packname,
      author,
    });
    try {
      const audioSource = await resolveAudioSourceFromTarget(msg.quoted, quotedInfo);
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
    const [audioBuf, visualBuf] = await Promise.all([msg.download(), msg.quoted.download()]);
    const [audioPrepared, { buffer: webpBuffer, isAnimated }] = await Promise.all([
      prepareStickerAudio(audioBuf, { maxSeconds: 10 }),
      createSticker(visualBuf, {
        isVideo: quotedInfo.kind === 'video' || quotedInfo.kind === 'gif',
        mimetype: quotedInfo.mime,
        packname,
        author,
      }),
    ]);
    return await sendAudioSticker(sock, msg.chat, webpBuffer, audioPrepared, {
      quoted: msg,
      isAnimated,
    });
  }

  const target = selfInfo ? msg : quotedInfo ? msg.quoted : null;
  const targetInfo = selfInfo || quotedInfo;
  const pending = !mute ? getPending(pairKey) : null;

  // 2) Completar emparejamiento en 2 pasos
  if (pending && target && targetInfo) {
    if (
      pending.step === 'audio' &&
      ['image', 'video', 'gif', 'sticker'].includes(targetInfo.kind)
    ) {
      pendingPairings.delete(pairKey);
      const visualBuf = await target.download();
      const { buffer: webpBuffer, isAnimated } = await createSticker(visualBuf, {
        isVideo: targetInfo.kind === 'video' || targetInfo.kind === 'gif',
        mimetype: targetInfo.mime,
        packname,
        author,
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
        const audioSource = await resolveAudioSourceFromTarget(target, targetInfo);
        pendingPairings.delete(pairKey);
        const finalWebp = hasCustomMeta
          ? await addStickerExif(pending.webpBuffer, { packname, author })
          : pending.webpBuffer;
        return await sendAudioSticker(sock, msg.chat, finalWebp, audioSource, {
          quoted: msg,
          isAnimated: pending.isAnimated,
        });
      } catch (err) {
        if (err?.code === 'NO_AUDIO_STREAM') {
          return msg.reply('⚠️ El video citado no tiene audio. Responde a un audio o video con sonido.');
        }
        throw err;
      }
    }
  }

  if (!target || !targetInfo) {
    return msg.reply(
      `Responde a una imagen, video, sticker o audio con *${p}${command}*.\n` +
        `• Video con sonido + *${p}s* → sticker animado con audio (añade *-mute* para silenciar).\n` +
        `• Imagen/video con comentario *${p}s* citando un audio → sticker con audio en 1 paso.\n` +
        `• *${p}s* o *${p}saudio* sobre un audio → guarda el sonido 2 min para tu siguiente *${p}s*.`,
    );
  }

  // 3) Iniciar paso 1 sobre un audio (tanto con `s como con `saudio)
  if (targetInfo.kind === 'audio') {
    if (mute) {
      return msg.reply(`Envía o responde a una imagen o video con *${p}s* para crear un sticker sin sonido.`);
    }
    const audioBuf = await target.download();
    const audioPrepared = await prepareStickerAudio(audioBuf, { maxSeconds: 10 });
    setPending(pairKey, { step: 'audio', audioPrepared });
    return msg.reply(
      `🎵 Audio guardado (${audioPrepared.seconds} s). Tienes 2 minutos para enviar o responder con *${p}s* a una imagen, video o sticker (usa *${p}s cancelar* para anular).`,
    );
  }

  // 4) `saudio sobre imagen/sticker/gif (o video mudo): guarda el WebP esperando el audio
  if (isSaudio) {
    if (targetInfo.kind === 'video' && !mute) {
      const videoBuf = await target.download();
      const { buffer: webpBuffer, isAnimated } = await createSticker(videoBuf, {
        isVideo: true,
        mimetype: targetInfo.mime,
        packname,
        author,
      });
      try {
        const audioPrepared = await prepareStickerAudio(videoBuf, { maxSeconds: 10 });
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

    const rawBuf = await target.download();
    const { buffer: webpBuffer, isAnimated } = await createSticker(rawBuf, {
      isVideo: targetInfo.kind === 'gif',
      mimetype: targetInfo.mime,
      packname,
      author,
    });
    setPending(pairKey, { step: 'sticker', webpBuffer, isAnimated });
    return msg.reply(
      `🖼️ Sticker guardado. Tienes 2 minutos para responder con *${p}saudio* o *${p}s* a un audio o video con sonido (usa *${p}saudio cancelar* para anular).`,
    );
  }

  // 5) Video + `s: extrae hasta 10s de audio automáticamente salvo GIF o -mute; si es mudo envía sticker normal
  if (targetInfo.kind === 'video') {
    const videoBuf = await target.download();
    const { buffer: webpBuffer, isAnimated } = await createSticker(videoBuf, {
      isVideo: true,
      mimetype: targetInfo.mime,
      packname,
      author,
    });
    if (!mute && !targetInfo.gifPlayback) {
      try {
        const audioPrepared = await prepareStickerAudio(videoBuf, { maxSeconds: 10 });
        return await sendAudioSticker(sock, msg.chat, webpBuffer, audioPrepared, {
          quoted: msg,
          isAnimated,
        });
      } catch (err) {
        if (err?.code !== 'NO_AUDIO_STREAM') throw err;
      }
    }
    return await sock.sendMessage(msg.chat, { sticker: webpBuffer }, { quoted: msg });
  }

  // 6) `s sobre un sticker existente: conserva audioMessage salvo -mute
  if (targetInfo.kind === 'sticker') {
    const rawWebp = await target.download();
    const newWebp = await addStickerExif(rawWebp, { packname, author });
    const isAnim = await isAnimatedWebp(newWebp);
    if (targetInfo.audioMessage && !mute) {
      return await sendAudioSticker(
        sock,
        msg.chat,
        newWebp,
        { audioMessage: targetInfo.audioMessage },
        { quoted: msg, isAnimated: isAnim },
      );
    }
    return await sock.sendMessage(msg.chat, { sticker: newWebp }, { quoted: msg });
  }

  // 7) Imagen o GIF + `s → sticker estático o animado sin sonido
  const mediaBuf = await target.download();
  const { buffer: webpBuffer } = await createSticker(mediaBuf, {
    isVideo: targetInfo.kind === 'gif',
    mimetype: targetInfo.mime,
    packname,
    author,
  });
  return await sock.sendMessage(msg.chat, { sticker: webpBuffer }, { quoted: msg });
}

async function handleWm({ msg, sock, usedPrefix, text }) {
  const p = usedPrefix || '`';
  const selfInfo = classifyMedia(msg);
  const quotedInfo = classifyMedia(msg.quoted);
  const target =
    quotedInfo?.kind === 'sticker' ? msg.quoted : selfInfo?.kind === 'sticker' ? msg : null;
  const targetInfo =
    quotedInfo?.kind === 'sticker' ? quotedInfo : selfInfo?.kind === 'sticker' ? selfInfo : null;

  if (!target || !targetInfo) {
    return msg.reply(`Responde a un sticker con *${p}wm Nombre | Autor* para cambiar sus metadatos.`);
  }

  const { mute, packname, author } = parseStickerText(text, msg, true);
  const rawWebp = await target.download();
  const newWebp = await addStickerExif(rawWebp, { packname, author });
  const isAnim = await isAnimatedWebp(newWebp);

  if (targetInfo.audioMessage && !mute) {
    return await sendAudioSticker(
      sock,
      msg.chat,
      newWebp,
      { audioMessage: targetInfo.audioMessage },
      { quoted: msg, isAnimated: isAnim },
    );
  }
  return await sock.sendMessage(msg.chat, { sticker: newWebp }, { quoted: msg });
}

async function handleToVidOrImg({ msg, sock, command, usedPrefix }) {
  const p = usedPrefix || '`';
  const toImageOnly = command === 'toimg';
  const quotedInfo = classifyMedia(msg.quoted);
  if (!msg.quoted || quotedInfo?.kind !== 'sticker') {
    return msg.reply(`Responde a un sticker con *${p}${command}* para convertirlo.`);
  }

  const webpBuf = await msg.quoted.download();
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
      return msg.reply('⚠️ Ese sticker no contiene audio (o el mensaje original ya no está en memoria; reenvía el sticker e inténtalo de nuevo).');
    }
    const mp3 = await extractAudioToMp3(stickerAudio);
    return await sock.sendMessage(
      msg.chat,
      { audio: mp3.buffer, mimetype: 'audio/mpeg', ptt: false },
      { quoted: msg },
    );
  }

  if (quotedInfo.kind === 'video' || quotedInfo.kind === 'audio') {
    try {
      const rawBuf = await msg.quoted.download();
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
  const { command } = ctx;
  if (['s', 'sticker', 'saudio', 'sa'].includes(command)) {
    return handleStickerCreate(ctx);
  }
  if (['wm', 'take', 'robar'].includes(command)) {
    return handleWm(ctx);
  }
  if (['tovid', 'tomp4', 'toimg'].includes(command)) {
    return handleToVidOrImg(ctx);
  }
  if (['toaud', 'tomp3'].includes(command)) {
    return handleToAud(ctx);
  }
}

export const __test = {
  pendingPairings,
  classifyMedia,
  parseStickerText,
  runStickers,
};

export default {
  command: [
    's',
    'sticker',
    'saudio',
    'sa',
    'wm',
    'take',
    'robar',
    'tovid',
    'tomp4',
    'toimg',
    'toaud',
    'tomp3',
  ],
  category: 'stickers',
  description:
    'Crea stickers estáticos, animados y con audio nativo de WhatsApp (`s, `saudio, `wm, `tovid, `toaud).',
  run: runStickers,
};
