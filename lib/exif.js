import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import webp from 'node-webpmux';
import {
  proto,
  prepareWAMessageMedia,
  generateWAMessageFromContent,
  downloadContentFromMessage,
  normalizeMessageContent,
  getContentType,
} from 'baileys';
import {
  ensureAudioStickerProto,
  extractNormalizedContent,
  wrapOutgoingAudioSticker,
} from './serialize.js';

const FFMPEG_BIN = process.env.FFMPEG_PATH || 'ffmpeg';
const MAX_STICKER_BYTES = 500 * 1024;
const MAX_AUDIO_BYTES = 1024 * 1024;
const TMP_ROOT = path.resolve('lib', 'system', 'tmp');

const ANIMATED_PRESETS = [
  { size: 320, fps: 15, q: 55, dur: 10 },
  { size: 320, fps: 12, q: 45, dur: 10 },
  { size: 256, fps: 10, q: 38, dur: 10 },
  { size: 224, fps: 8, q: 30, dur: 10 },
  { size: 192, fps: 7, q: 22, dur: 10 },
];

const NO_AUDIO_RE =
  /does not contain any stream|matches no streams|output file is empty|audio:\s*0kB/i;

function ensureTmpRoot() {
  if (!fs.existsSync(TMP_ROOT)) {
    fs.mkdirSync(TMP_ROOT, { recursive: true });
  }
  return TMP_ROOT;
}

async function withTempDir(fn) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'rembot-stk-'));
  try {
    return await fn(dir);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function parseFfmpegSeconds(stderr) {
  const times = [...String(stderr || '').matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
  if (times.length) {
    const last = times[times.length - 1];
    return Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]);
  }
  const dur = String(stderr || '').match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (dur) {
    return Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]);
  }
  return 0;
}

function runFfmpeg(args, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_BIN, ['-hide_banner', '-nostdin', ...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    let settled = false;
    const finish = (cb, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cb(val);
    };
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      finish(reject, new Error('FFmpeg excedió el tiempo límite procesando el sticker.'));
    }, timeoutMs);
    timer.unref?.();

    proc.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-16_000);
    });
    proc.once('error', (err) => finish(reject, err));
    proc.once('close', (code, signal) => {
      if (code === 0) return finish(resolve, { stderr });
      const err = new Error(
        `FFmpeg terminó con código ${code ?? signal}: ${stderr.trim().slice(-400) || 'sin detalle'}`,
      );
      err.stderr = stderr;
      if (NO_AUDIO_RE.test(stderr)) {
        err.code = 'NO_AUDIO_STREAM';
      }
      finish(reject, err);
    });
  });
}

export function isWebpBuffer(buf) {
  return (
    Buffer.isBuffer(buf) &&
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  );
}

export async function isAnimatedWebp(buf) {
  if (!isWebpBuffer(buf)) return false;
  try {
    const img = new webp.Image();
    await img.load(buf);
    return !!img.hasAnim;
  } catch {
    return buf.includes(Buffer.from('ANIM'));
  }
}

function buildExifBuffer(metadata = {}) {
  const json = {
    'sticker-pack-id': metadata.packId || 'https://github.com/JhonClD/RemBot-MD',
    'sticker-pack-name': metadata.packname ?? '',
    'sticker-pack-publisher': metadata.author ?? '',
    emojis: Array.isArray(metadata.categories) && metadata.categories.length ? metadata.categories : [''],
  };
  const exifAttr = Buffer.from([
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00,
  ]);
  const jsonBuff = Buffer.from(JSON.stringify(json), 'utf8');
  const exif = Buffer.concat([exifAttr, jsonBuff]);
  exif.writeUIntLE(jsonBuff.length, 14, 4);
  return exif;
}

export async function addStickerExif(webpBuffer, metadata = {}) {
  if (!Buffer.isBuffer(webpBuffer) || !webpBuffer.length) {
    throw new Error('Buffer WebP inválido');
  }
  const hasMeta = metadata.packname !== undefined || metadata.author !== undefined;
  if (!hasMeta) return webpBuffer;
  const img = new webp.Image();
  await img.load(webpBuffer);
  img.exif = buildExifBuffer(metadata);
  return await img.save(null);
}

