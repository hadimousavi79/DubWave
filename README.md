# DubWave

DubWave is an open-source Chrome extension for real-time AI voice dubbing, maintained by **Hadimousavi79**.

It captures active-tab audio, sends it directly to a realtime AI provider, plays translated speech, shows subtitles, and ducks the original video audio while dubbing is active.

## Features

- Google Gemini Live support
- OpenAI Realtime support
- Custom / OpenAI-compatible realtime WebSocket base URL
- User-supplied LLM API key and model
- Multi-language target selection
- Live subtitles and audio ducking
- Chrome built-in TTS fallback
- No LiveKit dependency or LiveKit transport

## Install

Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the repository directory.

## LLM configuration

Open DubWave Settings and select:

1. **Google Gemini Live** for Gemini's realtime pipeline.
2. **OpenAI Realtime** for OpenAI's realtime WebSocket protocol.
3. **Custom / OpenAI-compatible Realtime** for a compatible gateway, self-hosted proxy, or provider gateway.

For a custom provider, enter its realtime WebSocket base URL, API key, and model. The gateway must implement the realtime event format expected by the selected provider mode.

> API keys are stored in `chrome.storage.local` and are sent directly to the endpoint you configure. Never commit an API key to this repository. For production deployments, prefer short-lived credentials or a trusted backend proxy when the provider supports them.

## Architecture

The extension has three simple pieces:

- `background.js` manages tab capture, muting, lifecycle, and the offscreen document.
- `offscreen-v2.js` handles PCM audio capture/playback and the realtime provider connection.
- `options.html` / `options.js` store provider, endpoint, model, voice, and language settings.

There is deliberately no LiveKit SDK, LiveKit server configuration, token flow, or third-party bundling step in this branch.

## Ownership and attribution

DubWave is the original project of **Hadimousavi79**. This repository is intentionally open source under Apache License 2.0. Redistribution and derivative works are allowed, but applicable copyright, license, and attribution notices must be preserved. The project name and branding are not a grant of trademark rights, and a fork must not be presented as the official DubWave project or imply endorsement by Hadimousavi79.

An open-source license cannot truthfully make a derivative work the original author's work. The repository therefore uses copyright and attribution notices plus clear official-project language to preserve project identity.

## License

Apache License 2.0. See `LICENSE`.
