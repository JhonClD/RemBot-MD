import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
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

const require = createRequire(import.meta.url);

function resolveBinary(envVar, defaultCmd, staticPkg) {
  if (process.env[envVar]) return process.env[envVar];
  const probe = spawnSync(defaultCmd, ['-version'], { stdio: 'ignore' });
  if (!probe.error && probe.status === 0) return defaultCmd;
  if (staticPkg) {
    try {
      const staticBin = require(staticPkg);
      if (typeof staticBin === 'string' && staticBin) return staticBin;
    } catch {}
  }
  return defaultCmd;
}

const FFMPEG_BIN = resolveBinary('FFMPEG_PATH', 'ffmpeg', 'ffmpeg-static');
const FFPROBE_BIN = resolveBinary('FFPROBE_PATH', 'ffprobe', null);

function detectLibwebpAnim() {
  try {
    const res = spawnSync(FFMPEG_BIN, ['-hide_banner', '-encoders'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    return /\blibwebp_anim\b/.test(res.stdout || '') ? 'libwebp_anim' : 'libwebp';
  } catch {
    return 'libwebp';
  }
}

const ANIM_WEBP_CODEC = detectLibwebpAnim();

export const MAX_ANIMATED_WEBP_BYTES = 1020 * 1024;
export const MAX_STATIC_WEBP_BYTES = 1020 * 1024;
export const MAX_AUDIO_BYTES = 1024 * 1024;
export const MAX_VIDEO_SECONDS = 60;
export const MAX_STATIC_AUDIO_SECONDS = 60;
export const MAX_ANIMATED_AUDIO_SECONDS = 60;
export const STICKER_AUDIO_MIMETYPE = 'audio/ogg; codecs=opus';
export const FFMPEG_TIMEOUT_MS = 180_000;
export const SCALE_FLAGS = 'lanczos+accurate_rnd+full_chroma_int+full_chroma_inp';

export const ANIMATED_QUALITY_LADDER = [
  { size: 512, fps: 24, q: 80, sharpen: 0.32, denoise: false, weight: 1.15 },
  { size: 512, fps: 20, q: 76, sharpen: 0.34, denoise: false, weight: 0.90 },
  { size: 512, fps: 15, q: 72, sharpen: 0.35, denoise: false, weight: 0.65 },
  { size: 448, fps: 15, q: 66, sharpen: 0.36, denoise: false, weight: 0.48 },
  { size: 384, fps: 15, q: 60, sharpen: 0.36, denoise: true, weight: 0.35 },
  { size: 384, fps: 15, q: 50, sharpen: 0.38, denoise: true, weight: 0.27 },
  { size: 352, fps: 15, q: 44, sharpen: 0.38, denoise: true, weight: 0.21 },
  { size: 320, fps: 15, q: 40, sharpen: 0.40, denoise: true, weight: 0.165 },
  { size: 288, fps: 12, q: 36, sharpen: 0.40, denoise: true, weight: 0.12 },
  { size: 256, fps: 12, q: 32, sharpen: 0.40, denoise: true, weight: 0.09 },
  { size: 240, fps: 12, q: 28, sharpen: 0.40, denoise: true, weight: 0.07 },
  { size: 224, fps: 10, q: 24, sharpen: 0.40, denoise: true, weight: 0.05 },
];

export const support = {
  ffmpeg: true,
  ffprobe: true,
  ffmpegWebp: true,
};
global.support = { ...(global.support || {}), ...support };

const TMP_ROOT = path.resolve('lib', 'system', 'tmp');
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

function parseClockSeconds(str) {
  const m = String(str || '').match(/(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

function parseFfmpegSeconds(stderr) {
  const times = [...String(stderr || '').matchAll(/time=(\d+:\d+:\d+(?:\.\d+)?)/g)];
  if (times.length) {
    return parseClockSeconds(times[times.length - 1][1]);
  }
  const dur = String(stderr || '').match(/Duration:\s*(\d+:\d+:\d+(?:\.\d+)?)/);
  return dur ? parseClockSeconds(dur[1]) : 0;
}

function parseFraction(rate) {
  if (!rate || typeof rate !== 'string') return 0;
  if (rate.includes('/')) {
    const [num, den] = rate.split('/').map(Number);
    return den > 0 ? num / den : 0;
  }
  return Number(rate) || 0;
}

function runProcess(bin, args, { timeoutMs = FFMPEG_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
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
      finish(reject, new Error(`${bin} excedió el tiempo límite de ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);
    timer.unref?.();

    proc.stdout.on('data', (chunk) => {
      stdout = (stdout + chunk.toString('utf8')).slice(-32_000);
    });
    proc.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-24_000);
    });
    proc.once('error', (err) => finish(reject, err));
    proc.once('close', (code, signal) => {
      if (code === 0) return finish(resolve, { stdout, stderr });
      const err = new Error(
        `${bin} terminó con código ${code ?? signal}: ${stderr.trim().slice(-400) || 'sin detalle'}`,
      );
      err.stderr = stderr;
      if (NO_AUDIO_RE.test(stderr)) {
        err.code = 'NO_AUDIO_STREAM';
      }
      finish(reject, err);
    });
  });
}

function runFfmpeg(args, opts) {
  return runProcess(FFMPEG_BIN, ['-hide_banner', '-nostdin', ...args], opts);
}

export async function getMediaVideoMeta(filePath) {
  try {
    const { stdout } = await runProcess(
      FFPROBE_BIN,
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=r_frame_rate,avg_frame_rate,width,height:format=duration',
        '-of',
        'json',
        filePath,
      ],
      { timeoutMs: 15_000 },
    );
    const data = JSON.parse(stdout || '{}');
    const stream = data.streams?.[0] || {};
    const avg = parseFraction(stream.avg_frame_rate);
    const rfr = parseFraction(stream.r_frame_rate);
    const fps = avg > 1 && avg <= 120 ? avg : rfr > 1 && rfr <= 120 ? rfr : 0;
    const duration = Number(data.format?.duration) || 0;
    if (duration > 0 || fps > 0) {
      return {
        duration: duration > 0 ? duration : 0,
        fps: fps > 0 ? fps : 0,
        width: Number(stream.width) || 0,
        height: Number(stream.height) || 0,
      };
    }
  } catch {}

  try {
    await runFfmpeg(['-i', filePath], { timeoutMs: 10_000 });
  } catch (err) {
    const stderr = String(err?.stderr || '');
    const duration = parseFfmpegSeconds(stderr);
    const fpsMatch = stderr.match(/(\d+(?:\.\d+)?)\s*fps/i) || stderr.match(/(\d+(?:\.\d+)?)\s*tbr/i);
    const fps = fpsMatch ? Number(fpsMatch[1]) || 0 : 0;
    return { duration, fps, width: 0, height: 0 };
  }
  return { duration: 0, fps: 0, width: 0, height: 0 };
}

export function resolveSmoothFps(targetFps, sourceFps) {
  if (!Number.isFinite(sourceFps) || sourceFps <= 1) return targetFps;
  if (sourceFps <= targetFps + 0.5) return Math.max(6, Math.round(sourceFps));
  if (sourceFps >= 23.5 && sourceFps <= 24.5) return targetFps >= 18 ? 24 : 12;
  if (sourceFps >= 29 && sourceFps <= 31) {
    if (targetFps >= 24) return 30;
    if (targetFps >= 14) return 15;
    if (targetFps >= 12) return 12;
    return 10;
  }
  if (sourceFps >= 58 && sourceFps <= 62) {
    if (targetFps >= 18) return 20;
    if (targetFps >= 14) return 15;
    if (targetFps >= 12) return 12;
    return 10;
  }
  return targetFps;
}

export function buildVideoFilter({
  size = 512,
  fps = null,
  mode = 'default',
  pixelFormat = 'yuva420p',
  sharpen = 0.35,
  denoise = false,
} = {}) {
  const chain = [];
  if (fps && Number.isFinite(fps) && fps > 0) {
    chain.push(`fps=${fps}`);
  }
  if (denoise) {
    chain.push('hqdn3d=1.2:0.9:2.5:1.8');
  }
  const s = Number(sharpen || 0).toFixed(2);
  const hasSharpen = Number(sharpen) > 0;

  if (mode === 'crop') {
    chain.push(`scale=${size}:${size}:force_original_aspect_ratio=increase:flags=${SCALE_FLAGS}`);
    chain.push(`crop=${size}:${size}`);
    if (pixelFormat === 'bgra') {
      if (hasSharpen) {
        chain.push(`format=yuva444p,unsharp=3:3:${s}:3:3:0.0,scale=iw:ih:flags=${SCALE_FLAGS}`);
      }
      chain.push('format=bgra');
    } else {
      chain.push('format=yuva420p');
      if (hasSharpen) chain.push(`unsharp=3:3:${s}:3:3:0.0`);
    }
    return chain.join(',');
  }

  if (mode === 'circle') {
    chain.push(`scale=${size}:${size}:force_original_aspect_ratio=increase:flags=${SCALE_FLAGS}`);
    chain.push(`crop=${size}:${size}`);
    if (hasSharpen) {
      if (pixelFormat === 'bgra') {
        chain.push(`format=yuva444p,unsharp=3:3:${s}:3:3:0.0,scale=iw:ih:flags=${SCALE_FLAGS}`);
      } else {
        chain.push(`format=yuva420p,unsharp=3:3:${s}:3:3:0.0`);
      }
    }
    chain.push('format=rgba');
    chain.push(
      "geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*clip(min(W,H)/2-hypot(X-W/2,Y-H/2),0,1)'",
    );
    chain.push(`format=${pixelFormat}`);
    return chain.join(',');
  }

  // mode === 'default': contain con padding transparente
  if (pixelFormat === 'bgra') {
    chain.push(`scale=${size}:${size}:force_original_aspect_ratio=decrease:flags=${SCALE_FLAGS}`);
    if (hasSharpen) {
      chain.push(`format=yuva444p,unsharp=3:3:${s}:3:3:0.0,scale=iw:ih:flags=${SCALE_FLAGS}`);
    }
    chain.push('format=bgra');
    chain.push(`pad=${size}:${size}:(ow-iw)/2:(oh-ih)/2:color=#00000000`);
  } else {
    chain.push(
      `scale=${size}:${size}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=${SCALE_FLAGS}`,
    );
    chain.push('format=yuva420p');
    if (hasSharpen) {
      chain.push(`unsharp=3:3:${s}:3:3:0.0`);
    }
    chain.push(
      `pad=${size}:${size}:trunc((ow-iw)/4)*2:trunc((oh-ih)/4)*2:color=black@0`,
    );
  }
  return chain.join(',');
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

export function buildMetadata(packname, author, categories) {
  const defaultBot = global.packname || global.dev || 'RemBot-MD';
  return {
    packId: 'https://github.com/JhonClD/RemBot-MD',
    packname: packname !== undefined ? String(packname) : defaultBot,
    author: author !== undefined ? String(author) : defaultBot,
    categories: Array.isArray(categories) && categories.length ? categories : [''],
  };
}

function buildExifBuffer(metadata = {}) {
  const normalized = buildMetadata(metadata.packname, metadata.author, metadata.categories);
  const json = {
    'sticker-pack-id': metadata.packId || normalized.packId,
    'sticker-pack-name': normalized.packname,
    'sticker-pack-publisher': normalized.author,
    emojis: normalized.categories,
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
  const hasMeta =
    metadata.packname !== undefined ||
    metadata.author !== undefined ||
    (Array.isArray(metadata.categories) && metadata.categories.length > 0);
  if (!hasMeta) return webpBuffer;
  const img = new webp.Image();
  await img.load(webpBuffer);
  img.exif = buildExifBuffer(metadata);
  return await img.save(null);
}

export async function addExif(webpBuffer, packname, author, categories = [''], extra = {}) {
  return addStickerExif(webpBuffer, { packname, author, categories, ...extra });
}

async function demuxAnimatedWebpToConcat(webpBuffer, dir) {
  const img = new webp.Image();
  await img.load(webpBuffer);
  const frameBuffers = await img.demux({ buffers: true });
  if (!frameBuffers?.length) {
    throw new Error('No se pudieron extraer los fotogramas del sticker animado.');
  }
  const lines = [];
  let totalSec = 0;
  let lastEscaped = '';
  for (let i = 0; i < frameBuffers.length; i++) {
    const fPath = path.join(dir, `f_${String(i).padStart(4, '0')}.webp`);
    await fs.promises.writeFile(fPath, frameBuffers[i]);
    const delaySec = Math.max(0.02, (img.anim?.frames?.[i]?.delay || 80) / 1000);
    totalSec += delaySec;
    const escaped = fPath.replace(/'/g, "'\\''");
    lines.push(`file '${escaped}'`);
    lines.push(`duration ${delaySec.toFixed(4)}`);
    lastEscaped = escaped;
  }
  if (lastEscaped) {
    lines.push(`file '${lastEscaped}'`);
  }
  const listPath = path.join(dir, 'list.txt');
  await fs.promises.writeFile(listPath, lines.join('\n') + '\n', 'utf8');
  const avgFps = totalSec > 0 ? frameBuffers.length / totalSec : 15;
  return {
    listPath,
    duration: totalSec,
    fps: avgFps,
    width: img.width || 512,
    height: img.height || 512,
  };
}

export async function imageToWebp(media, { mode = 'default' } = {}) {
  if (
    mode === 'default' &&
    isWebpBuffer(media) &&
    !(await isAnimatedWebp(media)) &&
    media.length <= MAX_STATIC_WEBP_BYTES
  ) {
    return media;
  }
  return withTempDir(async (dir) => {
    const inPath = path.join(dir, 'in.img');
    await fs.promises.writeFile(inPath, media);

    // Intento 1: VP8L Lossless RGB 4:4:4 en 512x512
    const losslessOut = path.join(dir, 'out_lossless.webp');
    const losslessVf = buildVideoFilter({
      size: 512,
      mode,
      pixelFormat: 'bgra',
      sharpen: 0.3,
    });
    await runFfmpeg([
      '-y',
      '-i',
      inPath,
      '-frames:v',
      '1',
      '-vf',
      losslessVf,
      '-c:v',
      'libwebp',
      '-lossless',
      '1',
      '-compression_level',
      '6',
      '-quality',
      '100',
      losslessOut,
    ]);
    const losslessBuf = await fs.promises.readFile(losslessOut);
    if (losslessBuf.length <= MAX_STATIC_WEBP_BYTES) {
      return losslessBuf;
    }

    // Respaldos para fotografías complejas manteniendo siempre 512x512
    const lossyVf = buildVideoFilter({
      size: 512,
      mode,
      pixelFormat: 'yuva420p',
      sharpen: 0.3,
    });
    let lastBuf = losslessBuf;
    for (const q of [95, 86, 76, 64]) {
      const qOut = path.join(dir, `out_q${q}.webp`);
      await runFfmpeg([
        '-y',
        '-i',
        inPath,
        '-frames:v',
        '1',
        '-vf',
        lossyVf,
        '-c:v',
        'libwebp',
        '-lossless',
        '0',
        '-preset',
        'picture',
        '-compression_level',
        '6',
        '-quality',
        String(q),
        qOut,
      ]);
      lastBuf = await fs.promises.readFile(qOut);
      if (lastBuf.length <= MAX_STATIC_WEBP_BYTES) {
        return lastBuf;
      }
    }
    return lastBuf;
  });
}

function selectInitialLadderIndex(seconds) {
  if (seconds <= 4) return 0;
  if (seconds <= 8) return 1;
  if (seconds <= 14) return 2;
  if (seconds <= 22) return 3;
  if (seconds <= 35) return 5;
  return 6;
}

export async function videoToWebp(
  media,
  { maxSeconds = MAX_VIDEO_SECONDS, mode = 'default' } = {},
) {
  const inputIsAnimWebp = isWebpBuffer(media) && (await isAnimatedWebp(media));
  if (inputIsAnimWebp && mode === 'default' && media.length <= MAX_ANIMATED_WEBP_BYTES) {
    return media;
  }

  return withTempDir(async (dir) => {
    let inputArgs;
    let sourceDuration = 0;
    let sourceFps = 0;

    if (inputIsAnimWebp) {
      const demuxed = await demuxAnimatedWebpToConcat(media, dir);
      inputArgs = ['-f', 'concat', '-safe', '0', '-i', demuxed.listPath];
      sourceDuration = demuxed.duration;
      sourceFps = demuxed.fps;
    } else {
      const inPath = path.join(dir, 'in.vid');
      await fs.promises.writeFile(inPath, media);
      const meta = await getMediaVideoMeta(inPath);
      inputArgs = ['-i', inPath];
      sourceDuration = meta.duration;
      sourceFps = meta.fps;
    }

    const clipDur = Math.min(
      maxSeconds,
      sourceDuration > 0 ? sourceDuration : maxSeconds,
    );
    let idx = selectInitialLadderIndex(clipDur);
    let lastBuffer = null;

    while (idx < ANIMATED_QUALITY_LADDER.length) {
      const preset = ANIMATED_QUALITY_LADDER[idx];
      const smoothFps = resolveSmoothFps(preset.fps, sourceFps);
      const vf = buildVideoFilter({
        size: preset.size,
        fps: smoothFps,
        mode,
        pixelFormat: 'yuva420p',
        sharpen: preset.sharpen,
        denoise: preset.denoise,
      });
      const outPath = path.join(dir, `anim_${idx}.webp`);
      await runFfmpeg([
        '-y',
        '-t',
        String(Math.min(maxSeconds, MAX_VIDEO_SECONDS)),
        ...inputArgs,
        '-an',
        '-vf',
        vf,
        '-c:v',
        ANIM_WEBP_CODEC,
        '-loop',
        '0',
        '-preset',
        'picture',
        '-compression_level',
        '4',
        '-quality',
        String(preset.q),
        '-vsync',
        '0',
        outPath,
      ]);
      lastBuffer = await fs.promises.readFile(outPath);
      if (lastBuffer.length <= MAX_ANIMATED_WEBP_BYTES) {
        return lastBuffer;
      }

      if (idx === ANIMATED_QUALITY_LADDER.length - 1) {
        break;
      }

      const overshoot = lastBuffer.length / MAX_ANIMATED_WEBP_BYTES;
      const targetWeight = preset.weight / (overshoot * 1.06);
      let nextIdx = idx + 1;
      while (
        nextIdx < ANIMATED_QUALITY_LADDER.length - 1 &&
        ANIMATED_QUALITY_LADDER[nextIdx].weight > targetWeight
      ) {
        nextIdx++;
      }
      idx = nextIdx;
    }

    if (lastBuffer && lastBuffer.length > MAX_ANIMATED_WEBP_BYTES) {
      const emergencyVf = buildVideoFilter({
        size: 192,
        fps: resolveSmoothFps(10, sourceFps),
        mode,
        pixelFormat: 'yuva420p',
        sharpen: 0.4,
        denoise: true,
      });
      const emergencyOut = path.join(dir, 'anim_emergency.webp');
      await runFfmpeg([
        '-y',
        '-t',
        String(Math.min(maxSeconds, MAX_VIDEO_SECONDS)),
        ...inputArgs,
        '-an',
        '-vf',
        emergencyVf,
        '-c:v',
        ANIM_WEBP_CODEC,
        '-loop',
        '0',
        '-preset',
        'picture',
        '-compression_level',
        '4',
        '-quality',
        '18',
        '-vsync',
        '0',
        emergencyOut,
      ]);
      lastBuffer = await fs.promises.readFile(emergencyOut);
    }

    return lastBuffer;
  });
}

export async function createSticker(
  buffer,
  {
    isVideo = false,
    isAnimated: forceAnimated,
    mimetype = '',
    mode = 'default',
    packname,
    author,
    categories,
    maxSeconds = MAX_VIDEO_SECONDS,
  } = {},
) {
  let webpBuf;
  let isAnimated = false;
  const wantVideo =
    forceAnimated === true || isVideo || /^video\/|image\/gif/i.test(mimetype);

  if (isWebpBuffer(buffer)) {
    const inputAnim = await isAnimatedWebp(buffer);
    if (inputAnim) {
      webpBuf = await videoToWebp(buffer, { maxSeconds, mode });
      isAnimated = true;
    } else {
      webpBuf = await imageToWebp(buffer, { mode });
      isAnimated = false;
    }
  } else if (wantVideo) {
    webpBuf = await videoToWebp(buffer, { maxSeconds, mode });
    isAnimated = await isAnimatedWebp(webpBuf);
  } else {
    webpBuf = await imageToWebp(buffer, { mode });
    isAnimated = false;
  }

  if (
    packname !== undefined ||
    author !== undefined ||
    (Array.isArray(categories) && categories.length > 0)
  ) {
    webpBuf = await addStickerExif(webpBuf, { packname, author, categories });
  }
  return { buffer: webpBuf, isAnimated };
}

export async function prepareStickerAudio(
  buffer,
  { maxSeconds = MAX_ANIMATED_AUDIO_SECONDS } = {},
) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    const err = new Error('Buffer de audio vacío');
    err.code = 'NO_AUDIO_STREAM';
    throw err;
  }
  const cappedMax = Math.min(MAX_ANIMATED_AUDIO_SECONDS, Math.max(1, Number(maxSeconds) || 60));
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
        String(cappedMax),
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
      const seconds = Math.max(1, Math.min(cappedMax, Math.round(rawSec || 1)));
      return { buffer: outBuf, seconds, mimetype: STICKER_AUDIO_MIMETYPE };
    };

    let result = await encodeAtBitrate('48k', '48k');
    if (result.buffer.length >= MAX_AUDIO_BYTES) {
      result = await encodeAtBitrate('32k', '32k');
    }
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

  const existingAudio =
    audioSource?.audioMessage ||
    (audioSource?.mediaKey && (audioSource?.directPath || audioSource?.url) ? audioSource : null);

  let stickerMedia;
  let audioMsg;

  if (existingAudio) {
    stickerMedia = await prepareWAMessageMedia(
      { sticker: webpBuffer, isAnimated: animated, mimetype: 'image/webp' },
      { upload: conn.waUploadToServer },
    );
    audioMsg = proto.Message.AudioMessage.fromObject({
      ...existingAudio,
      ptt: false,
      mimetype: STICKER_AUDIO_MIMETYPE,
    });
  } else {
    let prepared = audioSource;
    if (Buffer.isBuffer(audioSource)) {
      const isOgg =
        audioSource.length >= 4 &&
        audioSource.subarray(0, 4).toString('ascii') === 'OggS' &&
        audioSource.length < MAX_AUDIO_BYTES;
      prepared = isOgg
        ? { buffer: audioSource, seconds: 1, mimetype: STICKER_AUDIO_MIMETYPE }
        : await prepareStickerAudio(audioSource, {
            maxSeconds: animated ? MAX_ANIMATED_AUDIO_SECONDS : MAX_STATIC_AUDIO_SECONDS,
          });
    } else if (!Buffer.isBuffer(prepared?.buffer)) {
      throw new Error('Fuente de audio inválida para sendAudioSticker');
    }

    const [uploadedSticker, uploadedAudio] = await Promise.all([
      prepareWAMessageMedia(
        { sticker: webpBuffer, isAnimated: animated, mimetype: 'image/webp' },
        { upload: conn.waUploadToServer },
      ),
      prepareWAMessageMedia(
        {
          audio: prepared.buffer,
          mimetype: STICKER_AUDIO_MIMETYPE,
          ptt: false,
          seconds: Math.max(
            1,
            Math.min(MAX_ANIMATED_AUDIO_SECONDS, Math.round(prepared.seconds || 1)),
          ),
        },
        { upload: conn.waUploadToServer },
      ),
    ]);
    stickerMedia = uploadedSticker;
    audioMsg = proto.Message.AudioMessage.fromObject({
      ...uploadedAudio.audioMessage,
      ptt: false,
      mimetype: STICKER_AUDIO_MIMETYPE,
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
    {
      stickerMessage,
      messageContextInfo: {
        messageSecret: crypto.randomBytes(32),
      },
    },
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
  if (waMsg.message && !waMsg.message.messageContextInfo?.messageSecret) {
    waMsg.message.messageContextInfo = {
      ...(waMsg.message.messageContextInfo || {}),
      messageSecret: crypto.randomBytes(32),
    };
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
        `scale='min(512,iw)':'min(512,ih)':force_original_aspect_ratio=decrease:flags=${SCALE_FLAGS},pad=ceil(iw/2)*2:ceil(ih/2)*2:(ow-iw)/2:(oh-ih)/2:color=black,format=yuv420p`;
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
          '18',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          '-b:a',
          '128k',
          '-shortest',
          '-t',
          '65',
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
          '18',
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

    const demuxed = await demuxAnimatedWebpToConcat(webpBuffer, dir);
    const w = Math.max(2, Math.min(512, Math.ceil((demuxed.width || 512) / 2) * 2));
    const h = Math.max(2, Math.min(512, Math.ceil((demuxed.height || 512) / 2) * 2));
    const animVf = `scale='min(${w},iw)':'min(${h},ih)':force_original_aspect_ratio=decrease:flags=${SCALE_FLAGS},pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,format=yuv420p`;

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
        demuxed.listPath,
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
        '18',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-shortest',
        '-t',
        '65',
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
        demuxed.listPath,
        '-vf',
        animVf,
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '18',
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

// Wrappers de compatibilidad con otros plugins estilo Baileys (qc, brat, attp, emojimix)
async function resolveInputBuffer(img, url) {
  if (Buffer.isBuffer(img)) return img;
  const target = url || img;
  if (typeof target === 'string' && /^https?:\/\//i.test(target)) {
    const res = await fetch(target);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  if (typeof target === 'string' && fs.existsSync(target)) {
    return await fs.promises.readFile(target);
  }
  throw new Error('Entrada multimedia inválida para sticker');
}

function sniffLooksAnimated(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return false;
  const head6 = buf.subarray(0, 6).toString('ascii');
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return true;
  if (buf.subarray(4, 8).toString('ascii') === 'ftyp') return true;
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return true;
  return false;
}

export async function sticker(img, url, packname, author, categories = ['']) {
  const buf = await resolveInputBuffer(img, url);
  const { buffer } = await createSticker(buf, {
    isVideo: sniffLooksAnimated(buf),
    packname,
    author,
    categories,
  });
  return buffer;
}
export const sticker4 = sticker;
export const sticker5 = sticker;
export const sticker6 = sticker;

export default {
  imageToWebp,
  videoToWebp,
  writeExifImg,
  writeExifVid,
  writeExif,
  addStickerExif,
  addExif,
  sticker,
  sticker4,
  sticker5,
  sticker6,
  support,
  isWebpBuffer,
  isAnimatedWebp,
  buildMetadata,
  getMediaVideoMeta,
  resolveSmoothFps,
  buildVideoFilter,
  createSticker,
  prepareStickerAudio,
  sendAudioSticker,
  downloadStickerAudio,
  stickerToMedia,
  extractAudioToMp3,
};