# DubWave

DubWave is an open-source Chrome extension for real-time AI voice dubbing, maintained by **Hadimousavi79**.

It captures active-tab audio, sends it to a realtime AI provider, plays translated speech, shows subtitles, and ducks the original video audio while dubbing is active.

## Features

- Google Gemini Live Translation support
- OpenAI Realtime support
- Custom / OpenAI-compatible realtime WebSocket base URL
- User-supplied LLM API key and model
- Multi-language target selection
- Live subtitles and audio ducking
- Optional LiveKit room transport for LiveKit-powered dubbing agents
- Local browser storage for provider configuration

## Build

The repository includes a cross-platform build script that works with Windows paths containing spaces as well as POSIX/Linux paths. It also creates a ready-to-load Chrome extension directory automatically.

```bash
npm install
npm run build
```

The command creates:

- `dist/` for the complete build output
- `dist/extension/` as the **Chrome Load unpacked** folder

Then open `chrome://extensions`, enable Developer mode, click **Load unpacked**, and select **`dist/extension/`**. You no longer need to manually create an `extension` folder or copy the files yourself.

## Realtime audio pipeline

DubWave uses the correct provider audio formats:

- Gemini Live Translation input: mono PCM16 at 16 kHz
- OpenAI-compatible Realtime input: mono PCM16 at 24 kHz
- Realtime audio output: PCM16 at 24 kHz

The capture worklet is configured for the provider's input rate. The playback worklet keeps one continuous PCM queue and resamples the 24 kHz model output to the browser device rate. This avoids the common 24 kHz-at-48 kHz pitch error and reduces packet-boundary clicks/glitches.

The client no longer hard-gates input by peak level, because a fixed client noise gate can remove quiet consonants and cause missed words. Realtime server-side VAD/noise reduction is used instead.

## LLM configuration

Open DubWave Settings and select:

1. **Google Gemini Live** for Gemini Live Translation.
2. **OpenAI Realtime** for an OpenAI Realtime endpoint.
3. **Custom / OpenAI-compatible Realtime** for a compatible gateway or self-hosted proxy.

For a custom provider, enter its realtime base URL, API key, and model. You can enter either:

```text
https://your-host/v1
```

or:

```text
wss://your-host/v1/realtime
```

DubWave converts `http(s)` to `ws(s)` and adds `/realtime` when the path does not already contain it. The server must implement the OpenAI Realtime event protocol. Browser WebSockets cannot add arbitrary HTTP Authorization headers, so compatible gateways should accept the OpenAI browser realtime subprotocol or an `api_key` query parameter.

> API keys are stored in `chrome.storage.local` and are sent directly to the endpoint you configure. Never commit an API key to this repository. For OpenAI itself, a server-issued short-lived client secret is preferable to exposing a standard API key in a browser.

## Gemini audio quality

Gemini Live Translation returns raw PCM16 audio at 24 kHz. DubWave now feeds those chunks into the continuous `audio-player.js` worklet instead of creating a new `AudioBuffer` for every network packet. This prevents clicks and pitch/time distortion caused by treating 24 kHz packets as if they were already at the output device sample rate.

Gemini's dedicated Live Translation model controls its translation voice. Other native-audio Gemini models can use the selected voice setting.

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
