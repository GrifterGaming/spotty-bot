const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

// @distube/yt-dlp defaults to downloading the plain "yt-dlp" asset, which is a
// Python zipapp requiring a system Python 3.10+ interpreter — often missing or
// outdated (e.g. macOS's bundled Python) both locally and on minimal cloud/Docker
// hosts. Point it at the platform's self-contained standalone binary instead, which
// bundles its own runtime and needs nothing else installed. Must be set before
// requiring the package (and set here, not in a caller, so this holds regardless of
// how/where this plugin gets required — including standalone scripts/tests).
if (!process.env.YTDLP_URL) {
  const YTDLP_ASSET_BY_PLATFORM = {
    darwin: 'yt-dlp_macos',
    win32: 'yt-dlp.exe',
    linux: 'yt-dlp_linux',
  };
  const asset = YTDLP_ASSET_BY_PLATFORM[process.platform] || 'yt-dlp_linux';
  process.env.YTDLP_URL = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`;
}

const { download } = require('@distube/yt-dlp');
const { Song, Playlist, ExtractorPlugin, DisTubeError } = require('distube');

// require.resolve('@distube/yt-dlp/package.json') is blocked by that package's own
// "exports" map, so derive the package root from its main entry point instead.
const YTDLP_PACKAGE_ROOT = path.dirname(path.dirname(require.resolve('@distube/yt-dlp')));
const YTDLP_PATH = path.join(
  YTDLP_PACKAGE_ROOT,
  'bin',
  process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp',
);

// @distube/yt-dlp's own json() helper concatenates stdout AND stderr into one buffer
// before calling JSON.parse() on it. Current yt-dlp releases print a "Deprecated
// Feature" notice (about the --no-call-home flag that plugin hardcodes) ahead of the
// JSON payload, which breaks that parse on every call — confirmed directly against
// this project's installed yt-dlp binary. This keeps stdout/stderr separate so
// warnings never corrupt the actual JSON.
function runYtDlpJson(target, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const args = [
      target,
      '--dump-single-json',
      '--no-warnings',
      '--skip-download',
      '--simulate',
      '--prefer-free-formats',
      ...extraArgs,
    ];
    const child = spawn(YTDLP_PATH, args);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(stderr || `yt-dlp exited with code ${code}`));
      try {
        resolve(JSON.parse(stdout));
      } catch (err) {
        reject(new Error(`Failed to parse yt-dlp output: ${err.message}`));
      }
    });
  });
}

function toSong(plugin, info, options) {
  return new Song(
    {
      plugin,
      source: info.extractor || 'youtube',
      playFromSource: true,
      id: info.id,
      name: info.title || info.fulltitle,
      url: info.webpage_url || info.original_url,
      isLive: Boolean(info.is_live),
      thumbnail: info.thumbnail || info.thumbnails?.[0]?.url,
      duration: info.is_live ? 0 : info.duration,
      uploader: { name: info.uploader, url: info.uploader_url },
      views: info.view_count,
      likes: info.like_count,
      ageRestricted: Boolean(info.age_limit) && info.age_limit >= 18,
    },
    options,
  );
}

// A from-scratch "extractor" plugin backed by yt-dlp: handles both turning a plain
// search query (e.g. a Spotify track's title/artist) into a song, and resolving
// direct YouTube (or any yt-dlp-supported) URLs — replacing @distube/yt-dlp's own
// classes because of the JSON-parsing bug above.
class YtDlpSearchPlugin extends ExtractorPlugin {
  constructor() {
    super();
    // Only download when the binary is missing, not on every startup. Overwriting an
    // already-verified binary with a fresh copy (even byte-identical) makes macOS
    // redo its first-run Gatekeeper security check, which took multiple minutes in
    // testing — re-downloading every restart made every bot launch that slow for the
    // first song. Set FORCE_YTDLP_UPDATE=1 to update deliberately when needed.
    if (process.env.FORCE_YTDLP_UPDATE || !fs.existsSync(YTDLP_PATH)) {
      download().catch(() => {});
    }
  }

  validate(url) {
    return typeof url === 'string';
  }

  async searchSong(query, options) {
    const info = await runYtDlpJson(`ytsearch1:${query}`, ['--no-playlist']).catch((err) => {
      throw new DisTubeError('YTDLP_ERROR', err.message);
    });
    const entry = Array.isArray(info.entries) ? info.entries[0] : info;
    return entry ? toSong(this, entry, options) : null;
  }

  async resolve(url, options) {
    const info = await runYtDlpJson(url).catch((err) => {
      throw new DisTubeError('YTDLP_ERROR', err.message);
    });
    if (Array.isArray(info.entries)) {
      if (!info.entries.length) throw new DisTubeError('YTDLP_ERROR', 'The playlist is empty');
      return new Playlist(
        {
          source: info.extractor || 'youtube',
          songs: info.entries.map((entry) => toSong(this, entry, options)),
          id: info.id?.toString(),
          name: info.title,
          url: info.webpage_url,
          thumbnail: info.thumbnails?.[0]?.url,
        },
        options,
      );
    }
    return toSong(this, info, options);
  }

  async getStreamURL(song) {
    if (!song.url) throw new DisTubeError('YTDLP_ERROR', 'Cannot get stream url from invalid song.');
    const info = await runYtDlpJson(song.url, ['--format', 'bestaudio/best']).catch((err) => {
      throw new DisTubeError('YTDLP_ERROR', err.message);
    });
    return info.url;
  }

  getRelatedSongs() {
    return [];
  }
}

module.exports = { YtDlpSearchPlugin };
