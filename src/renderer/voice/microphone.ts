/**
 * Listens to your microphone track as the call publishes it, for your Vowe's speech recognition: 16 kHz
 * mono 16-bit PCM in 100 ms chunks. It never opens or turns on a microphone itself. It taps the track
 * LiveKit already has, with its echo cancellation, only while you have it on, and stopping it leaves the
 * track alone.
 */

export interface MicrophoneTap {
  stop(): void;
}

export type TapMicrophone = (track: MediaStreamTrack, onPcm: (pcm: Int16Array) => void) => Promise<MicrophoneTap>;

export const tapMicrophone: TapMicrophone = async (track, onPcm) => {
  const context = new AudioContext();
  try {
    await context.audioWorklet.addModule(new URL('./microphone-worklet.js', import.meta.url));
    const source = context.createMediaStreamSource(new MediaStream([track]));
    const node = new AudioWorkletNode(context, 'vowe-microphone', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => onPcm(new Int16Array(e.data));
    // The node only runs while connected to the output; it writes silence there.
    source.connect(node).connect(context.destination);
    await context.resume();
    return {
      stop() {
        node.port.onmessage = null;
        source.disconnect();
        node.disconnect();
        void context.close();
      },
    };
  } catch (err) {
    void context.close();
    throw err;
  }
};
