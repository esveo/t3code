import type { VoiceCallConnectResult } from "@t3tools/contracts";

import {
  setVoiceCallLevelSource,
  startVoiceCallLevels,
  stopVoiceCallLevels,
} from "./voiceCallLevels";

/**
 * Fork: the browser side of a voice call, one per tab. It owns the
 * microphone, the speaker and the WebRTC peer; the server owns everything
 * else, including the event channel. It lives outside React so switching
 * threads does not drop the call.
 */
const CONNECT_TIMEOUT_MS = 15_000;
const CONNECT_ATTEMPTS = 3;

export type VoiceCallConnect = (input: {
  readonly offerSdp: string;
}) => Promise<VoiceCallConnectResult>;

interface ActivePeer {
  readonly peer: RTCPeerConnection;
  readonly microphone: MediaStream;
  readonly speaker: HTMLAudioElement;
}

let active: ActivePeer | null = null;
let starting: AbortController | null = null;
let stopWatchingCall: (() => void) | null = null;

export const isVoiceCallPeerActive = () => active !== null || starting !== null;

function closePeer() {
  stopWatchingCall?.();
  stopWatchingCall = null;
  stopVoiceCallLevels();
  if (active === null) return;
  active.peer.close();
  for (const track of active.microphone.getTracks()) track.stop();
  active.speaker.srcObject = null;
  active = null;
}

function waitForConnected(peer: RTCPeerConnection, cancelled: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (connected: boolean) => {
      clearTimeout(timer);
      peer.removeEventListener("connectionstatechange", onChange);
      cancelled.removeEventListener("abort", onCancel);
      resolve(connected);
    };
    const onChange = () => {
      if (peer.connectionState === "connected") done(true);
      else if (peer.connectionState === "failed" || peer.connectionState === "closed") done(false);
    };
    // Closing a peer fires no state change.
    const onCancel = () => done(false);
    const timer = setTimeout(() => done(false), CONNECT_TIMEOUT_MS);
    peer.addEventListener("connectionstatechange", onChange);
    cancelled.addEventListener("abort", onCancel);
    onChange();
  });
}

/**
 * Must run inside the click handler: Safari only allows the microphone and
 * audio playback from a user gesture.
 */
export async function startVoiceCallPeer(
  connect: VoiceCallConnect,
  /** The connection broke after it was up; the server cannot see that on its own. */
  onDropped: () => void,
  /** Follows the server's call for as long as the peer runs, wherever the user is by then. */
  watchCall: () => () => void,
): Promise<void> {
  if (isVoiceCallPeerActive()) return;
  const start = new AbortController();
  const cancelled = start.signal;
  starting = start;
  stopWatchingCall = watchCall();
  const speaker = document.createElement("audio");
  speaker.autoplay = true;
  startVoiceCallLevels();
  try {
    const microphone = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (cancelled.aborted) {
      for (const track of microphone.getTracks()) track.stop();
      return;
    }
    setVoiceCallLevelSource("user", microphone);
    for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt++) {
      const peer = new RTCPeerConnection();
      active = { peer, microphone, speaker };
      peer.addEventListener("track", (event) => {
        speaker.srcObject = event.streams[0] ?? null;
        if (event.streams[0]) setVoiceCallLevelSource("voice", event.streams[0]);
      });
      for (const track of microphone.getAudioTracks()) peer.addTrack(track, microphone);
      // The session expects this channel; the server holds the events, so it stays unused.
      peer.createDataChannel("oai-events");
      await peer.setLocalDescription(await peer.createOffer());
      if (cancelled.aborted) return;
      const result = await connect({ offerSdp: peer.localDescription?.sdp ?? "" });
      if (cancelled.aborted) return;
      await peer.setRemoteDescription({ type: "answer", sdp: result.answerSdp });
      if (await waitForConnected(peer, cancelled)) {
        peer.addEventListener("connectionstatechange", () => {
          if (peer.connectionState === "failed" && active?.peer === peer) {
            closePeer();
            onDropped();
          }
        });
        return;
      }
      if (cancelled.aborted) return;
      peer.close();
    }
    throw new Error("The voice call could not connect.");
  } catch (error) {
    if (cancelled.aborted) return;
    closePeer();
    throw error;
  } finally {
    if (starting === start) starting = null;
  }
}

export function stopVoiceCallPeer() {
  starting?.abort();
  starting = null;
  closePeer();
}

/** The server ended the call or another client took it over. */
export function stopVoiceCallPeerUnlessStarting() {
  if (starting === null) closePeer();
}
