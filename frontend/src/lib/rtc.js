// WebRTC helpers for the remote: a direct data channel between phone and laptop.
// Signaling (one offer, one answer) goes through the server; after that, commands and
// state flow peer-to-peer, which on the same Wi-Fi skips the round trip via the VPS.
import { withBase } from "./paths";

// STUN lets peers find a working path when local (mDNS) candidates don't resolve.
const CONFIG = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

export function newPeer() {
  return new RTCPeerConnection(CONFIG);
}

/** Non-trickle ICE: wait (briefly) for candidates so the SDP is sent in one message. */
export function gathered(pc, timeoutMs = 2000) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(t);
      pc.removeEventListener("icegatheringstatechange", check);
      resolve();
    };
    const check = () => pc.iceGatheringState === "complete" && done();
    const t = setTimeout(done, timeoutMs);
    pc.addEventListener("icegatheringstatechange", check);
  });
}

export function signal(body) {
  return fetch(withBase("/api/remote/signal"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {});
}
