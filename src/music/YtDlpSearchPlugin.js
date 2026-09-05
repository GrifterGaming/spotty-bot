const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

// @distube/yt-dlp's own postinstall script (which npm runs automatically on every
// `npm install`, before any of our code ever executes) downloads the plain "yt-dlp"
// asset to its default filename — a Python zipapp requiring a system Python 3.10+
// interpreter that most hosts (including Railway's Node build image) don't have.
// Confirmed directly: that produced "env: 'python3': No such file or directory" in
// production. We want the platform's self-contained standalone build instead, which
// bundles its own runtime — but downloading over that SAME default filename doesn't
// help, because our "skip download if the file already exists" check (below) would
// then see postinstall's file already sitting there and never fix it. So this saves
// to a distinctly-named file instead, entirely independent of whatever postinstall
// downloaded — we never read or depend on that default file at all.
const YTDLP_ASSET_BY_PLATFORM = {
  darwin: 'yt-dlp_macos',
  win32: 'yt-dlp.exe',
  linux: 'yt-dlp_linux',
};
const YTDLP_ASSET = YTDLP_ASSET_BY_PLATFORM[process.platform] || 'yt-dlp_linux';
if (!process.env.YTDLP_URL) {
  process.env.YTDLP_URL = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${YTDLP_ASSET}`;
}
const YTDLP_FILENAME = process.platform === 'win32' ? 'yt-dlp-standalone.exe' : 'yt-dlp-standalone';
process.env.YTDLP_FILENAME = YTDLP_FILENAME;

const { Song, Playlist, ExtractorPlugin, DisTubeError } = require('distube');

// require.resolve('@distube/yt-dlp/package.json') is blocked by that package's own
// "exports" map, so derive the package root from its main entry point instead.
const YTDLP_PACKAGE_ROOT = path.dirname(path.dirname(require.resolve('@distube/yt-dlp')));
const YTDLP_PATH = path.join(YTDLP_PACKAGE_ROOT, 'bin', YTDLP_FILENAME);

// @distube/yt-dlp exports its own download() helper, but it has a real bug: it calls
// fs.writeFile() without awaiting it, so the returned promise resolves before the
// binary is actually finished writing to disk — confirmed directly in production
// (its own success log line was immediately followed by the file still not existing).
// This reimplements the download properly, fully awaited, using Node's built-in
// fetch (which already follows redirects) instead of that library's helper.
async function downloadYtDlp() {
  const res = await fetch(process.env.YTDLP_URL);
  if (!res.ok) throw new Error(`Failed to download yt-dlp: HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  await fs.promises.mkdir(path.dirname(YTDLP_PATH), { recursive: true });
  await fs.promises.writeFile(YTDLP_PATH, buffer, { mode: 0o755 });
}

console.log(
  `[YtDlpSearchPlugin] platform=${process.platform} YTDLP_URL=${process.env.YTDLP_URL} YTDLP_PATH=${YTDLP_PATH} existsBeforeDownload=${fs.existsSync(YTDLP_PATH)}`,
);

// Cloud/datacenter IPs (Railway, AWS, etc.) get YouTube's "Sign in to confirm you're
// not a bot" challenge far more aggressively than home ISP connections — confirmed
// directly in production. Passing real browser cookies (exported from a logged-in
// YouTube session) makes requests look like an authenticated real user instead of an
// anonymous bot, avoiding that challenge. Optional: set YTDLP_COOKIES (the full
// contents of an exported cookies.txt file) as an env var to enable this.
const YTDLP_COOKIES_PATH = path.join(YTDLP_PACKAGE_ROOT, 'bin', 'cookies.txt');
if (process.env.YTDLP_COOKIES) {
  fs.writeFileSync(YTDLP_COOKIES_PATH, process.env.YTDLP_COOKIES);
  console.log('[YtDlpSearchPlugin] wrote cookies file from YTDLP_COOKIES env var');
}
const COOKIE_ARGS = process.env.YTDLP_COOKIES ? ['--cookies', YTDLP_COOKIES_PATH] : [];

