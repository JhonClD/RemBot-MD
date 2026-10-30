import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { createInterface } from 'node:readline';
import { downloadContentFromMessage } from 'baileys';
import ffmpegStatic from 'ffmpeg-static';

const FFMPEG_TIMEOUT_MS = 20 * 60 * 1000;
const PROGRESS_LOG_INTERVAL_MS = 1000;
const FFMPEG_BIN = ffmpegStatic || 'ffmpeg';
const activeChats = new Set();
const VIDEO_EXTENSIONS = /\.(mp4|m4v|mkv|mov|webm|avi|3gp)$/i;

function parseClock(value) {
  const match = String(value || '').match(/^(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) return 0;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function formatClock(value) {
  const seconds = Math.max(0, Number(value) || 0);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = (seconds % 60).toFixed(1).padStart(4, '0');
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${remainder}`;
}

function printProgress(jobId, progress) {
  const percentage = progress.finished
    ? 100
    : progress.durationSeconds > 0
      ? Math.min(99, Math.floor((progress.currentSeconds / progress.durationSeconds) * 100))
      : null;
  const percentText = percentage === null ? 'progreso' : `${percentage}%`;
  const totalText = progress.durationSeconds > 0 ? formatClock(progress.durationSeconds) : 'desconocido';
  const fpsText = progress.fps ? `${Math.round(progress.fps)} fps` : 'FPS n/d';
  const speedText = progress.speed || 'velocidad n/d';
  const stateText = progress.finished ? 'completado' : 'progreso';
  console.log(`[dw4 ${jobId}] ${stateText} ${percentText} | ${formatClock(progress.currentSeconds)}/${totalText} | frame ${progress.frame || 0} | ${fpsText} | ${speedText}`);
}

export function compressDw4(inputPath, outputPath, { timeoutMs = FFMPEG_TIMEOUT_MS, onProgress } = {}) {
  const filter = 'scale=-2:360:flags=lanczos,pad=ceil(iw/2)*2:ceil(ih/2)*2';
  const args = [
    '-hide_banner', '-nostdin', '-loglevel', 'info', '-nostats',
    '-progress', 'pipe:2', '-stats_period', '0.5',
    '-i', inputPath,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', filter,
    '-c:v', 'libx264', '-crf', '26', '-preset', 'medium',
    '-pix_fmt', 'yuv420p', '-profile:v', 'baseline',
    '-c:a', 'aac', '-b:a', '96k',
    '-movflags', '+faststart', '-threads', '0',
    '-y', outputPath
  ];

  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(FFMPEG_BIN, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let settled = false;
    let lastProgressAt = 0;
    const progress = {
      durationSeconds: 0,
      currentSeconds: 0,
      frame: 0,
      fps: 0,
      speed: '',
      finished: false
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      ffmpeg.kill('SIGKILL');
      finish(reject, new Error(`FFmpeg excedió el límite de ${Math.round(timeoutMs / 60000)} minutos.`));
    }, timeoutMs);
    timer.unref?.();

    const lines = createInterface({ input: ffmpeg.stderr, crlfDelay: Infinity });
    lines.on('line', (line) => {
      const durationMatch = line.match(/Duration:\s*(\d+:\d+:\d+(?:\.\d+)?)/);
      if (durationMatch) progress.durationSeconds = parseClock(durationMatch[1]);

      const separator = line.indexOf('=');
      if (separator > 0) {
        const key = line.slice(0, separator).trim();
        const value = line.slice(separator + 1).trim();
        if (key === 'frame') progress.frame = Number.parseInt(value, 10) || progress.frame;
        else if (key === 'fps') progress.fps = Number.parseFloat(value) || progress.fps;
        else if (key === 'out_time') progress.currentSeconds = parseClock(value);
        else if (key === 'speed' && value !== 'N/A') progress.speed = value;
        else if (key === 'progress') {
          progress.finished = value === 'end';
          const now = Date.now();
          if (progress.finished || now - lastProgressAt >= PROGRESS_LOG_INTERVAL_MS) {
            lastProgressAt = now;
            try { onProgress?.({ ...progress }); } catch (error) { console.error('[dw4] No se pudo imprimir el progreso:', error); }
          }
        }
        return;
      }
      if (line) stderr = (stderr + line + '\n').slice(-8000);
    });

    ffmpeg.once('error', (error) => finish(reject, error));
    ffmpeg.once('close', (code, signal) => {
      if (code === 0) return finish(resolve);
      finish(reject, new Error(`FFmpeg terminó con código ${code ?? signal}: ${stderr.trim() || 'sin detalle'}`));
    });
  });
}

function getQuotedVideo(msg) {
  const quoted = msg.quoted;
  const media = quoted?.content;
  const type = String(quoted?.type || '').replace(/Message$/i, '').toLowerCase();
  if (!quoted || !media || !['video', 'document'].includes(type)) return null;
  if (type === 'document') {
    const mime = String(media.mimetype || '').toLowerCase();
    const name = String(media.fileName || media.filename || '');
    if (!mime.startsWith('video/') && !VIDEO_EXTENSIONS.test(name)) return null;
  }
  if (!media.mediaKey) return null;
  return { media, type };
}

async function runDw4({ msg, sock, args = [] }) {
  const chat = msg.chat;
  if (!chat) return;
  if (activeChats.has(chat)) {
    return msg.reply('Ya hay un video procesándose en este chat. Espera a que termine.');
  }

  const quotedVideo = getQuotedVideo(msg);
  if (!quotedVideo) {
    return msg.reply('Responde al video con /dw4 para comprimirlo a 360p. Añade `doc` al final si quieres recibirlo como documento: `/dw4 doc`.');
  }

  activeChats.add(chat);
  const jobId = Date.now().toString(36).slice(-6);
  let tempDir;
  try {
    console.log(`[dw4 ${jobId}] iniciado; descargando el video citado.`);
    await msg.reply('Comprimiendo el video a 360p…');
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'rembot-dw4-'));
    const inputPath = path.join(tempDir, 'input-video');
    const outputPath = path.join(tempDir, 'video-360p.mp4');
    const mediaStream = await downloadContentFromMessage(quotedVideo.media, quotedVideo.type);
    await pipeline(mediaStream, fs.createWriteStream(inputPath, { flags: 'wx' }));

    console.log(`[dw4 ${jobId}] descarga lista; comenzando FFmpeg.`);
    await compressDw4(inputPath, outputPath, {
      onProgress: (progress) => printProgress(jobId, progress)
    });
    const sizeMb = fs.statSync(outputPath).size / (1024 * 1024);
    const asDocument = String(args.at(-1) || '').toLowerCase() === 'doc';
    const caption = `Listo: 360p · ${sizeMb.toFixed(1)} MB`;
    const payload = asDocument
      ? { document: { url: outputPath }, fileName: 'Video_360p.mp4', mimetype: 'video/mp4', caption }
      : { video: { url: outputPath }, mimetype: 'video/mp4', caption };

    console.log(`[dw4 ${jobId}] compresión lista (${sizeMb.toFixed(1)} MB); enviando resultado.`);
    await sock.sendMessage(chat, payload, { quoted: msg });
    console.log(`[dw4 ${jobId}] resultado enviado.`);
  } catch (error) {
    console.error(`[dw4 ${jobId}] error:`, error?.stack || error);
    await msg.reply('No se pudo comprimir el video. Verifica que sea un video válido e inténtalo de nuevo.');
  } finally {
    activeChats.delete(chat);
    if (tempDir) await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

export default {
  command: 'dw4',
  category: 'video',
  description: 'Comprime un video a 360p respondiendo con /dw4.',
  run: runDw4
};
