# Shadh Music v4.1

Premium claymorphic / liquid-glass YouTube music player.

## Included
- YouTube Data API v3 search
- Official YouTube IFrame playback
- Smart Radio and personalized recommendations
- Trending discovery
- Mood shortcuts
- Search history + voice search where supported by the browser
- Queue with drag-to-reorder
- Shuffle / repeat / next / previous
- Likes, local playlists, history
- Playlist management and JSON import/export
- Sleep timer
- Media Session controls where supported
- Full-page settings with General / Playback / Appearance / Recommendations / YouTube / Library / Keyboard / About sections
- OLED dark, light clay and system appearance
- Compact cards and reduced-motion controls
- Mobile queue drawer
- Persistent settings and library
- No modal backdrop or background blur overlay

## YouTube API
`config.js` may contain a browser-side API key for development. Browser-side keys are visible to visitors, so for a public site use a restricted key or move API requests to a server-side proxy.

Enable **YouTube Data API v3** in Google Cloud and restrict the key to your allowed origins and API.

## Run
Open `index.html` in a local web server for best browser compatibility. Example:

```bash
python -m http.server 8080
```

Then open `http://localhost:8080/`.
