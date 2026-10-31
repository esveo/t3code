import { afterEach, expect, it, vi } from "vite-plus/test";

import { isVoiceCallPeerActive, startVoiceCallPeer, stopVoiceCallPeer } from "./voiceCallPeer";

vi.mock("./voiceCallLevels", () => ({
  setVoiceCallLevelSource: () => undefined,
  startVoiceCallLevels: () => undefined,
  stopVoiceCallLevels: () => undefined,
}));

/** Never connects, and like the real one fires no state change when closed. */
class FakePeer extends EventTarget {
  connectionState = "new";
  localDescription = { sdp: "offer" };
  close() {}
  addTrack() {}
  createDataChannel() {}
  createOffer = async () => ({});
  setLocalDescription = async () => undefined;
  setRemoteDescription = async () => undefined;
}

function stubBrowser() {
  const track = { stop: vi.fn() };
  const microphone = { getTracks: () => [track], getAudioTracks: () => [track] };
  vi.stubGlobal("RTCPeerConnection", FakePeer);
  vi.stubGlobal("document", { createElement: () => ({}) });
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: async () => microphone },
  });
  return { track };
}

afterEach(() => {
  stopVoiceCallPeer();
  vi.unstubAllGlobals();
});

it("hanging up during a start does not connect again", async () => {
  stubBrowser();
  const connect = vi.fn(async () => {
    return { callId: "c", segmentId: "s", answerSdp: "v=0 answer" };
  });
  const stopWatching = vi.fn();
  const started = startVoiceCallPeer(connect, vi.fn(), () => stopWatching);
  await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1));

  stopVoiceCallPeer();
  await started;

  expect(connect).toHaveBeenCalledTimes(1);
  expect(stopWatching).toHaveBeenCalledTimes(1);
  expect(isVoiceCallPeerActive()).toBe(false);
});

it("hanging up while the microphone is asked for releases it unconnected", async () => {
  const { track } = stubBrowser();
  const connect = vi.fn();
  const started = startVoiceCallPeer(connect, vi.fn(), () => () => undefined);

  stopVoiceCallPeer();
  await started;

  expect(connect).not.toHaveBeenCalled();
  expect(track.stop).toHaveBeenCalledTimes(1);
});