export async function imageToWebp(media) {
  if (isWebpBuffer(media) && !(await isAnimatedWebp(media)) && media.length <= MAX_STICKER_BYTES) {
    return media;
  }
  return withTempDir(async (dir) => {
    const inPath = path.join(dir, 'in.img');
    const outPath = path.join(dir, 'out.webp');
    await fs.promises.writeFile(inPath, media);
    await runFfmpeg([
      '-y',
      '-i',
      inPath,
      '-an',
      '-vcodec',
      'libwebp',
      '-vf',
      'scale=512:512:force_original_aspect_ratio=decrease,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000',
      '-lossless',
      '0',
      '-q:v',
      '80',
      '-compression_level',
      '6',
      outPath,
    ]);
    return await fs.promises.readFile(outPath);
  });
}

export async function videoToWebp(media, { maxSeconds = 10 } = {}) {
  if (isWebpBuffer(media) && (await isAnimatedWebp(media)) && media.length <= MAX_STICKER_BYTES) {
    return media;
  }
  return withTempDir(async (dir) => {
    const inPath = path.join(dir, 'in.vid');
    await fs.promises.writeFile(inPath, media);
    let lastBuffer = null;
    for (let i = 0; i < ANIMATED_PRESETS.length; i++) {
      const { size, fps, q, dur } = ANIMATED_PRESETS[i];
      const clipDur = Math.min(dur, maxSeconds);
      const outPath = path.join(dir, `out_${i}.webp`);
      await runFfmpeg([
        '-y',
        '-t',
        String(clipDur),
        '-i',
        inPath,
        '-an',
        '-vcodec',
        'libwebp',
        '-vf',
        `scale=${size}:${size}:force_original_aspect_ratio=decrease,fps=${fps},format=rgba,pad=${size}:${size}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`,
        '-loop',
        '0',
        '-preset',
        'default',
        '-q:v',
        String(q),
        '-compression_level',
        '6',
        '-vsync',
        '0',
        outPath,
      ]);
      lastBuffer = await fs.promises.readFile(outPath);
      if (lastBuffer.length <= MAX_STICKER_BYTES) {
        return lastBuffer;
      }
    }
    return lastBuffer;
  });
}

export async function createSticker(
  buffer,
  { isVideo = false, mimetype = '', packname, author, categories } = {},
) {
  let webpBuf;
  let isAnimated = false;
  if (isWebpBuffer(buffer)) {
    isAnimated = await isAnimatedWebp(buffer);
    if (buffer.length <= MAX_STICKER_BYTES) {
      webpBuf = buffer;
    } else {
      webpBuf = isAnimated ? await videoToWebp(buffer) : await imageToWebp(buffer);
    }
  } else if (isVideo || /^video\/|image\/gif/i.test(mimetype)) {
    webpBuf = await videoToWebp(buffer, { maxSeconds: 10 });
    isAnimated = await isAnimatedWebp(webpBuf);
  } else {
    webpBuf = await imageToWebp(buffer);
    isAnimated = false;
  }

  if (packname !== undefined || author !== undefined) {
    webpBuf = await addStickerExif(webpBuf, { packname, author, categories });
  }
  return { buffer: webpBuf, isAnimated };
}

export async function prepareStickerAudio(buffer, { maxSeconds = 10 } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    const err = new Error('Buffer de audio vacío');
    err.code = 'NO_AUDIO_STREAM';
    throw err;
  }
  return withTempDir(async (dir) => {
    const inPath = path.join(dir, 'in.media');
    await fs.promises.writeFile(inPath, buffer);

    const encodeAtBitrate = async (bitrate, tag) => {
      const outPath = path.join(dir, `out_${tag}.ogg`);
      const { stderr } = await runFfmpeg([
        '-y',
        '-i',
        inPath,
        '-vn',
        '-t',
        String(maxSeconds),
        '-f',
        'ogg',
        '-c:a',
        'libopus',
        '-b:a',
        bitrate,
        '-vbr',
        'on',
        '-ar',
        '48000',
        '-ac',
        '1',
        '-compression_level',
        '10',
        '-application',
        'audio',
        outPath,
      ]);
      const outBuf = await fs.promises.readFile(outPath);
      if (outBuf.length < 4 || outBuf.subarray(0, 4).toString('ascii') !== 'OggS') {
        const err = new Error('El audio generado no tiene contenedor OGG válido (OggS).');
        err.code = 'NO_AUDIO_STREAM';
        throw err;
      }
      const rawSec = parseFfmpegSeconds(stderr);
      const seconds = Math.max(1, Math.min(maxSeconds, Math.round(rawSec || 1)));
      return { buffer: outBuf, seconds, mimetype: 'audio/ogg; codecs=opus' };
    };

    let result = await encodeAtBitrate('48k', '48k');
    if (result.buffer.length >= MAX_AUDIO_BYTES) {
      result = await encodeAtBitrate('24k', '24k');
    }
    if (result.buffer.length >= MAX_AUDIO_BYTES) {
      throw new Error('El audio del sticker supera el límite de 1 MB de WhatsApp.');
    }
    return result;
  });
}

