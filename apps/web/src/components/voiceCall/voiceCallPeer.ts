import type { VoiceCallConnectResult } from "@t3tools/contracts";

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
  readonly retryOf?: string;
}) => Promise<VoiceCallConnectResult>;

interface ActivePeer {
  readonly peer: RTCPeerConnection;
  readonly microphone: MediaStream;
  readonly speaker: HTMLAudioElement;
}

let active: ActivePeer | null = null;
let starting = false;

export const isVoiceCallPeerActive = () => active !== null || starting;

function closePeer() {
  if (active === null) return;
  active.peer.close();
  for (const track of active.microphone.getTracks()) track.stop();
  active.speaker.srcObject = null;
  active = null;
}

function waitForConnected(peer: RTCPeerConnection): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (connected: boolean) => {
      clearTimeout(timer);
      peer.removeEventListener("connectionstatechange", onChange);
      resolve(connected);
    };
    const onChange = () => {
      if (peer.connectionState === "connected") done(true);
      else if (peer.connectionState === "failed" || peer.connectionState === "closed") done(false);
    };
    const timer = setTimeout(() => done(false), CONNECT_TIMEOUT_MS);
    peer.addEventListener("connectionstatechange", onChange);
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
): Promise<void> {
  if (isVoiceCallPeerActive()) return;
  starting = true;
  const speaker = document.createElement("audio");
  speaker.autoplay = true;
  try {
    const microphone = await navigator.mediaDevices.getUserMedia({ audio: true });
    let retryOf: string | undefined;
    for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt++) {
      const peer = new RTCPeerConnection();
      active = { peer, microphone, speaker };
      peer.addEventListener("track", (event) => {
        speaker.srcObject = event.streams[0] ?? null;
      });
      for (const track of microphone.getAudioTracks()) peer.addTrack(track, microphone);
      // The session expects this channel; the server holds the events, so it stays unused.
      peer.createDataChannel("oai-events");
      await peer.setLocalDescription(await peer.createOffer());
      const result = await connect({
        offerSdp: peer.localDescription?.sdp ?? "",
        ...(retryOf === undefined ? {} : { retryOf }),
      });
      await peer.setRemoteDescription({ type: "answer", sdp: result.answerSdp });
      if (await waitForConnected(peer)) {
        peer.addEventListener("connectionstatechange", () => {
          if (peer.connectionState === "failed" && active?.peer === peer) {
            closePeer();
            onDropped();
          }
        });
        return;
      }
      peer.close();
      retryOf = result.segmentId;
    }
    throw new Error("The voice call could not connect.");
  } catch (error) {
    closePeer();
    throw error;
  } finally {
    starting = false;
  }
}

export function stopVoiceCallPeer() {
  closePeer();
}

/** The server ended the call or another client took it over. */
export function stopVoiceCallPeerUnlessStarting() {
  if (!starting) closePeer();
}
