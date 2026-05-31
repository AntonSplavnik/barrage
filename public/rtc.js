// WebRTC peer connection + HTTP signaling polling.
//
// P1 (host) flow:
//   const rtc = new RtcHost(sessionId, token);
//   rtc.onMessage = (msg) => { ... };      // JSON from P2
//   rtc.onConnected = () => { ... };
//   rtc.onDisconnected = () => { ... };
//   await rtc.start();
//   rtc.send(msg);                         // JSON to P2
//
// P2 (guest) flow:
//   const rtc = new RtcGuest(sessionId, token);
//   (same interface as above)
//   await rtc.start();

const STUN_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

const POLL_INTERVAL_MS = 500;
const CONNECT_TIMEOUT_MS = 15000;

// ---------------------------------------------------------------------------
// Base class — shared P1/P2 logic
// ---------------------------------------------------------------------------

class RtcPeer {
  constructor(sessionId, token) {
    this.sessionId = sessionId;
    this.token = token;
    this.pc = null;
    this.channel = null;
    this._pollTimer = null;
    this._connected = false;

    // Callbacks — set by caller
    this.onMessage = null;
    this.onConnected = null;
    this.onDisconnected = null;
    this.onError = null;
  }

  async _api(method, path, body = null) {
    const opts = {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body !== null ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== null ? { body: JSON.stringify(body) } : {}),
    };
    const res = await fetch(`/api${path}`, opts);
    return res.json();
  }

  _createPeerConnection() {
    this.pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });

    this.pc.onicecandidate = ({ candidate }) => {
      if (!candidate) return;
      this._api("POST", `/sessions/${this.sessionId}/ice`, {
        role: this._role,
        candidate: candidate.toJSON(),
      }).catch(() => {});
    };

    this.pc.onconnectionstatechange = () => {
      const state = this.pc.connectionState;
      if (state === "connected") {
        this._onChannelOpen();
      } else if (state === "failed" || state === "disconnected" || state === "closed") {
        this._stopPolling();
        if (this._connected) {
          this._connected = false;
          this.onDisconnected?.();
        } else {
          this.onError?.(`WebRTC connection failed (state: ${state}). Check NAT/firewall settings.`);
        }
      }
    };
  }

  _setupChannel(channel) {
    this.channel = channel;
    channel.binaryType = "arraybuffer";

    channel.onopen = () => this._onChannelOpen();

    channel.onclose = () => {
      this._stopPolling();
      if (this._connected) {
        this._connected = false;
        this.onDisconnected?.();
      }
    };

    channel.onmessage = ({ data }) => {
      try {
        this.onMessage?.(typeof data === "string" ? data : new TextDecoder().decode(data));
      } catch (err) {
        console.error("[rtc] onmessage error:", err);
      }
    };

    channel.onerror = (err) => {
      console.error("[rtc] DataChannel error:", err);
    };
  }

  _onChannelOpen() {
    if (this._connected) return;
    this._connected = true;
    this._stopPolling();
    this.onConnected?.();
  }

  _stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  send(msg) {
    if (this.channel?.readyState === "open") {
      this.channel.send(typeof msg === "string" ? msg : JSON.stringify(msg));
    }
  }

  close() {
    this._stopPolling();
    this.channel?.close();
    this.pc?.close();
  }
}

// ---------------------------------------------------------------------------
// P1 — Host
// ---------------------------------------------------------------------------

export class RtcHost extends RtcPeer {
  constructor(sessionId, token) {
    super(sessionId, token);
    this._role = "host";
  }

  async start() {
    this._createPeerConnection();

    // Create the data channel (host always creates it)
    const channel = this.pc.createDataChannel("game", {
      ordered: false,
      maxRetransmits: 0,
    });
    this._setupChannel(channel);

    // Generate and post offer
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);

    await this._api("POST", `/sessions/${this.sessionId}/offer`, {
      sdp: this.pc.localDescription.sdp,
    });

    console.log("[rtc/host] offer posted, waiting for guest answer...");
    // Poll for answer + ICE candidates from guest
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + CONNECT_TIMEOUT_MS;

      this._pollTimer = setInterval(async () => {
        if (Date.now() > deadline) {
          this._stopPolling();
          reject(new Error("WebRTC handshake timed out — guest did not join within 15 seconds."));
          return;
        }

        try {
          // Pick up guest's answer
          if (!this.pc.remoteDescription) {
            const { sdp } = await this._api("GET", `/sessions/${this.sessionId}/answer`);
            if (sdp) {
              console.log("[rtc/host] got answer → setRemoteDescription");
              await this.pc.setRemoteDescription({ type: "answer", sdp });
            }
          }

          // Pick up guest's ICE candidates
          const { candidates } = await this._api(
            "GET",
            `/sessions/${this.sessionId}/ice/guest`,
          );
          for (const c of candidates ?? []) {
            await this.pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
          }
        } catch (err) {
          console.warn("[rtc/host] poll error:", err.message);
        }
      }, POLL_INTERVAL_MS);

      // Resolve once channel opens
      const origConnected = this.onConnected;
      this.onConnected = () => {
        this.onConnected = origConnected;
        origConnected?.();
        resolve();
      };
      const origError = this.onError;
      this.onError = (msg) => {
        this.onError = origError;
        origError?.(msg);
        reject(new Error(msg));
      };
    });
  }
}

// ---------------------------------------------------------------------------
// P2 — Guest
// ---------------------------------------------------------------------------

export class RtcGuest extends RtcPeer {
  constructor(sessionId, token) {
    super(sessionId, token);
    this._role = "guest";
  }

  async start() {
    this._createPeerConnection();

    // DataChannel arrives from host
    this.pc.ondatachannel = ({ channel }) => {
      this._setupChannel(channel);
    };

    console.log("[rtc/guest] waiting for host offer...");
    await this._waitForOffer();
    console.log("[rtc/guest] got offer → creating answer");

    // Generate and post answer
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);

    await this._api("POST", `/sessions/${this.sessionId}/answer`, {
      sdp: this.pc.localDescription.sdp,
    });
    console.log("[rtc/guest] answer posted, waiting for DataChannel...");

    // Poll for host's ICE candidates + wait for channel
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + CONNECT_TIMEOUT_MS;

      this._pollTimer = setInterval(async () => {
        if (Date.now() > deadline) {
          this._stopPolling();
          reject(new Error("WebRTC handshake timed out — connection did not open."));
          return;
        }

        try {
          const { candidates } = await this._api(
            "GET",
            `/sessions/${this.sessionId}/ice/host`,
          );
          for (const c of candidates ?? []) {
            await this.pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
          }
        } catch (err) {
          console.warn("[rtc/guest] poll error:", err.message);
        }
      }, POLL_INTERVAL_MS);

      const origConnected = this.onConnected;
      this.onConnected = () => {
        this.onConnected = origConnected;
        origConnected?.();
        resolve();
      };
      const origError = this.onError;
      this.onError = (msg) => {
        this.onError = origError;
        origError?.(msg);
        reject(new Error(msg));
      };
    });
  }

  async _waitForOffer() {
    for (let attempts = 0; attempts < 30; attempts++) {
      const { sdp } = await this._api("GET", `/sessions/${this.sessionId}/offer`);
      if (sdp) {
        await this.pc.setRemoteDescription({ type: "offer", sdp });
        return;
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    throw new Error("Host offer not available after 15 seconds.");
  }
}
