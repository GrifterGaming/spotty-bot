const ffmpegPath = require('ffmpeg-static');

const { DisTube } = require('distube');
const { SpotifyPlugin } = require('@distube/spotify');
const { YtDlpSearchPlugin } = require('./YtDlpSearchPlugin');

function createDisTube(client) {
  return new DisTube(client, {
    emitAddSongWhenCreatingQueue: false,
    emitAddListWhenCreatingQueue: false,
    // DisTube defaults to the bare command "ffmpeg" on PATH, ignoring the
    // FFMPEG_PATH env var — must point it explicitly at ffmpeg-static's binary.
    ffmpeg: { path: ffmpegPath },
    plugins: [
      // Deliberately NOT passing api.clientId/clientSecret here. Since late 2024,
      // Spotify's official Web API omits the track list entirely from playlist/album
      // responses for apps that haven't been manually approved for "Extended Quota
      // Mode" — even for fully public playlists (confirmed against the real API: 200
      // OK, `public: true`, but no `tracks` field at all). Without credentials, this
      // plugin instead scrapes the public open.spotify.com page the same way a
      // browser would, which isn't subject to that restriction. Trade-off: capped at
      // ~100 tracks per playlist/album, which is fine for this use case.
      new SpotifyPlugin(),
      // A Spotify-resolved Song has no direct URL — this handles turning its
      // title/artist into a yt-dlp YouTube search result AND streaming it, so
      // yt-dlp (not the less reliable ytdl-core-based @distube/youtube) is used
      // end-to-end. See YtDlpSearchPlugin.js for why.
      new YtDlpSearchPlugin(),
    ],
  });
}

module.exports = { createDisTube };
