// DubWave realtime audio output worklet.
// Gemini Live returns 24 kHz PCM. AudioWorklet runs at the AudioContext's
// native sampleRate (usually 48 kHz), so we must resample while consuming.
// Playing 24 kHz samples one-for-one on a 48 kHz context makes voices sound
// unnaturally high-pitched and child-like.

class RealtimePcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();

    this.inputRate = 24000;
    this.outputRate = sampleRate;
    this.step = this.inputRate / this.outputRate;

    // Three seconds of 24 kHz input PCM. The buffer is measured in input
    // samples, not output samples.
    this.capacity = this.inputRate * 3;
    this.targetSamples = Math.floor(this.inputRate * 0.14);
    this.buffer = new Float32Array(this.capacity);
    this.read = 0;
    this.write = 0;
    this.available = 0;
    this.readPosition = 0;
    this.played = 0;
    this.underruns = 0;
    this.started = false;
    this.lastReport = 0;

    this.port.onmessage = (event) => {
      const msg = event.data || {};

      if (msg.type === "reset") {
        this.read = 0;
        this.write = 0;
        this.available = 0;
        this.readPosition = 0;
        this.started = false;
        return;
      }

      if (msg.type === "setTargetMs") {
        const ms = Math.max(40, Math.min(500, Number(msg.value) || 140));
        this.targetSamples = Math.floor(this.inputRate * ms / 1000);
        return;
      }

      if (msg.type === "pcm" && msg.buffer) {
        const pcm = new Int16Array(msg.buffer);
        for (let i = 0; i < pcm.length; i++) {
          if (this.available >= this.capacity) {
            // Drop the oldest sample if the network outruns playback. This is
            // preferable to growing latency forever during a long session.
            this.read = (this.read + 1) % this.capacity;
            this.available--;
          }

          this.buffer[this.write] = pcm[i] / 32768;
          this.write = (this.write + 1) % this.capacity;
          this.available++;
        }
      }
    };
  }

  sampleAt(offset) {
    if (offset < 0 || offset >= this.available) return 0;
    return this.buffer[(this.read + offset) % this.capacity];
  }

  consumeInputSamples(count) {
    if (count <= 0) return;
    const whole = Math.min(Math.floor(count), this.available);
    if (whole > 0) {
      this.read = (this.read + whole) % this.capacity;
      this.available -= whole;
    }
    this.readPosition = Math.max(0, this.readPosition - whole);
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    if (!out || !out[0]) return true;

    if (!this.started && this.available >= this.targetSamples) {
      this.started = true;
    }

    for (let i = 0; i < out[0].length; i++) {
      if (!this.started || this.available < 2) {
        out[0][i] = 0;
        if (this.started && i === 0) this.underruns++;
        continue;
      }

      // Linear interpolation from 24 kHz Gemini PCM to the AudioContext's
      // native rate. On a normal 48 kHz context this consumes two input
      // samples for every output sample, restoring the original pitch/time.
      const index = Math.floor(this.readPosition);
      const frac = this.readPosition - index;
      const a = this.sampleAt(index);
      const b = this.sampleAt(index + 1);
      out[0][i] = a + (b - a) * frac;

      this.readPosition += this.step;
      const whole = Math.floor(this.readPosition);
      if (whole > 0) this.consumeInputSamples(whole);
      this.played++;
    }

    const now = currentTime;
    if (now - this.lastReport >= 1) {
      this.lastReport = now;
      this.port.postMessage({
        type: "metrics",
        bufferedMs: this.available / this.inputRate * 1000,
        underruns: this.underruns,
        started: this.started,
        inputRate: this.inputRate,
        outputRate: this.outputRate
      });
    }

    return true;
  }
}

registerProcessor("realtime-pcm-player", RealtimePcmPlayer);
