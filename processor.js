// DubWave input AudioWorklet.
// Converts browser tab audio to mono PCM16 at 16 kHz using a continuous
// linear-interpolation resampler. Phase is preserved across process() calls.

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetRate = 16000;
    this.sourceRate = sampleRate;
    this.step = this.sourceRate / this.targetRate;
    this.output = new Int16Array(320); // 20 ms @ 16 kHz
    this.outputFrames = 0;
    this.sourcePosition = 0;
    this.previousSample = 0;
    this.hasPreviousSample = false;
  }

  emit(sample) {
    const clamped = Math.max(-1, Math.min(1, sample));
    this.output[this.outputFrames++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    if (this.outputFrames === this.output.length) {
      this.port.postMessage(this.output.buffer, [this.output.buffer]);
      this.output = new Int16Array(320);
      this.outputFrames = 0;
    }
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const frames = input[0].length;
    if (!frames) return true;

    const mono = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (let c = 0; c < input.length; c++) sum += input[c][i] || 0;
      mono[i] = sum / input.length;
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