function sanitizeQuotedMessage(quoted) {
  if (!quoted?.key?.id || !quoted?.message) return undefined;
  const norm = extractNormalizedContent(quoted.message);
  const direct = normalizeMessageContent(quoted.message);
  if (norm && norm !== direct) {
    const contentType = getContentType(norm);
    if (contentType && norm[contentType]) {
      return {
        ...quoted,
        message: proto.Message.create({ [contentType]: norm[contentType] }),
      };
    }
  }
  return quoted;
}

export async function sendAudioSticker(
  conn,
  jid,
  webpBuffer,
  audioSource,
  { quoted, isAnimated, ephemeralExpiration } = {},
) {
  ensureAudioStickerProto(proto);
  const animated =
    typeof isAnimated === 'boolean' ? isAnimated : await isAnimatedWebp(webpBuffer);

  const stickerMedia = await prepareWAMessageMedia(
    { sticker: webpBuffer, isAnimated: animated, mimetype: 'image/webp' },
    { upload: conn.waUploadToServer },
  );

  let audioMsg = null;
  const existingAudio =
    audioSource?.audioMessage ||
    (audioSource?.mediaKey && (audioSource?.directPath || audioSource?.url) ? audioSource : null);

  if (existingAudio) {
    audioMsg = proto.Message.AudioMessage.fromObject({
      ...existingAudio,
      ptt: false,
      mimetype: 'audio/ogg; codecs=opus',
    });
  } else {
    let prepared = audioSource;
    if (Buffer.isBuffer(audioSource)) {
      const isOgg =
        audioSource.length >= 4 &&
        audioSource.subarray(0, 4).toString('ascii') === 'OggS' &&
        audioSource.length < MAX_AUDIO_BYTES;
      prepared = isOgg
        ? { buffer: audioSource, seconds: 1, mimetype: 'audio/ogg; codecs=opus' }
        : await prepareStickerAudio(audioSource, { maxSeconds: 10 });
    } else if (!Buffer.isBuffer(prepared?.buffer)) {
      throw new Error('Fuente de audio inválida para sendAudioSticker');
    }
    const audioMedia = await prepareWAMessageMedia(
      {
        audio: prepared.buffer,
        mimetype: 'audio/ogg; codecs=opus',
        ptt: false,
        seconds: Math.max(1, Math.min(10, Math.round(prepared.seconds || 1))),
      },
      { upload: conn.waUploadToServer },
    );
    audioMsg = proto.Message.AudioMessage.fromObject({
      ...audioMedia.audioMessage,
      ptt: false,
      mimetype: 'audio/ogg; codecs=opus',
    });
  }

  const stickerMessage = proto.Message.StickerMessage.fromObject({
    ...stickerMedia.stickerMessage,
    isAnimated: animated,
    audioMessage: audioMsg,
    contextInfo: {
      ...(stickerMedia.stickerMessage?.contextInfo || {}),
      experienceIds: [13007],
    },
  });

  const validQuoted = sanitizeQuotedMessage(quoted);
  const waMsg = generateWAMessageFromContent(
    jid,
    { stickerMessage },
    {
      userJid: conn.user?.id,
      quoted: validQuoted,
      ephemeralExpiration: ephemeralExpiration || quoted?.expiration || undefined,
    },
  );

  if (waMsg.message?.stickerMessage) {
    waMsg.message.stickerMessage.audioMessage = audioMsg;
    waMsg.message.stickerMessage.contextInfo = proto.ContextInfo.fromObject({
      ...(waMsg.message.stickerMessage.contextInfo || {}),
      experienceIds: [13007],
    });
  }

  await conn.relayMessage(jid, waMsg.message, { messageId: waMsg.key.id });

  const storedWaMsg = proto.WebMessageInfo.fromObject({
    key: waMsg.key,
    message: wrapOutgoingAudioSticker(waMsg.message),
    messageTimestamp: waMsg.messageTimestamp,
    ...(waMsg.participant ? { participant: waMsg.participant } : {}),
  });
  conn.ev?.emit?.('messages.upsert', { messages: [storedWaMsg], type: 'append' });
  return storedWaMsg;
}

