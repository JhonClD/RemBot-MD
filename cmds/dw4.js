import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { downloadContentFromMessage } from 'baileys';
import ffmpegStatic from 'ffmpeg-static';

const FFMPEG_TIMEOUT_MS = 20 * 60 * 1000;
const FFMPEG_BIN = ffmpegStatic || 'ffmpeg';
const activeChats = new Set();
const VIDEO_EXTENSIONS = /\.(mp4|m4v|mkv|mov|webm|avi|3gp)$/i;

export function compressDw4(inputPath, outputPath, { timeoutMs = FFMPEG_TIMEOUT_MS } = {}) {
  const filter = 'scale=-2:360:flags=lanczos,pad=ceil(iw/2)*2:ceil(ih/2)*2';
  const args = [
    '-hide_banner', '-nostdin', '-v', 'error',
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

    ffmpeg.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-8000);
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
  let tempDir;
  try {
    await msg.reply('Comprimiendo el video a 360p…');
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'rembot-dw4-'));
    const inputPath = path.join(tempDir, 'input-video');
    const outputPath = path.join(tempDir, 'video-360p.mp4');
    const mediaStream = await downloadContentFromMessage(quotedVideo.media, quotedVideo.type);
    await pipeline(mediaStream, fs.createWriteStream(inputPath, { flags: 'wx' }));

    await compressDw4(inputPath, outputPath);
    const sizeMb = fs.statSync(outputPath).size / (1024 * 1024);
    const asDocument = String(args.at(-1) || '').toLowerCase() === 'doc';
    const caption = `Listo: 360p · ${sizeMb.toFixed(1)} MB`;
    const payload = asDocument
      ? { document: { url: outputPath }, fileName: 'Video_360p.mp4', mimetype: 'video/mp4', caption }
      : { video: { url: outputPath }, mimetype: 'video/mp4', caption };

    await sock.sendMessage(chat, payload, { quoted: msg });
  } catch (error) {
    console.error('[dw4]', error?.stack || error);
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
