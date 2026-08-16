
# DubWave

DubWave is a Chrome extension for real-time AI voice dubbing.

It captures active tab audio, sends it to Gemini Live, translates speech in real time,
plays the translated voice, shows subtitles, and lowers the original video volume
while the translated voice is speaking.

## Features

- Real-time speech-to-speech translation
- Multi-language target selection
- Live subtitles
- Audio ducking for original video sound
- Optimized low-latency audio pipeline

## Install

1. Open chrome://extensions
2. Enable Developer mode
3. Click Load unpacked
4. Select the generated dubwave-extension folder

## Configure

1. Click the DubWave extension icon
2. Open Settings
3. Enter your Gemini API key
4. Choose target language
5. Save

## VPN Note

If Google AI services are blocked in your region, use a VPN/proxy that tunnels
WebSocket traffic. WireGuard or OpenVPN is recommended for real-time audio.
