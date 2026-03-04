/**
 * Audio I/O Layer
 *
 * Uses naudiodon (PortAudio N-API bindings) for cross-platform
 * mic capture and speaker playback.
 *
 * Why naudiodon over SoX/ALSA:
 *   - N-API provides stable ABI across Node.js versions
 *   - No shell-exec subprocess overhead
 *   - Works on macOS, Linux, Windows
 *   - Avoids CI pipeline compatibility issues
 *
 * Audio format:
 *   Input:  16-bit signed integer PCM, 16kHz, mono (Live API requirement)
 *   Output: 24kHz PCM from Live API response
 */

import { EventEmitter } from "events";

// naudiodon is a native module — import dynamically to allow
// graceful fallback in environments without audio hardware.
let portAudio: typeof import("naudiodon") | null = null;

export interface AudioIOEvents {
  audioData: [buffer: Buffer];
  energy: [level: number];
  error: [error: Error];
  playbackComplete: [];
}

export interface AudioIOConfig {
  inputSampleRate?: number;
  outputSampleRate?: number;
  inputChannels?: number;
  chunkSizeMs?: number;
}

/**
 * naudiodon sample format constants.
 * These match PortAudio's paInt16 / paFloat32 values.
 */
const SAMPLE_FORMAT_INT16 = 8; // paInt16

export class AudioIO extends EventEmitter<AudioIOEvents> {
  private inputStream: unknown = null;
  private outputStream: unknown = null;
  private isCapturing = false;
  private playbackQueue: Buffer[] = [];
  private isPlaying = false;
  private drainTimer: ReturnType<typeof setTimeout> | null = null;

  private config: Required<AudioIOConfig>;

  constructor(config?: AudioIOConfig) {
    super();
    this.config = {
      inputSampleRate: 16000,
      outputSampleRate: 24000,
      inputChannels: 1,
      chunkSizeMs: 100,
      ...config,
    };
  }

  /**
   * Initialise audio subsystem.
   * Returns false if audio hardware is unavailable (e.g. Docker/sandbox).
   */
  async init(): Promise<boolean> {
    try {
      portAudio = await import("naudiodon");
      return true;
    } catch {
      console.warn(
        "[AudioIO] naudiodon not available — running in headless mode"
      );
      return false;
    }
  }

  // ── Microphone Capture ────────────────────────────────────────

  startCapture(): void {
    if (!portAudio || this.isCapturing) return;

    const framesPerBuffer = Math.floor(
      (this.config.inputSampleRate * this.config.chunkSizeMs) / 1000
    );

    this.inputStream = (portAudio as any).AudioIO({
      inOptions: {
        channelCount: this.config.inputChannels,
        // FIX: Use Int16, not Float32. computeEnergy() reads Int16LE
        // (2 bytes/sample). Using Float32 (4 bytes) would produce garbage.
        sampleFormat: SAMPLE_FORMAT_INT16,
        sampleRate: this.config.inputSampleRate,
        framesPerBuffer,
        closeOnError: false,
      },
    });

    const stream = this.inputStream as any;

    stream.on("data", (chunk: Buffer) => {
      this.emit("audioData", chunk);

      // Compute RMS energy for client-side interrupt detection
      const energy = this.computeEnergy(chunk);
      this.emit("energy", energy);
    });

    stream.on("error", (err: Error) => {
      this.emit("error", err);
    });

    stream.start();
    this.isCapturing = true;
  }

  stopCapture(): void {
    if (!this.isCapturing || !this.inputStream) return;
    (this.inputStream as any).quit?.();
    (this.inputStream as any).abort?.();
    this.isCapturing = false;
    this.inputStream = null;
  }

  // ── Speaker Playback ──────────────────────────────────────────

  /**
   * Queue audio for playback.
   * PCM data from the Live API (base64-decoded).
   */
  queuePlayback(pcmBuffer: Buffer): void {
    this.playbackQueue.push(pcmBuffer);
    if (!this.isPlaying) {
      this.isPlaying = true;
      // Lazily create the output stream on first playback.
      // Not created in init() because output may never be needed
      // (e.g. text-only mode or simulated demo).
      if (portAudio && !this.outputStream) {
        try {
          this.outputStream = (portAudio as any).AudioIO({
            outOptions: {
              channelCount: 1,
              sampleFormat: SAMPLE_FORMAT_INT16,
              sampleRate: this.config.outputSampleRate,
              closeOnError: false,
            },
          });
          (this.outputStream as any).start?.();
        } catch (err) {
          this.emit("error", err as Error);
          this.outputStream = null;
        }
      }
      this.drainPlaybackQueue();
    }
  }

  /**
   * Immediately stop playback and clear the queue.
   * Called during barge-in.
   */
  stopPlayback(): void {
    this.playbackQueue = [];
    this.isPlaying = false;

    // FIX: Cancel any pending drain timer to prevent spurious
    // playbackComplete emission after stop.
    if (this.drainTimer !== null) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }

    if (this.outputStream) {
      (this.outputStream as any).quit?.();
      (this.outputStream as any).abort?.();
      this.outputStream = null;
    }
  }

  private drainPlaybackQueue(): void {
    // FIX: Guard against firing after stopPlayback()
    if (!this.isPlaying) return;

    if (this.playbackQueue.length === 0) {
      this.isPlaying = false;
      this.drainTimer = null;
      this.emit("playbackComplete");
      return;
    }

    const chunk = this.playbackQueue.shift()!;

    // Write to output stream if available
    if (portAudio && this.outputStream) {
      (this.outputStream as any).write?.(chunk);
    }

    // Schedule next drain based on audio duration
    // 16-bit = 2 bytes per sample
    const durationMs =
      (chunk.length / 2 / this.config.outputSampleRate) * 1000;
    this.drainTimer = setTimeout(() => this.drainPlaybackQueue(), durationMs);
  }

  // ── Energy Computation ────────────────────────────────────────

  /**
   * Compute RMS energy of a 16-bit PCM buffer.
   * Used for client-side interrupt detection as a supplement
   * to server-side VAD.
   */
  private computeEnergy(buffer: Buffer): number {
    // 16-bit signed integer = 2 bytes per sample
    const samples = buffer.length / 2;
    if (samples === 0) return 0;

    let sumSquares = 0;
    for (let i = 0; i < buffer.length - 1; i += 2) {
      const sample = buffer.readInt16LE(i) / 32768; // normalise to [-1, 1]
      sumSquares += sample * sample;
    }

    return Math.sqrt(sumSquares / samples); // RMS
  }

  // ── Cleanup ───────────────────────────────────────────────────

  destroy(): void {
    this.stopCapture();
    this.stopPlayback();
  }
}
