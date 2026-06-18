// Encode an array of JPEG frame buffers to an MP4 buffer via ffmpeg. The
// existing per-feature videos (bunchingVideo/gapVideo/...) inline their own
// ffmpeg invocation; this is the shared encoder for newer videos (cross-route
// bunching). Mirrors atlanta-transit-insights' src/marta/shared/video.js so the
// two repos stay parallel.
const Fs = require('fs-extra');
const Os = require('node:os');
const Path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileP = promisify(execFile);

async function encodeFrames(
  frames,
  { prefix = 'cta-video', framerate = 16, holdSeconds = 1 } = {},
) {
  if (!frames || frames.length < 2) return null;
  const tmpDir = await Fs.mkdtemp(Path.join(Os.tmpdir(), `${prefix}-`));
  try {
    for (let i = 0; i < frames.length; i++) {
      await Fs.writeFile(Path.join(tmpDir, `frame_${String(i).padStart(3, '0')}.jpg`), frames[i]);
    }
    // ~1s hold on the last frame so viewers can read the final state before loop.
    const holdFrames = Math.max(0, Math.round(framerate * holdSeconds));
    const lastIdx = frames.length - 1;
    const lastPath = Path.join(tmpDir, `frame_${String(lastIdx).padStart(3, '0')}.jpg`);
    for (let k = 1; k <= holdFrames; k++) {
      await Fs.copyFile(
        lastPath,
        Path.join(tmpDir, `frame_${String(lastIdx + k).padStart(3, '0')}.jpg`),
      );
    }

    const outPath = Path.join(tmpDir, 'out.mp4');
    // yuv420p requires even dims — the scale filter is cheap insurance.
    await execFileP(
      'ffmpeg',
      [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-framerate',
        String(framerate),
        '-i',
        Path.join(tmpDir, 'frame_%03d.jpg'),
        '-vf',
        'scale=trunc(iw/2)*2:trunc(ih/2)*2',
        '-c:v',
        'libx264',
        '-preset',
        'fast',
        '-crf',
        '23',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        outPath,
      ],
      { timeout: 60_000 },
    );
    return await Fs.readFile(outPath);
  } finally {
    await Fs.remove(tmpDir).catch(() => {});
  }
}

module.exports = { encodeFrames };