export async function downloadStickerAudio(target) {
  if (!target) return null;
  const audioMsg =
    target?.content?.audioMessage ||
    target?.msg?.audioMessage ||
    target?.audioMessage ||
    extractNormalizedContent(target?.message)?.stickerMessage?.audioMessage ||
    null;
  if (!audioMsg || !audioMsg.mediaKey || (!audioMsg.directPath && !audioMsg.url)) {
    return null;
  }
  const stream = await downloadContentFromMessage(audioMsg, 'audio');
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export async function stickerToMedia(
  webpBuffer,
  { audioBuffer = null, toImageOnly = false } = {},
) {
  if (!Buffer.isBuffer(webpBuffer) || !webpBuffer.length) {
    throw new Error('Buffer de sticker vacío');
  }
  return withTempDir(async (dir) => {
    const img = new webp.Image();
    await img.load(webpBuffer);
    const isAnim = !!img.hasAnim;

    if (toImageOnly) {
      const frameBuf = isAnim
        ? (await img.demux({ buffers: true, frame: 0 }))[0]
        : webpBuffer;
      const inWebp = path.join(dir, 'frame.webp');
      const outPng = path.join(dir, 'out.png');
      await fs.promises.writeFile(inWebp, frameBuf);
      await runFfmpeg(['-y', '-i', inWebp, outPng]);
      const pngBuf = await fs.promises.readFile(outPng);
      return { buffer: pngBuf, mimetype: 'image/png', type: 'image', hasAudio: false };
    }

    const hasAudio = Buffer.isBuffer(audioBuffer) && audioBuffer.length > 0;
    const audioPath = path.join(dir, 'audio.ogg');
    if (hasAudio) {
      await fs.promises.writeFile(audioPath, audioBuffer);
    }
    const outMp4 = path.join(dir, 'out.mp4');

    if (!isAnim) {
      const inWebp = path.join(dir, 'static.webp');
      await fs.promises.writeFile(inWebp, webpBuffer);
      const vf =
        "scale='min(512,iw)':'min(512,ih)':force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2:(ow-iw)/2:(oh-ih)/2:color=black,format=yuv420p";
      if (hasAudio) {
        await runFfmpeg([
          '-y',
          '-loop',
          '1',
          '-framerate',
          '15',
          '-i',
          inWebp,
          '-i',
          audioPath,
          '-map',
          '0:v:0',
          '-map',
          '1:a:0',
          '-vf',
          vf,
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '24',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          '-b:a',
          '128k',
          '-shortest',
          '-t',
          '15',
          '-movflags',
          '+faststart',
          outMp4,
        ]);
      } else {
        await runFfmpeg([
          '-y',
          '-loop',
          '1',
          '-framerate',
          '15',
          '-t',
          '3',
          '-i',
          inWebp,
          '-vf',
          vf,
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '24',
          '-pix_fmt',
          'yuv420p',
          '-an',
          '-movflags',
          '+faststart',
          outMp4,
        ]);
      }
      const mp4Buf = await fs.promises.readFile(outMp4);
      return { buffer: mp4Buf, mimetype: 'video/mp4', type: 'video', hasAudio };
    }

    const frameBuffers = await img.demux({ buffers: true });
    if (!frameBuffers?.length) {
      throw new Error('No se pudieron extraer los fotogramas del sticker animado.');
    }
    const concatLines = [];
    let lastFrameFile = '';
    for (let i = 0; i < frameBuffers.length; i++) {
      const fPath = path.join(dir, `f_${String(i).padStart(4, '0')}.webp`);
      await fs.promises.writeFile(fPath, frameBuffers[i]);
      const delaySec = Math.max(0.02, (img.anim?.frames?.[i]?.delay || 80) / 1000).toFixed(4);
      const escaped = fPath.replace(/'/g, "'\\''");
      concatLines.push(`file '${escaped}'`);
      concatLines.push(`duration ${delaySec}`);
      lastFrameFile = escaped;
    }
    if (lastFrameFile) {
      concatLines.push(`file '${lastFrameFile}'`);
    }
    const concatPath = path.join(dir, 'concat.txt');
    await fs.promises.writeFile(concatPath, concatLines.join('\n') + '\n', 'utf8');

    const w = Math.max(2, Math.min(512, Math.ceil((img.width || 320) / 2) * 2));
    const h = Math.max(2, Math.min(512, Math.ceil((img.height || 320) / 2) * 2));
    const animVf = `scale='min(${w},iw)':'min(${h},ih)':force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,format=yuv420p`;

    if (hasAudio) {
      await runFfmpeg([
        '-y',
        '-stream_loop',
        '-1',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        concatPath,
        '-i',
        audioPath,
        '-map',
        '0:v:0',
        '-map',
        '1:a:0',
        '-vf',
        animVf,
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '24',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-shortest',
        '-t',
        '15',
        '-movflags',
        '+faststart',
        outMp4,
      ]);
    } else {
      await runFfmpeg([
        '-y',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        concatPath,
        '-vf',
        animVf,
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '24',
        '-pix_fmt',
        'yuv420p',
        '-an',
        '-movflags',
        '+faststart',
        outMp4,
      ]);
    }

    const mp4Buf = await fs.promises.readFile(outMp4);
    return { buffer: mp4Buf, mimetype: 'video/mp4', type: 'video', hasAudio };
  });
}

export async function extractAudioToMp3(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    const err = new Error('Buffer de audio vacío');
    err.code = 'NO_AUDIO_STREAM';
    throw err;
  }
  return withTempDir(async (dir) => {
    const inPath = path.join(dir, 'in.media');
    const outPath = path.join(dir, 'out.mp3');
    await fs.promises.writeFile(inPath, buffer);
    await runFfmpeg([
      '-y',
      '-i',
      inPath,
      '-vn',
      '-c:a',
      'libmp3lame',
      '-b:a',
      '128k',
      '-ar',
      '44100',
      outPath,
    ]);
    const mp3Buf = await fs.promises.readFile(outPath);
    if (!mp3Buf.length) {
      const err = new Error('No se pudo extraer audio MP3.');
      err.code = 'NO_AUDIO_STREAM';
      throw err;
    }
    return { buffer: mp3Buf, mimetype: 'audio/mpeg' };
  });
}

async function writeTempWebpWithExif(webpBuf, metadata = {}) {
  const withExif = await addStickerExif(webpBuf, metadata);
  const outFile = path.join(
    ensureTmpRoot(),
    `${crypto.randomBytes(6).readUIntLE(0, 6).toString(36)}.webp`,
  );
  await fs.promises.writeFile(outFile, withExif);
  return outFile;
}

export async function writeExifImg(media, metadata = {}) {
  const wMedia = await imageToWebp(media);
  if (metadata.packname || metadata.author) {
    return writeTempWebpWithExif(wMedia, metadata);
  }
  const outFile = path.join(
    ensureTmpRoot(),
    `${crypto.randomBytes(6).readUIntLE(0, 6).toString(36)}.webp`,
  );
  await fs.promises.writeFile(outFile, wMedia);
  return outFile;
}

export async function writeExifVid(media, metadata = {}) {
  const wMedia = await videoToWebp(media);
  if (metadata.packname || metadata.author) {
    return writeTempWebpWithExif(wMedia, metadata);
  }
  const outFile = path.join(
    ensureTmpRoot(),
    `${crypto.randomBytes(6).readUIntLE(0, 6).toString(36)}.webp`,
  );
  await fs.promises.writeFile(outFile, wMedia);
  return outFile;
}

export async function writeExif(media, metadata = {}) {
  const wMedia = /webp/i.test(media.mimetype)
    ? media.data
    : /image/i.test(media.mimetype)
      ? await imageToWebp(media.data)
      : /video/i.test(media.mimetype)
        ? await videoToWebp(media.data)
        : Buffer.alloc(0);
  return writeTempWebpWithExif(wMedia, metadata);
}

export default {
  imageToWebp,
  videoToWebp,
  writeExifImg,
  writeExifVid,
  writeExif,
  addStickerExif,
  isWebpBuffer,
  isAnimatedWebp,
  createSticker,
  prepareStickerAudio,
  sendAudioSticker,
  downloadStickerAudio,
  stickerToMedia,
  extractAudioToMp3,
};