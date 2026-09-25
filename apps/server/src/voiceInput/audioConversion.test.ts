import { describe, expect, it } from "vite-plus/test";

import { pcm16FromWav } from "./audioConversion.ts";

function chunk(id: string, body: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(id, 0, "ascii");
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body, body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

function wav(...chunks: Buffer[]): Buffer {
  const body = Buffer.concat([Buffer.from("WAVE", "ascii"), ...chunks]);
  const header = Buffer.alloc(8);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

describe("pcm16FromWav", () => {
  it("finds the samples behind extra chunks such as afconvert's FLLR padding", () => {
    const samples = Buffer.from([1, 0, 2, 0, 3, 0]);
    const file = wav(
      chunk("fmt ", Buffer.alloc(16)),
      chunk("FLLR", Buffer.alloc(7)),
      chunk("data", samples),
    );
    expect(Buffer.from(pcm16FromWav(file))).toEqual(samples);
  });

  it("rejects files that are not WAV or carry no samples", () => {
    expect(() => pcm16FromWav(Buffer.from("not a wav file"))).toThrow("not a WAV");
    expect(() => pcm16FromWav(wav(chunk("fmt ", Buffer.alloc(16))))).toThrow("no audio data");
  });
});
