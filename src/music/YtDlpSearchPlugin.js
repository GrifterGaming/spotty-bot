const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { Song, Playlist, ExtractorPlugin, DisTubeError } = require('distube');
const { ensurePotProvider } = require('./potProvider');

// @distube/yt-dlp's own postinstall script (which npm runs automatically on every
// `npm install`, before any of our code ever executes) downloads the plain "yt-dlp"
// asset to its default filename — a Python zipapp requiring a system Python 3.10+
// interpreter that most hosts (including Railway's default Node build image) don't
// have. Confirmed directly: that produced "env: 'python3': No such file or
// directory" in production. We want the platform's self-contained standalone build
// instead, which bundles its own runtime — but downloading over that SAME default
// filename doesn't help, because our "skip download if the file already exists"
// check (below) would then see postinstall's file already sitting there and never
// fix it. So this saves to a distinctly-named file instead, entirely independent of
// whatever postinstall downloaded — we never read or depend on that default file.
const YTDLP_ASSET_BY_PLATFORM = {
  darwin: 'yt-dlp_macos',
  win32: 'yt-dlp.exe',
  linux: 'yt-dlp_linux',
};
const YTDLP_ASSET = YTDLP_ASSET_BY_PLATFORM[process.platform] || 'yt-dlp_linux';
const YTDLP_STANDALONE_URL = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${YTDLP_ASSET}`;

// require.resolve('@distube/yt-dlp/package.json') is blocked by that package's own
// "exports" map, so derive the package root from its main entry point instead.
const YTDLP_PACKAGE_ROOT = path.dirname(path.dirname(require.resolve('@distube/yt-dlp')));
const YTDLP_STANDALONE_FILENAME = process.platform === 'win32' ? 'yt-dlp-standalone.exe' : 'yt-dlp-standalone';
const YTDLP_STANDALONE_PATH = path.join(YTDLP_PACKAGE_ROOT, 'bin', YTDLP_STANDALONE_FILENAME);

// The path/command actually spawned by runYtDlpJson — resolved once at startup (see
// resolveYtDlp below) to either the system "yt-dlp" (pip-installed via nixpacks.toml
// in production, so PO token plugin support works — see potProvider.js for why the
// standalone binary can't do this) or our own downloaded standalone binary as a
// fallback for environments (e.g. local dev) without that set up.
let YTDLP_PATH = YTDLP_STANDALONE_PATH;

// @distube/yt-dlp exports its own download() helper, but it has a real bug: it calls
// fs.writeFile() without awaiting it, so the returned promise resolves before the
// binary is actually finished writing to disk — confirmed directly in production
// (its own success log line was immediately followed by the file still not
// existing). This reimplements the download properly, fully awaited, using Node's
// built-in fetch (which already follows redirects) instead of that library's helper.
async function downloadStandaloneYtDlp() {
  const res = await fetch(YTDLP_STANDALONE_URL);
  if (!res.ok) throw new Error(`Failed to download yt-dlp: HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  await fs.promises.mkdir(path.dirname(YTDLP_STANDALONE_PATH), { recursive: true });
  await fs.promises.writeFile(YTDLP_STANDALONE_PATH, buffer, { mode: 0o755 });
}

function checkSystemYtDlp() {
  const check = spawnSync('yt-dlp', ['--version']);
  return check.status === 0 ? check.stdout.toString().trim() : null;
}

// Prefer a system yt-dlp (pip-installed) if one is on PATH: it's a real Python
// install, not a frozen binary, so it can load the PO token plugin that lets
// getStreamURL actually work around YouTube's SABR restrictions in production.
// railpack.json makes python3/pip available in the deploy image there; this pip
// installs yt-dlp + the plugin itself the first time (simpler and more portable
// than fighting the build system's own install-phase config for this). Falls back
// to downloading our own standalone binary otherwise — fine for local dev, which
// doesn't need PO tokens.
async function resolveYtDlp() {
  let version = checkSystemYtDlp();
  if (version) {
    YTDLP_PATH = 'yt-dlp';
    console.log(`[YtDlpSearchPlugin] using system yt-dlp on PATH, version=${version}`);
    return;
  }

  const pipCheck = spawnSync('pip3', ['--version']);
  if (pipCheck.status === 0) {
    console.log('[YtDlpSearchPlugin] python3/pip present, pip-installing yt-dlp + PO token plugin');
    const install = spawnSync(
      'pip3',
      ['install', '--break-system-packages', 'yt-dlp', 'bgutil-ytdlp-pot-provider'],
      { encoding: 'utf8' },
    );
    if (install.status === 0) {
      version = checkSystemYtDlp();
      if (version) {
        YTDLP_PATH = 'yt-dlp';
        console.log(`[YtDlpSearchPlugin] pip install succeeded, using system yt-dlp, version=${version}`);
        return;
      }
      console.warn('[YtDlpSearchPlugin] pip install succeeded but yt-dlp still not found on PATH');
    } else {
      console.error('[YtDlpSearchPlugin] pip install FAILED:', install.stderr || install.stdout);
    }
  }

  console.log(
    `[YtDlpSearchPlugin] no system yt-dlp found, falling back to standalone binary. platform=${process.platform} url=${YTDLP_STANDALONE_URL} path=${YTDLP_STANDALONE_PATH} existsBeforeDownload=${fs.existsSync(YTDLP_STANDALONE_PATH)}`,
  );
  if (process.env.FORCE_YTDLP_UPDATE || !fs.existsSync(YTDLP_STANDALONE_PATH)) {
    console.log('[YtDlpSearchPlugin] downloading standalone yt-dlp binary to', YTDLP_STANDALONE_PATH);
    await downloadStandaloneYtDlp();
    console.log(
      `[YtDlpSearchPlugin] download finished, existsNow=${fs.existsSync(YTDLP_STANDALONE_PATH)}, size=${fs.existsSync(YTDLP_STANDALONE_PATH) ? fs.statSync(YTDLP_STANDALONE_PATH).size : 'n/a'}`,
    );
  }
}

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
      // Temporarily verbose (not --no-warnings) while debugging the new PO token
      // integration — need to see what's actually happening with token generation,
      // not just the final error line. -v/warnings go to stderr, so this doesn't
      // corrupt the --dump-single-json output on stdout that we JSON.parse below.
      '-v',
      '--skip-download',
      '--simulate',
      '--prefer-free-formats',
      // Confirmed in production logs: with this flag present, yt-dlp lists
      // bgutil:http as an available PO token provider but never actually calls it —
      // telling yt-dlp "show me formats even without a token" apparently makes it
      // skip trying to fetch a real one at all. Removed now that a real provider
      // (potProvider.js) is running, so yt-dlp should actually use it.
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
    // Stored (not fire-and-forget) so callers can await it — a fresh deploy with no
    // binary downloaded yet would otherwise race a /play right after startup
    // against setup still in progress.
    const ytdlpReady = resolveYtDlp().catch((err) =>
      console.error('[YtDlpSearchPlugin] yt-dlp setup FAILED:', err),
    );
    const potReady = ensurePotProvider().catch((err) =>
      console.error('[YtDlpSearchPlugin] PO token provider setup FAILED:', err),
    );
    this.ready = Promise.all([ytdlpReady, potReady]);
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
