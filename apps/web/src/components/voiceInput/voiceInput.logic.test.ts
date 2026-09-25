import { describe, expect, it } from "vite-plus/test";

import {
  describeVoiceInputPreparation,
  encodePcm16Base64,
  formatVoiceElapsed,
  peakLevel,
} from "./voiceInput.logic";

function decodePcm16(base64: string): number[] {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  return Array.from({ length: bytes.length / 2 }, (_, index) => view.getInt16(index * 2, true));
}

describe("encodePcm16Base64", () => {
  it("writes little-endian 16-bit samples and clamps out-of-range input", () => {
    expect(decodePcm16(encodePcm16Base64(new Float32Array([0, 1, -1, 0.5, 2, -3])))).toEqual([
      0, 32767, -32768, 16383, 32767, -32768,
    ]);
  });

  it("encodes recordings longer than one conversion chunk", () => {
    const samples = new Float32Array(100_000).fill(0.25);
    const decoded = decodePcm16(encodePcm16Base64(samples));
    expect(decoded).toHaveLength(100_000);
    expect(decoded.at(-1)).toBe(8191);
  });
});

describe("peakLevel", () => {
  it("finds the loudest sample in either direction", () => {
    expect(peakLevel(new Float32Array([0.1, -0.6, 0.3]))).toBeCloseTo(0.6);
    expect(peakLevel(new Float32Array())).toBe(0);
  });
});

describe("formatVoiceElapsed", () => {
  it("shows minutes and zero-padded seconds", () => {
    expect(formatVoiceElapsed(7.9)).toBe("0:07");
    expect(formatVoiceElapsed(125)).toBe("2:05");
  });
});

describe("describeVoiceInputPreparation", () => {
  it("names the step until the model is ready", () => {
    expect(describeVoiceInputPreparation(null)).toBeNull();
    expect(
      describeVoiceInputPreparation({ phase: "downloading", receivedBytes: 42, totalBytes: 100 }),
    ).toBe("Downloading speech model 42%");
    expect(
      describeVoiceInputPreparation({ phase: "downloading", receivedBytes: 42, totalBytes: 0 }),
    ).toBe("Downloading speech model…");
    expect(
      describeVoiceInputPreparation({ phase: "ready", receivedBytes: 0, totalBytes: 0 }),
    ).toBeNull();
  });
});
