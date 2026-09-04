# DubWave

DubWave is an open-source Chrome extension for real-time AI voice dubbing, maintained by **Hadimousavi79**.

It captures active-tab audio, sends it to a realtime AI provider, plays translated speech, shows subtitles, and ducks the original video audio while dubbing is active.

## Features

- Google Gemini Live support
- OpenAI Realtime support
- Custom / OpenAI-compatible realtime WebSocket base URL
- User-supplied LLM API key and model
- Multi-language target selection
- Live subtitles and audio ducking
- Optional LiveKit room transport for LiveKit-powered dubbing agents
- Local browser storage for provider configuration

## Build

The repository now includes `package.json` and a build script that bundles the LiveKit browser SDK locally for Chrome MV3 CSP compatibility.

```bash
npm install
npm run build
```

Then open `chrome://extensions`, enable Developer mode, click **Load unpacked**, and select `dist/`.

## LLM configuration

Open DubWave Settings and select:

1. **Google Gemini Live** for the existing Gemini realtime pipeline.
2. **OpenAI Realtime** for OpenAI's realtime WebSocket protocol.
3. **Custom / OpenAI-compatible Realtime** for a compatible gateway such as a self-hosted proxy or provider gateway.

For a custom provider, enter its realtime WebSocket base URL, API key, and model. The gateway must implement the OpenAI Realtime event format used by DubWave.

> API keys are stored in `chrome.storage.local` and are sent directly to the endpoint you configure. Never commit an API key to this repository.

## LiveKit

LiveKit is supported as a media transport. Set a LiveKit server URL and a **participant token** in Settings, then select **LiveKit room**. DubWave publishes the captured tab audio into the room and plays subscribed remote audio tracks, allowing a LiveKit agent/backend to perform the dubbing pipeline.

Do not place a LiveKit API secret in the extension. Generate short-lived participant tokens from your own backend. LiveKit's JavaScript client is bundled during `npm run build`.

## Ownership and attribution

DubWave is the original project of **Hadimousavi79**. This repository is intentionally open source under Apache License 2.0. Redistribution and derivative works are allowed, but copyright, license, and attribution notices must be preserved. The project name and branding are not a grant of trademark rights, and a fork must not be presented as the official DubWave project or imply endorsement by Hadimousavi79.

This attribution statement is intentionally separate from the copyright license: an open-source license cannot truthfully turn a derivative work into the original author's work, but it can require preservation of applicable notices and distinguish official project identity.

## Third-party software

LiveKit is an independent open-source project. DubWave does not claim ownership of LiveKit or its SDK. See `NOTICE` for attribution information.

## License

Apache License 2.0. See `LICENSE`.
