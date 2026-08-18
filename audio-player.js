// DubWave realtime audio output worklet.
// PCM ring buffer with a short startup target to absorb network jitter.

class RealtimePcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.rate = 24000;
    this.capacity = this.rate * 3;
    this.targetSamples = Math.floor(this.rate * 0.14);
    this.buffer = new Float32Array(this.capacity);
    this.read = 0;
    this.write = 0;
    this.available = 0;
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
        this.started = false;
        return;
      }
      if (msg.type === "setTargetMs") {
        const ms = Math.max(40, Math.min(500, Number(msg.value) || 140));
        this.targetSamples = Math.floor(this.rate * ms / 1000);
        return;
      }
      if (msg.type === "pcm" && msg.buffer) {
        const pcm = new Int16Array(msg.buffer);
        for (let i = 0; i < pcm.length; i++) {
          if (this.available >= this.capacity) {
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

  process(_inputs, outputs) {
    const out = outputs[0];
    if (!out || !out[0]) return true;

    if (!this.started && this.available >= this.targetSamples) this.started = true;

    for (let i = 0; i < out[0].length; i++) {
      if (this.started && this.available > 0) {
        out[0][i] = this.buffer[this.read];
        this.read = (this.read + 1) % this.capacity;
        this.available--;
        this.played++;
      } else {
        out[0][i] = 0;
        if (this.started && i === 0) this.underruns++;
      }
    }

    // Send low-rate telemetry from the audio thread. This is deliberately
    // throttled so diagnostics never compete with audio rendering.
    const now = currentTime;
    if (now - this.lastReport >= 1) {
      this.lastReport = now;
      this.port.postMessage({
        type: "metrics",
        bufferedMs: this.available / this.rate * 1000,
        underruns: this.underruns,
        started: this.started
      });
    }

    return true;
  }
}

registerProcessor("realtime-pcm-player", RealtimePcmPlayer);
