// DubWave input AudioWorklet.
// Converts captured tab audio to mono PCM16 at the sample rate required by
// the selected realtime provider. The target rate is configured by the
// offscreen engine (Gemini: 16 kHz, OpenAI-compatible: 24 kHz).

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    this.sourceRate = sampleRate;
    this.targetRate = 16000;
    this.step = this.sourceRate / this.targetRate;
    this.output = new Int16Array(320); // 20 ms @ 16 kHz by default
    this.outputFrames = 0;
    this.sourcePosition = 0;
    this.previousSample = 0;
    this.hasPreviousSample = false;
    this.dc = 0;

    this.port.onmessage = (event) => {
      const msg = event.data || {};
      if (msg.type !== "configure") return;

      const rate = Number(msg.targetRate);
      if (!Number.isFinite(rate) || rate < 8000 || rate > 48000) return;

      this.targetRate = rate;
      this.step = this.sourceRate / this.targetRate;
      this.output = new Int16Array(Math.max(160, Math.round(this.targetRate * 0.02)));
      this.outputFrames = 0;
      this.sourcePosition = 0;
      this.previousSample = 0;
      this.hasPreviousSample = false;
    };
  }

  emit(sample) {
    // Remove a small DC offset before quantizing. This avoids wasting PCM
    // headroom on a constant bias introduced by some capture paths.
    this.dc += 0.0005 * (sample - this.dc);
    const centered = sample - this.dc;
    const clamped = Math.max(-1, Math.min(1, centered));
    this.output[this.outputFrames++] = clamped < 0
      ? clamped * 0x8000
      : clamped * 0x7fff;

    if (this.outputFrames === this.output.length) {
      this.port.postMessage(this.output.buffer, [this.output.buffer]);
      this.output = new Int16Array(Math.max(160, Math.round(this.targetRate * 0.02)));
      this.outputFrames = 0;
    }
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const frames = input[0].length;
    if (!frames) return true;

    const channels = input.length;
    const mono = new Float32Array(frames);

    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (let c = 0; c < channels; c++) sum += input[c][i] || 0;
      mono[i] = sum / channels;
    }

    if (!this.hasPreviousSample) {
      this.previousSample = mono[0];
      this.hasPreviousSample = true;
    }

    let position = this.sourcePosition;
    while (position < frames - 1) {
      const i = Math.floor(position);
      const frac = position - i;
      const a = i === 0 ? this.previousSample : mono[i];
      const b = i === 0 ? mono[0] : mono[Math.min(i + 1, frames - 1)];
      this.emit(a + (b - a) * frac);
      position += this.step;
    }

    this.sourcePosition = position - (frames - 1);
    this.previousSample = mono[frames - 1];
    return true;
  }
}

registerProcessor("pcm-capture", PcmCaptureProcessor);
