// @effect-diagnostics nodeBuiltinImport:off
/**
 * Fork: turns the AAC recordings phones make into the 16 kHz PCM Whisper
 * reads. Node has no AAC decoder, so this shells out to afconvert, which ships
 * with every Mac, and to ffmpeg elsewhere.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { VOICE_INPUT_SAMPLE_RATE } from "@t3tools/contracts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

/** Converts an m4a recording to 16 kHz mono PCM16. */
export async function convertM4aToPcm16(m4a: Buffer, platform: string): Promise<ArrayBuffer> {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-voice-"));
  try {
    const input = NodePath.join(directory, "recording.m4a");
    const output = NodePath.join(directory, "recording.wav");
    await NodeFSP.writeFile(input, m4a);
    if (platform === "darwin") {
      await execFile("afconvert", [
        "-f",
        "WAVE",
        "-d",
        `LEI16@${VOICE_INPUT_SAMPLE_RATE}`,
        "-c",
        "1",
        input,
        output,
      ]);
    } else {
      await execFile("ffmpeg", [
        "-loglevel",
        "error",
        "-i",
        input,
        "-ac",
        "1",
        "-ar",
        String(VOICE_INPUT_SAMPLE_RATE),
        "-c:a",
        "pcm_s16le",
        output,
      ]).catch((cause: unknown) => {
        throw new Error("Converting phone recordings needs ffmpeg on this server.", { cause });
      });
    }
    return pcm16FromWav(await NodeFSP.readFile(output));
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
}

/** The samples of a PCM WAV file, found by walking its chunks rather than assuming a 44-byte header. */
export function pcm16FromWav(wav: Buffer): ArrayBuffer {
  if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("The converted recording is not a WAV file.");
  }
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === "data") {
      const end = Math.min(wav.length, start + size);
      return wav.buffer.slice(wav.byteOffset + start, wav.byteOffset + end) as ArrayBuffer;
    }
    offset = start + size + (size % 2);
  }
  throw new Error("The converted recording has no audio data.");
}
