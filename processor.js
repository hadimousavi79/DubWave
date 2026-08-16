
// DubWave AudioWorklet processor.
// Converts tab audio into 16 kHz mono PCM16 chunks optimized for low latency.

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    // 480 samples at 16 kHz = 30 ms.
    this.sink = new Int16Array(480);
    this.sinkFrames = 0;

    this.sourceSampleRate = sampleRate;
    this.targetSampleRate = 16000;
    this.ratio = this.sourceSampleRate / this.targetSampleRate;
    this.sourceIndex = 0;
  }

  process(inputs) {
    const input = inputs[0];

    if (!input || input.length === 0 || !input[0]) {
      return true;
    }

    const channelData = input[0];

    for (let i = 0; i < channelData.length; i++) {
      const sourceFrame = this.sourceIndex++;
      const targetFrame = Math.floor(sourceFrame / this.ratio);
      const previousTargetFrame = Math.floor((sourceFrame - 1) / this.ratio);

      if (targetFrame !== previousTargetFrame) {
        let sample = Math.max(-1, Math.min(1, channelData[i]));

        this.sink[this.sinkFrames++] =
          sample < 0 ? sample * 0x8000 : sample * 0x7fff;

        if (this.sinkFrames >= this.sink.length) {
          this.port.postMessage(this.sink.buffer, [this.sink.buffer]);

          this.sink = new Int16Array(480);
          this.sinkFrames = 0;
        }
      }
    }

    return true;
  }
}

registerProcessor("pcm-capture", PcmCaptureProcessor);
