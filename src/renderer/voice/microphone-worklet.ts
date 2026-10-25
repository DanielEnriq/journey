// Runs on the audio thread (AudioWorkletGlobalScope), loaded by microphone.ts. It turns the
// microphone's float samples at the context's rate into 16 kHz 16-bit PCM for speech recognition,
// posted in 100 ms chunks. A box filter is enough here: echo cancellation and noise suppression have
// already shaped the signal for speech.

declare const sampleRate: number;
declare function registerProcessor(name: string, processor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

const OUT_RATE = 16000;
const CHUNK = OUT_RATE / 10;

class MicrophoneDownsampler extends AudioWorkletProcessor {
  private readonly ratio = sampleRate / OUT_RATE;
  private sum = 0;
  private count = 0;
  private position = 0;
  private out = new Int16Array(CHUNK);
  private filled = 0;

  process(inputs: Float32Array[][]): boolean {
    const samples = inputs[0]?.[0];
    if (!samples) return true;
    for (const sample of samples) {
      this.sum += sample;
      this.count++;
      if (++this.position < this.ratio) continue;
      this.position -= this.ratio;
      const value = Math.max(-1, Math.min(1, this.sum / this.count));
      this.out[this.filled++] = value < 0 ? value * 0x8000 : value * 0x7fff;
      this.sum = 0;
      this.count = 0;
      if (this.filled === CHUNK) {
        this.port.postMessage(this.out.buffer, [this.out.buffer]);
        this.out = new Int16Array(CHUNK);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('vowe-microphone', MicrophoneDownsampler);
