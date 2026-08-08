# Acquisition providers

Primary is SpotiFLAC 1.5.2. Its documented headless CLI accepts a Spotify URL
and can prioritize lossless providers including Deezer, Tidal, Qobuz and Amazon.
Because the application's search layer returns Deezer metadata URLs, the
provider first resolves the selected title/artist to a Spotify web URL, without
using Spotify Web API credentials.

Fallback is a headless adapter based on the YtFLAC project's documented stack:
yt-dlp + ffmpeg, FLAC extraction, metadata and thumbnail embedding. The upstream
YtFLAC script is interactive and writes to an Android/Termux Downloads path, so
the adapter runs the same underlying tools unattended and writes AUDIO_OUTPUT.

Upstream YtFLAC: https://github.com/hmz64/YtFLAC

Only use audio sources and downloads you are authorized to access.
