// DubWave realtime audio output worklet.
// Maintains a small PCM ring buffer so streamed model audio is rendered by the
// audio thread instead of creating one AudioBufferSourceNode per network chunk.

class RealtimePcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.rate = 24000;
    this.capacity = this.rate * 3;
    this.buffer = new Float32Array(this.capacity);
    this.read = 0;
    this.write = 0;
    this.available = 0;
    this.played = 0;
    this.underruns = 0;

    this.port.onmessage = (event) => {
      const msg = event.data || {};
      if (msg.type === "reset") {
        this.read = 0;
        this.write = 0;
        this.available = 0;
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

    for (let i = 0; i < out[0].length; i++) {
      if (this.available > 0) {
        const sample = this.buffer[this.read];
        this.read = (this.read + 1) % this.capacity;
        this.available--;
        out[0][i] = sample;
        this.played++;
      } else {
        out[0][i] = 0;
        if (i === 0) this.underruns++;
      }
    }

    return true;
  }
}

registerProcessor("realtime-pcm-player", RealtimePcmPlayer);