// @distube/yt-dlp's own json() helper concatenates stdout AND stderr into one buffer
// before calling JSON.parse() on it. Current yt-dlp releases print a "Deprecated
// Feature" notice (about the --no-call-home flag that plugin hardcodes) ahead of the
// JSON payload, which breaks that parse on every call — confirmed directly against
// this project's installed yt-dlp binary. This keeps stdout/stderr separate so
// warnings never corrupt the actual JSON.
function runYtDlpJson(target, extraArgs = [], { useCookies = true } = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      target,
      '--dump-single-json',
      '--no-warnings',
      '--skip-download',
      '--simulate',
      '--prefer-free-formats',
      // YouTube's current SABR rollout hides formats missing a "PO token" (a newer
      // anti-bot mechanism) from the format list — this tells yt-dlp to consider
      // them anyway. Confirmed in production: cookie-authenticated requests hit a
      // SABR-restricted format set that leaves nothing to match otherwise. Testing
      // whether that restriction is specifically tied to cookies being present.
      '--extractor-args',
      'youtube:formats=missing_pot',
      ...(useCookies ? COOKIE_ARGS : []),
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
    // Stored (not fire-and-forget) so callers can await it — a fresh deploy with no
    // binary yet would otherwise race a /play right after startup against a download
    // still in progress.
    if (process.env.FORCE_YTDLP_UPDATE || !fs.existsSync(YTDLP_PATH)) {
      console.log('[YtDlpSearchPlugin] downloading yt-dlp binary to', YTDLP_PATH);
      this.ready = downloadYtDlp()
        .then(() =>
          console.log(
            `[YtDlpSearchPlugin] download finished, existsNow=${fs.existsSync(YTDLP_PATH)}, size=${fs.existsSync(YTDLP_PATH) ? fs.statSync(YTDLP_PATH).size : 'n/a'}`,
          ),
        )
        .catch((err) => console.error('[YtDlpSearchPlugin] download FAILED:', err));
    } else {
      this.ready = Promise.resolve();
    }
  }

  validate(url) {
    return typeof url === 'string';
  }

  async searchSong(query, options) {
    await this.ready;
    // Confirmed via production logs: the "Requested format is not available" error
    // was happening HERE, during search — not in getStreamURL as first assumed.
    // --dump-single-json performs format resolution even when nothing downstream
    // needs a playable URL yet (we only need title/id/artist to build the Song), and
    // errors out entirely if none resolve. This flag makes it return the metadata
    // anyway instead of failing the whole command.
    const info = await runYtDlpJson(`ytsearch1:${query}`, [
      '--no-playlist',
      '--ignore-no-formats-error',
    ]).catch((err) => {
      throw new DisTubeError('YTDLP_ERROR', err.message);
    });
    const entry = Array.isArray(info.entries) ? info.entries[0] : info;
    return entry ? toSong(this, entry, options) : null;
  }

  async resolve(url, options) {
    await this.ready;
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
    await this.ready;
    if (!song.url) throw new DisTubeError('YTDLP_ERROR', 'Cannot get stream url from invalid song.');
    // Confirmed in production: this fails one way or the other right now on cloud
    // hosts. Without cookies -> flat "Sign in to confirm you're not a bot" block.
    // With cookies -> passes that, but hits YouTube's newer SABR restriction, which
    // leaves no usable format regardless of selector permissiveness or the
    // missing_pot workaround. Keeping cookies here since the no-cookies failure mode
    // is strictly worse (blocks everything, vs. SABR which may not affect every
    // video/account). See README for the current state of this limitation.
    const info = await runYtDlpJson(song.url, ['--format', 'best']).catch((err) => {
      throw new DisTubeError('YTDLP_ERROR', err.message);
    });
    return info.url;
  }

  getRelatedSongs() {
    return [];
  }
}

module.exports = { YtDlpSearchPlugin };
