const SpotifyWebApi = require('spotify-web-api-node');

const spotifyApi = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
});

let tokenExpiresAt = 0;

// Fetches a Client Credentials app token and refreshes it before it expires.
// Client Credentials grants read-only access to public catalog data (tracks,
// playlists, albums) — no user login is required or possible with this flow.
async function ensureAccessToken() {
  if (Date.now() < tokenExpiresAt) return spotifyApi.getAccessToken();

  const data = await spotifyApi.clientCredentialsGrant();
  spotifyApi.setAccessToken(data.body.access_token);
  // Refresh a minute early to avoid racing the actual expiry.
  tokenExpiresAt = Date.now() + (data.body.expires_in - 60) * 1000;
  return data.body.access_token;
}

module.exports = { spotifyApi, ensureAccessToken };
