/******/ (() => { // webpackBootstrap
/******/ 	var __webpack_modules__ = ({

/***/ "./node_modules/@networked-aframe/minijanus/minijanus.js":
/*!***************************************************************!*\
  !*** ./node_modules/@networked-aframe/minijanus/minijanus.js ***!
  \***************************************************************/
/***/ ((module) => {

/**
 * Represents a handle to a single Janus plugin on a Janus session. Each WebRTC connection to the Janus server will be
 * associated with a single handle. Once attached to the server, this handle will be given a unique ID which should be
 * used to associate it with future signalling messages.
 *
 * See https://janus.conf.meetecho.com/docs/rest.html#handles.
 **/
function JanusPluginHandle(session) {
  this.session = session;
  this.id = undefined;
}

/** Attaches this handle to the Janus server and sets its ID. **/
JanusPluginHandle.prototype.attach = function(plugin, loop_index) {
  var payload = { plugin: plugin, loop_index: loop_index, "force-bundle": true, "force-rtcp-mux": true };
  return this.session.send("attach", payload).then(resp => {
    this.id = resp.data.id;
    return resp;
  });
};

/** Detaches this handle. **/
JanusPluginHandle.prototype.detach = function() {
  return this.send("detach");
};

/** Registers a callback to be fired upon the reception of any incoming Janus signals for this plugin handle with the
 * `janus` attribute equal to `ev`.
 **/
JanusPluginHandle.prototype.on = function(ev, callback) {
  return this.session.on(ev, signal => {
    if (signal.sender == this.id) {
      callback(signal);
    }
  });
};

/**
 * Sends a signal associated with this handle. Signals should be JSON-serializable objects. Returns a promise that will
 * be resolved or rejected when a response to this signal is received, or when no response is received within the
 * session timeout.
 **/
JanusPluginHandle.prototype.send = function(type, signal) {
  return this.session.send(type, Object.assign({ handle_id: this.id }, signal));
};

/** Sends a plugin-specific message associated with this handle. **/
JanusPluginHandle.prototype.sendMessage = function(body) {
  return this.send("message", { body: body });
};

/** Sends a JSEP offer or answer associated with this handle. **/
JanusPluginHandle.prototype.sendJsep = function(jsep) {
  return this.send("message", { body: {}, jsep: jsep });
};

/** Sends an ICE trickle candidate associated with this handle. **/
JanusPluginHandle.prototype.sendTrickle = function(candidate) {
  return this.send("trickle", { candidate: candidate });
};

/**
 * Represents a Janus session -- a Janus context from within which you can open multiple handles and connections. Once
 * created, this session will be given a unique ID which should be used to associate it with future signalling messages.
 *
 * See https://janus.conf.meetecho.com/docs/rest.html#sessions.
 **/
function JanusSession(output, options) {
  this.output = output;
  this.id = undefined;
  this.nextTxId = 0;
  this.txns = {};
  this.eventHandlers = {};
  this.options = Object.assign({
    verbose: false,
    timeoutMs: 10000,
    keepaliveMs: 30000
  }, options);
}

/** Creates this session on the Janus server and sets its ID. **/
JanusSession.prototype.create = function() {
  return this.send("create").then(resp => {
    this.id = resp.data.id;
    return resp;
  });
};

/**
 * Destroys this session. Note that upon destruction, Janus will also close the signalling transport (if applicable) and
 * any open WebRTC connections.
 **/
JanusSession.prototype.destroy = function() {
  return this.send("destroy").then((resp) => {
    this.dispose();
    return resp;
  });
};

/**
 * Disposes of this session in a way such that no further incoming signalling messages will be processed.
 * Outstanding transactions will be rejected.
 **/
JanusSession.prototype.dispose = function() {
  this._killKeepalive();
  this.eventHandlers = {};
  for (var txId in this.txns) {
    if (this.txns.hasOwnProperty(txId)) {
      var txn = this.txns[txId];
      clearTimeout(txn.timeout);
      txn.reject(new Error("Janus session was disposed."));
      delete this.txns[txId];
    }
  }
};

/**
 * Whether this signal represents an error, and the associated promise (if any) should be rejected.
 * Users should override this to handle any custom plugin-specific error conventions.
 **/
JanusSession.prototype.isError = function(signal) {
  return signal.janus === "error";
};

/** Registers a callback to be fired upon the reception of any incoming Janus signals for this session with the
 * `janus` attribute equal to `ev`.
 **/
JanusSession.prototype.on = function(ev, callback) {
  var handlers = this.eventHandlers[ev];
  if (handlers == null) {
    handlers = this.eventHandlers[ev] = [];
  }
  handlers.push(callback);
};

/**
 * Callback for receiving JSON signalling messages pertinent to this session. If the signals are responses to previously
 * sent signals, the promises for the outgoing signals will be resolved or rejected appropriately with this signal as an
 * argument.
 *
 * External callers should call this function every time a new signal arrives on the transport; for example, in a
 * WebSocket's `message` event, or when a new datum shows up in an HTTP long-polling response.
 **/
JanusSession.prototype.receive = function(signal) {
  if (this.options.verbose) {
    this._logIncoming(signal);
  }
  if (signal.session_id != this.id) {
    console.warn("Incorrect session ID received in Janus signalling message: was " + signal.session_id + ", expected " + this.id + ".");
  }

  var responseType = signal.janus;
  var handlers = this.eventHandlers[responseType];
  if (handlers != null) {
    for (var i = 0; i < handlers.length; i++) {
      handlers[i](signal);
    }
  }

  if (signal.transaction != null) {
    var txn = this.txns[signal.transaction];
    if (txn == null) {
      // this is a response to a transaction that wasn't caused via JanusSession.send, or a plugin replied twice to a
      // single request, or the session was disposed, or something else that isn't under our purview; that's fine
      return;
    }

    if (responseType === "ack" && txn.type == "message") {
      // this is an ack of an asynchronously-processed plugin request, we should wait to resolve the promise until the
      // actual response comes in
      return;
    }

    clearTimeout(txn.timeout);

    delete this.txns[signal.transaction];
    (this.isError(signal) ? txn.reject : txn.resolve)(signal);
  }
};

/**
 * Sends a signal associated with this session, beginning a new transaction. Returns a promise that will be resolved or
 * rejected when a response is received in the same transaction, or when no response is received within the session
 * timeout.
 **/
JanusSession.prototype.send = function(type, signal) {
  signal = Object.assign({ transaction: (this.nextTxId++).toString() }, signal);
  return new Promise((resolve, reject) => {
    var timeout = null;
    if (this.options.timeoutMs) {
      timeout = setTimeout(() => {
        delete this.txns[signal.transaction];
        reject(new Error("Signalling transaction with txid " + signal.transaction + " timed out."));
      }, this.options.timeoutMs);
    }
    this.txns[signal.transaction] = { resolve: resolve, reject: reject, timeout: timeout, type: type };
    this._transmit(type, signal);
  });
};

JanusSession.prototype._transmit = function(type, signal) {
  signal = Object.assign({ janus: type }, signal);

  if (this.id != null) { // this.id is undefined in the special case when we're sending the session create message
    signal = Object.assign({ session_id: this.id }, signal);
  }

  if (this.options.verbose) {
    this._logOutgoing(signal);
  }

  this.output(JSON.stringify(signal));
  this._resetKeepalive();
};

JanusSession.prototype._logOutgoing = function(signal) {
  var kind = signal.janus;
  if (kind === "message" && signal.jsep) {
    kind = signal.jsep.type;
  }
  var message = "> Outgoing Janus " + (kind || "signal") + " (#" + signal.transaction + "): ";
  console.debug("%c" + message, "color: #040", signal);
};

JanusSession.prototype._logIncoming = function(signal) {
  var kind = signal.janus;
  var message = signal.transaction ?
      "< Incoming Janus " + (kind || "signal") + " (#" + signal.transaction + "): " :
      "< Incoming Janus " + (kind || "signal") + ": ";
  console.debug("%c" + message, "color: #004", signal);
};

JanusSession.prototype._sendKeepalive = function() {
  return this.send("keepalive");
};

JanusSession.prototype._killKeepalive = function() {
  clearTimeout(this.keepaliveTimeout);
};

JanusSession.prototype._resetKeepalive = function() {
  this._killKeepalive();
  if (this.options.keepaliveMs) {
    this.keepaliveTimeout = setTimeout(() => {
      this._sendKeepalive().catch(e => console.error("Error received from keepalive: ", e));
    }, this.options.keepaliveMs);
  }
};

module.exports = {
  JanusPluginHandle,
  JanusSession
};


/***/ }),

/***/ "./src/index.js":
/*!**********************!*\
  !*** ./src/index.js ***!
  \**********************/
/***/ ((module, __unused_webpack_exports, __webpack_require__) => {

/* global NAF */
var mj = __webpack_require__(/*! @networked-aframe/minijanus */ "./node_modules/@networked-aframe/minijanus/minijanus.js");
mj.JanusSession.prototype.sendOriginal = mj.JanusSession.prototype.send;
mj.JanusSession.prototype.send = function (type, signal) {
  return this.sendOriginal(type, signal).catch(e => {
    if (e.message && e.message.indexOf("timed out") > -1) {
      console.error("web socket timed out");
      NAF.connection.adapter.reconnect();
    } else {
      throw e;
    }
  });
};
var sdpUtils = __webpack_require__(/*! sdp */ "./node_modules/sdp/sdp.js");
//var debug = require("debug")("naf-janus-adapter:debug");
//var warn = require("debug")("naf-janus-adapter:warn");
//var error = require("debug")("naf-janus-adapter:error");
var debug = console.log;
var warn = console.warn;
var error = console.error;
var isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
function debounce(fn) {
  var curr = Promise.resolve();
  return function () {
    var args = Array.prototype.slice.call(arguments);
    curr = curr.then(_ => fn.apply(this, args));
  };
}
function randomUint() {
  return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
}
function untilDataChannelOpen(dataChannel) {
  return new Promise((resolve, reject) => {
    if (dataChannel.readyState === "open") {
      resolve();
    } else {
      let resolver, rejector;
      const clear = () => {
        dataChannel.removeEventListener("open", resolver);
        dataChannel.removeEventListener("error", rejector);
      };
      resolver = () => {
        clear();
        resolve();
      };
      rejector = () => {
        clear();
        reject();
      };
      dataChannel.addEventListener("open", resolver);
      dataChannel.addEventListener("error", rejector);
    }
  });
}
const isH264VideoSupported = (() => {
  const video = document.createElement("video");
  return video.canPlayType('video/mp4; codecs="avc1.42E01E, mp4a.40.2"') !== "";
})();
const OPUS_PARAMETERS = {
  // indicates that we want to enable DTX to elide silence packets
  usedtx: 1,
  // indicates that we prefer to receive mono audio (important for voip profile)
  stereo: 0,
  // indicates that we prefer to send mono audio (important for voip profile)
  "sprop-stereo": 0
};
const DEFAULT_PEER_CONNECTION_CONFIG = {
  iceServers: [{
    urls: "stun:stun1.l.google.com:19302"
  }, {
    urls: "stun:stun2.l.google.com:19302"
  }]
};
const WS_NORMAL_CLOSURE = 1000;
class JanusAdapter {
  constructor() {
    this.room = null;
    // We expect the consumer to set a client id before connecting.
    this.clientId = null;
    this.joinToken = null;
    this.serverUrl = null;
    this.webRtcOptions = {};
    this.peerConnectionConfig = null;
    this.ws = null;
    this.session = null;
    this.reliableTransport = "datachannel";
    this.unreliableTransport = "datachannel";

    // In the event the server restarts and all clients lose connection, reconnect with
    // some random jitter added to prevent simultaneous reconnection requests.
    this.initialReconnectionDelay = 1000 * Math.random();
    this.reconnectionDelay = this.initialReconnectionDelay;
    this.reconnectionTimeout = null;
    this.maxReconnectionAttempts = 10;
    this.reconnectionAttempts = 0;
    this.publisher = null;
    this.occupants = {};
    this.leftOccupants = new Set();
    this.mediaStreams = {};
    this.localMediaStream = null;
    this.pendingMediaRequests = new Map();
    this.blockedClients = new Map();
    this.frozenUpdates = new Map();
    this.timeOffsets = [];
    this.serverTimeRequests = 0;
    this.avgTimeOffset = 0;
    this.onWebsocketOpen = this.onWebsocketOpen.bind(this);
    this.onWebsocketClose = this.onWebsocketClose.bind(this);
    this.onWebsocketMessage = this.onWebsocketMessage.bind(this);
    this.onDataChannelMessage = this.onDataChannelMessage.bind(this);
    this.onData = this.onData.bind(this);
  }
  setServerUrl(url) {
    this.serverUrl = url;
  }
  setApp(app) {}
  setRoom(roomName) {
    this.room = roomName;
  }
  setJoinToken(joinToken) {
    this.joinToken = joinToken;
  }
  setClientId(clientId) {
    this.clientId = clientId;
  }
  setWebRtcOptions(options) {
    this.webRtcOptions = options;
  }
  setPeerConnectionConfig(peerConnectionConfig) {
    this.peerConnectionConfig = peerConnectionConfig;
  }
  setServerConnectListeners(successListener, failureListener) {
    this.connectSuccess = successListener;
    this.connectFailure = failureListener;
  }
  setRoomOccupantListener(occupantListener) {
    if (this.onOccupantsChanged) {
      this.onOccupantsChanged.push(occupantListener);
      return;
    }
    this.onOccupantsChanged = [occupantListener];
  }
  setDataChannelListeners(openListener, closedListener, messageListener) {
    this.onOccupantConnected = openListener;
    this.onOccupantDisconnected = closedListener;
    this.onOccupantMessage = messageListener;
  }
  setReconnectionListeners(reconnectingListener, reconnectedListener, reconnectionErrorListener) {
    // onReconnecting is called with the number of milliseconds until the next reconnection attempt
    this.onReconnecting = reconnectingListener;
    // onReconnected is called when the connection has been reestablished
    this.onReconnected = reconnectedListener;
    // onReconnectionError is called with an error when maxReconnectionAttempts has been reached
    this.onReconnectionError = reconnectionErrorListener;
  }
  setEventLoops(loops) {
    this.loops = loops;
  }
  connect() {
    debug(`connecting to ${this.serverUrl}`);
    const websocketConnection = new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.serverUrl, "janus-protocol");
      this.session = new mj.JanusSession(this.ws.send.bind(this.ws), {
        timeoutMs: 40000
      });
      this.ws.addEventListener("close", this.onWebsocketClose);
      this.ws.addEventListener("message", this.onWebsocketMessage);
      this.wsOnOpen = () => {
        this.ws.removeEventListener("open", this.wsOnOpen);
        this.onWebsocketOpen().then(resolve).catch(reject);
      };
      this.ws.addEventListener("open", this.wsOnOpen);
    });
    return Promise.all([websocketConnection, this.updateTimeOffset()]);
  }
  disconnect() {
    debug(`disconnecting`);
    clearTimeout(this.reconnectionTimeout);
    this.removeAllOccupants();
    this.leftOccupants = new Set();
    if (this.publisher) {
      // Close the publisher peer connection. Which also detaches the plugin handle.
      this.publisher.conn.close();
      this.publisher = null;
    }
    if (this.session) {
      this.session.dispose();
      this.session = null;
    }
    if (this.ws) {
      this.ws.removeEventListener("open", this.wsOnOpen);
      this.ws.removeEventListener("close", this.onWebsocketClose);
      this.ws.removeEventListener("message", this.onWebsocketMessage);
      this.ws.close();
      this.ws = null;
    }

    // Now that all RTCPeerConnection closed, be sure to not call
    // reconnect() again via performDelayedReconnect if previous
    // RTCPeerConnection was in the failed state.
    if (this.delayedReconnectTimeout) {
      clearTimeout(this.delayedReconnectTimeout);
      this.delayedReconnectTimeout = null;
    }
  }
  isDisconnected() {
    return this.ws === null;
  }
  async onWebsocketOpen() {
    // Create the Janus Session
    await this.session.create();

    // Attach the SFU Plugin and create a RTCPeerConnection for the publisher.
    // The publisher sends audio and opens two bidirectional data channels.
    // One reliable datachannel and one unreliable.
    this.publisher = await this.createPublisher();

    // Call the naf connectSuccess callback before we start receiving WebRTC messages.
    this.connectSuccess(this.clientId);
    for (let i = 0; i < this.publisher.initialOccupants.length; i++) {
      const occupantId = this.publisher.initialOccupants[i];
      if (occupantId === this.clientId) continue; // Happens during non-graceful reconnects due to zombie sessions

      await this.addOccupant(occupantId);
    }
  }
  onWebsocketClose(event) {
    // The connection was closed successfully. Don't try to reconnect.
    if (event.code === WS_NORMAL_CLOSURE) {
      return;
    }
    console.warn("Janus websocket closed unexpectedly.");
    if (this.onReconnecting) {
      this.onReconnecting(this.reconnectionDelay);
    }
    this.reconnectionTimeout = setTimeout(() => this.reconnect(), this.reconnectionDelay);
  }
  reconnect() {
    // Dispose of all networked entities and other resources tied to the session.
    this.disconnect();
    this.connect().then(() => {
      this.reconnectionDelay = this.initialReconnectionDelay;
      this.reconnectionAttempts = 0;
      if (this.onReconnected) {
        this.onReconnected();
      }
    }).catch(error => {
      this.reconnectionDelay += 1000;
      this.reconnectionAttempts++;
      if (this.reconnectionAttempts > this.maxReconnectionAttempts && this.onReconnectionError) {
        return this.onReconnectionError(new Error("Connection could not be reestablished, exceeded maximum number of reconnection attempts."));
      }
      console.warn("Error during reconnect, retrying.");
      console.warn(error);
      if (this.onReconnecting) {
        this.onReconnecting(this.reconnectionDelay);
      }
      this.reconnectionTimeout = setTimeout(() => this.reconnect(), this.reconnectionDelay);
    });
  }
  performDelayedReconnect() {
    if (this.delayedReconnectTimeout) {
      clearTimeout(this.delayedReconnectTimeout);
    }
    this.delayedReconnectTimeout = setTimeout(() => {
      this.delayedReconnectTimeout = null;
      this.reconnect();
    }, 10000);
  }
  onWebsocketMessage(event) {
    this.session.receive(JSON.parse(event.data));
  }
  async addOccupant(occupantId) {
    if (this.occupants[occupantId]) {
      this.removeOccupant(occupantId);
    }
    this.leftOccupants.delete(occupantId);
    var subscriber = await this.createSubscriber(occupantId);
    if (!subscriber) return;
    this.occupants[occupantId] = subscriber;
    this.setMediaStream(occupantId, subscriber.mediaStream);

    // Call the Networked AFrame callbacks for the new occupant.
    this.onOccupantConnected(occupantId);
    this.onOccupantsChanged.forEach(listener => listener(this.occupants));
    return subscriber;
  }
  removeAllOccupants() {
    for (const occupantId of Object.getOwnPropertyNames(this.occupants)) {
      this.removeOccupant(occupantId);
    }
  }
  removeOccupant(occupantId) {
    this.leftOccupants.add(occupantId);
    if (this.occupants[occupantId]) {
      // Close the subscriber peer connection. Which also detaches the plugin handle.
      this.occupants[occupantId].conn.close();
      delete this.occupants[occupantId];
    }
    if (this.mediaStreams[occupantId]) {
      delete this.mediaStreams[occupantId];
    }
    if (this.pendingMediaRequests.has(occupantId)) {
      const msg = "The user disconnected before the media stream was resolved.";
      this.pendingMediaRequests.get(occupantId).audio.reject(msg);
      this.pendingMediaRequests.get(occupantId).video.reject(msg);
      this.pendingMediaRequests.delete(occupantId);
    }

    // Call the Networked AFrame callbacks for the removed occupant.
    this.onOccupantDisconnected(occupantId);
    this.onOccupantsChanged.forEach(listener => listener(this.occupants));
  }
  associate(conn, handle) {
    conn.addEventListener("icecandidate", ev => {
      handle.sendTrickle(ev.candidate || null).catch(e => error("Error trickling ICE: %o", e));
    });
    conn.addEventListener("iceconnectionstatechange", ev => {
      if (conn.iceConnectionState === "connected") {
        console.log("ICE state changed to connected");
      }
      if (conn.iceConnectionState === "disconnected") {
        console.warn("ICE state changed to disconnected");
      }
      if (conn.iceConnectionState === "failed") {
        console.warn("ICE failure detected. Reconnecting in 10s.");
        this.performDelayedReconnect();
      }
    });

    // we have to debounce these because janus gets angry if you send it a new SDP before
    // it's finished processing an existing SDP. in actuality, it seems like this is maybe
    // too liberal and we need to wait some amount of time after an offer before sending another,
    // but we don't currently know any good way of detecting exactly how long :(
    conn.addEventListener("negotiationneeded", debounce(ev => {
      debug("Sending new offer for handle: %o", handle);
      var offer = conn.createOffer().then(this.configurePublisherSdp).then(this.fixSafariIceUFrag);
      var local = offer.then(o => conn.setLocalDescription(o));
      var remote = offer;
      remote = remote.then(this.fixSafariIceUFrag).then(j => handle.sendJsep(j)).then(r => conn.setRemoteDescription(r.jsep));
      return Promise.all([local, remote]).catch(e => error("Error negotiating offer: %o", e));
    }));
    handle.on("event", debounce(ev => {
      var jsep = ev.jsep;
      if (jsep && jsep.type == "offer") {
        debug("Accepting new offer for handle: %o", handle);
        var answer = conn.setRemoteDescription(this.configureSubscriberSdp(jsep)).then(_ => conn.createAnswer()).then(this.fixSafariIceUFrag);
        var local = answer.then(a => conn.setLocalDescription(a));
        var remote = answer.then(j => handle.sendJsep(j));
        return Promise.all([local, remote]).catch(e => error("Error negotiating answer: %o", e));
      } else {
        // some other kind of event, nothing to do
        return null;
      }
    }));
  }
  async createPublisher() {
    var handle = new mj.JanusPluginHandle(this.session);
    var conn = new RTCPeerConnection(this.peerConnectionConfig || DEFAULT_PEER_CONNECTION_CONFIG);
    debug("pub waiting for sfu");
    await handle.attach("janus.plugin.sfu", this.loops && this.clientId ? parseInt(this.clientId) % this.loops : undefined);
    this.associate(conn, handle);
    debug("pub waiting for data channels & webrtcup");
    var webrtcup = new Promise(resolve => handle.on("webrtcup", resolve));

    // Unreliable datachannel: sending and receiving component updates.
    // Reliable datachannel: sending and recieving entity instantiations.
    var reliableChannel = conn.createDataChannel("reliable", {
      ordered: true
    });
    var unreliableChannel = conn.createDataChannel("unreliable", {
      ordered: false,
      maxRetransmits: 0
    });
    reliableChannel.addEventListener("message", e => this.onDataChannelMessage(e, "janus-reliable"));
    unreliableChannel.addEventListener("message", e => this.onDataChannelMessage(e, "janus-unreliable"));
    await webrtcup;
    await untilDataChannelOpen(reliableChannel);
    await untilDataChannelOpen(unreliableChannel);

    // doing this here is sort of a hack around chrome renegotiation weirdness --
    // if we do it prior to webrtcup, chrome on gear VR will sometimes put a
    // renegotiation offer in flight while the first offer was still being
    // processed by janus. we should find some more principled way to figure out
    // when janus is done in the future.
    if (this.localMediaStream) {
      this.localMediaStream.getTracks().forEach(track => {
        conn.addTrack(track, this.localMediaStream);
      });
    }

    // Handle all of the join and leave events.
    handle.on("event", ev => {
      var data = ev.plugindata.data;
      if (data.event == "join" && data.room_id == this.room) {
        if (this.delayedReconnectTimeout) {
          // Don't create a new RTCPeerConnection, all RTCPeerConnection will be closed in less than 10s.
          return;
        }
        this.addOccupant(data.user_id);
      } else if (data.event == "leave" && data.room_id == this.room) {
        this.removeOccupant(data.user_id);
      } else if (data.event == "blocked") {
        document.body.dispatchEvent(new CustomEvent("blocked", {
          detail: {
            clientId: data.by
          }
        }));
      } else if (data.event == "unblocked") {
        document.body.dispatchEvent(new CustomEvent("unblocked", {
          detail: {
            clientId: data.by
          }
        }));
      } else if (data.event === "data") {
        this.onData(JSON.parse(data.body), "janus-event");
      }
    });
    debug("pub waiting for join");

    // Send join message to janus. Listen for join/leave messages. Automatically subscribe to all users' WebRTC data.
    var message = await this.sendJoin(handle, {
      notifications: true,
      data: true
    });
    if (!message.plugindata.data.success) {
      const err = message.plugindata.data.error;
      console.error(err);
      // We may get here because of an expired JWT.
      // Close the connection ourself otherwise janus will close it after
      // session_timeout because we didn't send any keepalive and this will
      // trigger a delayed reconnect because of the iceconnectionstatechange
      // listener for failure state.
      // Even if the app code calls disconnect in case of error, disconnect
      // won't close the peer connection because this.publisher is not set.
      conn.close();
      throw err;
    }
    var initialOccupants = message.plugindata.data.response.users[this.room] || [];
    if (initialOccupants.includes(this.clientId)) {
      console.warn("Janus still has previous session for this client. Reconnecting in 10s.");
      this.performDelayedReconnect();
    }
    debug("publisher ready");
    return {
      handle,
      initialOccupants,
      reliableChannel,
      unreliableChannel,
      conn
    };
  }
  configurePublisherSdp(jsep) {
    jsep.sdp = jsep.sdp.replace(/a=fmtp:(109|111).*\r\n/g, (line, pt) => {
      const parameters = Object.assign(sdpUtils.parseFmtp(line), OPUS_PARAMETERS);
      return sdpUtils.writeFmtp({
        payloadType: pt,
        parameters: parameters
      });
    });
    return jsep;
  }
  configureSubscriberSdp(jsep) {
    // todo: consider cleaning up these hacks to use sdputils
    if (!isH264VideoSupported) {
      if (navigator.userAgent.indexOf("HeadlessChrome") !== -1) {
        // HeadlessChrome (e.g. puppeteer) doesn't support webrtc video streams, so we remove those lines from the SDP.
        jsep.sdp = jsep.sdp.replace(/m=video[^]*m=/, "m=");
      }
    }

    // TODO: Hack to get video working on Chrome for Android. https://groups.google.com/forum/#!topic/mozilla.dev.media/Ye29vuMTpo8
    if (navigator.userAgent.indexOf("Android") === -1) {
      jsep.sdp = jsep.sdp.replace("a=rtcp-fb:107 goog-remb\r\n", "a=rtcp-fb:107 goog-remb\r\na=rtcp-fb:107 transport-cc\r\na=fmtp:107 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f\r\n");
    } else {
      jsep.sdp = jsep.sdp.replace("a=rtcp-fb:107 goog-remb\r\n", "a=rtcp-fb:107 goog-remb\r\na=rtcp-fb:107 transport-cc\r\na=fmtp:107 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f\r\n");
    }
    return jsep;
  }
  async fixSafariIceUFrag(jsep) {
    // Safari produces a \n instead of an \r\n for the ice-ufrag. See https://github.com/meetecho/janus-gateway/issues/1818
    jsep.sdp = jsep.sdp.replace(/[^\r]\na=ice-ufrag/g, "\r\na=ice-ufrag");
    return jsep;
  }
  async createSubscriber(occupantId, maxRetries = 5) {
    if (this.leftOccupants.has(occupantId)) {
      console.warn(occupantId + ": cancelled occupant connection, occupant left before subscription negotation.");
      return null;
    }
    var handle = new mj.JanusPluginHandle(this.session);
    var conn = new RTCPeerConnection(this.peerConnectionConfig || DEFAULT_PEER_CONNECTION_CONFIG);
    debug(occupantId + ": sub waiting for sfu");
    await handle.attach("janus.plugin.sfu", this.loops ? parseInt(occupantId) % this.loops : undefined);
    this.associate(conn, handle);
    debug(occupantId + ": sub waiting for join");
    if (this.leftOccupants.has(occupantId)) {
      conn.close();
      console.warn(occupantId + ": cancelled occupant connection, occupant left after attach");
      return null;
    }

    // Send join message to janus. Don't listen for join/leave messages. Subscribe to the occupant's media.
    // Janus should send us an offer for this occupant's media in response to this.
    await this.sendJoin(handle, {
      media: occupantId
    });
    if (this.leftOccupants.has(occupantId)) {
      conn.close();
      console.warn(occupantId + ": cancelled occupant connection, occupant left after join");
      return null;
    }
    debug(occupantId + ": sub waiting for webrtcup");
    await new Promise(resolve => {
      const interval = setInterval(() => {
        if (this.leftOccupants.has(occupantId)) {
          clearInterval(interval);
          resolve();
        }
      }, 1000);
      handle.on("webrtcup", () => {
        clearInterval(interval);
        resolve();
      });
    });
    if (this.leftOccupants.has(occupantId)) {
      conn.close();
      console.warn(occupantId + ": cancel occupant connection, occupant left during or after webrtcup");
      return null;
    }
    if (isSafari && !this._iOSHackDelayedInitialPeer) {
      // HACK: the first peer on Safari during page load can fail to work if we don't
      // wait some time before continuing here. See: https://github.com/mozilla/hubs/pull/1692
      await new Promise(resolve => setTimeout(resolve, 3000));
      this._iOSHackDelayedInitialPeer = true;
    }
    var mediaStream = new MediaStream();
    var receivers = conn.getReceivers();
    receivers.forEach(receiver => {
      if (receiver.track) {
        mediaStream.addTrack(receiver.track);
      }
    });
    if (mediaStream.getTracks().length === 0) {
      mediaStream = null;
    }
    debug(occupantId + ": subscriber ready");
    return {
      handle,
      mediaStream,
      conn
    };
  }
  sendJoin(handle, subscribe) {
    return handle.sendMessage({
      kind: "join",
      room_id: this.room,
      user_id: this.clientId,
      subscribe,
      token: this.joinToken
    });
  }
  toggleFreeze() {
    if (this.frozen) {
      this.unfreeze();
    } else {
      this.freeze();
    }
  }
  freeze() {
    this.frozen = true;
  }
  unfreeze() {
    this.frozen = false;
    this.flushPendingUpdates();
  }
  dataForUpdateMultiMessage(networkId, message) {
    // "d" is an array of entity datas, where each item in the array represents a unique entity and contains
    // metadata for the entity, and an array of components that have been updated on the entity.
    // This method finds the data corresponding to the given networkId.
    for (let i = 0, l = message.data.d.length; i < l; i++) {
      const data = message.data.d[i];
      if (data.networkId === networkId) {
        return data;
      }
    }
    return null;
  }
  getPendingData(networkId, message) {
    if (!message) return null;
    let data = message.dataType === "um" ? this.dataForUpdateMultiMessage(networkId, message) : message.data;

    // Ignore messages relating to users who have disconnected since freezing, their entities
    // will have aleady been removed by NAF.
    // Note that delete messages have no "owner" so we have to check for that as well.
    if (data.owner && !this.occupants[data.owner]) return null;

    // Ignore messages from users that we may have blocked while frozen.
    if (data.owner && this.blockedClients.has(data.owner)) return null;
    return data;
  }

  // Used externally
  getPendingDataForNetworkId(networkId) {
    return this.getPendingData(networkId, this.frozenUpdates.get(networkId));
  }
  flushPendingUpdates() {
    for (const [networkId, message] of this.frozenUpdates) {
      let data = this.getPendingData(networkId, message);
      if (!data) continue;

      // Override the data type on "um" messages types, since we extract entity updates from "um" messages into
      // individual frozenUpdates in storeSingleMessage.
      const dataType = message.dataType === "um" ? "u" : message.dataType;
      this.onOccupantMessage(null, dataType, data, message.source);
    }
    this.frozenUpdates.clear();
  }
  storeMessage(message) {
    if (message.dataType === "um") {
      // UpdateMulti
      for (let i = 0, l = message.data.d.length; i < l; i++) {
        this.storeSingleMessage(message, i);
      }
    } else {
      this.storeSingleMessage(message);
    }
  }
  storeSingleMessage(message, index) {
    const data = index !== undefined ? message.data.d[index] : message.data;
    const dataType = message.dataType;
    const source = message.source;
    const networkId = data.networkId;
    if (!this.frozenUpdates.has(networkId)) {
      this.frozenUpdates.set(networkId, message);
    } else {
      const storedMessage = this.frozenUpdates.get(networkId);
      const storedData = storedMessage.dataType === "um" ? this.dataForUpdateMultiMessage(networkId, storedMessage) : storedMessage.data;

      // Avoid updating components if the entity data received did not come from the current owner.
      const isOutdatedMessage = data.lastOwnerTime < storedData.lastOwnerTime;
      const isContemporaneousMessage = data.lastOwnerTime === storedData.lastOwnerTime;
      if (isOutdatedMessage || isContemporaneousMessage && storedData.owner > data.owner) {
        return;
      }
      if (dataType === "r") {
        const createdWhileFrozen = storedData && storedData.isFirstSync;
        if (createdWhileFrozen) {
          // If the entity was created and deleted while frozen, don't bother conveying anything to the consumer.
          this.frozenUpdates.delete(networkId);
        } else {
          // Delete messages override any other messages for this entity
          this.frozenUpdates.set(networkId, message);
        }
      } else {
        // merge in component updates
        if (storedData.components && data.components) {
          Object.assign(storedData.components, data.components);
        }
      }
    }
  }
  onDataChannelMessage(e, source) {
    this.onData(JSON.parse(e.data), source);
  }
  onData(message, source) {
    if (debug.enabled) {
      debug(`DC in: ${message}`);
    }
    if (!message.dataType) return;
    message.source = source;
    if (this.frozen) {
      this.storeMessage(message);
    } else {
      this.onOccupantMessage(null, message.dataType, message.data, message.source);
    }
  }
  shouldStartConnectionTo(client) {
    return true;
  }
  startStreamConnection(client) {}
  closeStreamConnection(client) {}
  getConnectStatus(clientId) {
    return this.occupants[clientId] ? NAF.adapters.IS_CONNECTED : NAF.adapters.NOT_CONNECTED;
  }
  async updateTimeOffset() {
    if (this.isDisconnected()) return;
    const clientSentTime = Date.now();
    const res = await fetch(document.location.href, {
      method: "HEAD",
      cache: "no-cache"
    });
    const precision = 1000;
    const serverReceivedTime = new Date(res.headers.get("Date")).getTime() + precision / 2;
    const clientReceivedTime = Date.now();
    const serverTime = serverReceivedTime + (clientReceivedTime - clientSentTime) / 2;
    const timeOffset = serverTime - clientReceivedTime;
    this.serverTimeRequests++;
    if (this.serverTimeRequests <= 10) {
      this.timeOffsets.push(timeOffset);
    } else {
      this.timeOffsets[this.serverTimeRequests % 10] = timeOffset;
    }
    this.avgTimeOffset = this.timeOffsets.reduce((acc, offset) => acc += offset, 0) / this.timeOffsets.length;
    if (this.serverTimeRequests > 10) {
      debug(`new server time offset: ${this.avgTimeOffset}ms`);
      setTimeout(() => this.updateTimeOffset(), 5 * 60 * 1000); // Sync clock every 5 minutes.
    } else {
      this.updateTimeOffset();
    }
  }
  getServerTime() {
    return Date.now() + this.avgTimeOffset;
  }
  getMediaStream(clientId, type = "audio") {
    if (this.mediaStreams[clientId]) {
      debug(`Already had ${type} for ${clientId}`);
      return Promise.resolve(this.mediaStreams[clientId][type]);
    } else {
      debug(`Waiting on ${type} for ${clientId}`);
      if (!this.pendingMediaRequests.has(clientId)) {
        this.pendingMediaRequests.set(clientId, {});
        const audioPromise = new Promise((resolve, reject) => {
          this.pendingMediaRequests.get(clientId).audio = {
            resolve,
            reject
          };
        });
        const videoPromise = new Promise((resolve, reject) => {
          this.pendingMediaRequests.get(clientId).video = {
            resolve,
            reject
          };
        });
        this.pendingMediaRequests.get(clientId).audio.promise = audioPromise;
        this.pendingMediaRequests.get(clientId).video.promise = videoPromise;
        audioPromise.catch(e => console.warn(`${clientId} getMediaStream Audio Error`, e));
        videoPromise.catch(e => console.warn(`${clientId} getMediaStream Video Error`, e));
      }
      return this.pendingMediaRequests.get(clientId)[type].promise;
    }
  }
  setMediaStream(clientId, stream) {
    // Safari doesn't like it when you use single a mixed media stream where one of the tracks is inactive, so we
    // split the tracks into two streams.
    const audioStream = new MediaStream();
    try {
      stream.getAudioTracks().forEach(track => audioStream.addTrack(track));
    } catch (e) {
      console.warn(`${clientId} setMediaStream Audio Error`, e);
    }
    const videoStream = new MediaStream();
    try {
      stream.getVideoTracks().forEach(track => videoStream.addTrack(track));
    } catch (e) {
      console.warn(`${clientId} setMediaStream Video Error`, e);
    }
    this.mediaStreams[clientId] = {
      audio: audioStream,
      video: videoStream
    };

    // Resolve the promise for the user's media stream if it exists.
    if (this.pendingMediaRequests.has(clientId)) {
      this.pendingMediaRequests.get(clientId).audio.resolve(audioStream);
      this.pendingMediaRequests.get(clientId).video.resolve(videoStream);
    }
  }
  getLocalMediaStream() {
    return this.localMediaStream;
  }
  async setLocalMediaStream(stream) {
    // our job here is to make sure the connection winds up with RTP senders sending the stuff in this stream,
    // and not the stuff that isn't in this stream. strategy is to replace existing tracks if we can, add tracks
    // that we can't replace, and disable tracks that don't exist anymore.

    // note that we don't ever remove a track from the stream -- since Janus doesn't support Unified Plan, we absolutely
    // can't wind up with a SDP that has >1 audio or >1 video tracks, even if one of them is inactive (what you get if
    // you remove a track from an existing stream.)
    if (this.publisher && this.publisher.conn) {
      const existingSenders = this.publisher.conn.getSenders();
      const newSenders = [];
      const tracks = stream.getTracks();
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i];
        const sender = existingSenders.find(s => s.track != null && s.track.kind == t.kind);
        if (sender != null) {
          if (sender.replaceTrack) {
            await sender.replaceTrack(t);
          } else {
            // Fallback for browsers that don't support replaceTrack. At this time of this writing
            // most browsers support it, and testing this code path seems to not work properly
            // in Chrome anymore.
            stream.removeTrack(sender.track);
            stream.addTrack(t);
          }
          newSenders.push(sender);
        } else {
          newSenders.push(this.publisher.conn.addTrack(t, stream));
        }
      }
      existingSenders.forEach(s => {
        if (!newSenders.includes(s)) {
          s.track.enabled = false;
        }
      });
    }
    this.localMediaStream = stream;
    this.setMediaStream(this.clientId, stream);
  }
  enableMicrophone(enabled) {
    if (this.publisher && this.publisher.conn) {
      this.publisher.conn.getSenders().forEach(s => {
        if (s.track.kind == "audio") {
          s.track.enabled = enabled;
        }
      });
    }
  }
  sendData(clientId, dataType, data) {
    if (!this.publisher) {
      console.warn("sendData called without a publisher");
    } else {
      switch (this.unreliableTransport) {
        case "websocket":
          if (this.ws.readyState === 1) {
            // OPEN
            this.publisher.handle.sendMessage({
              kind: "data",
              body: JSON.stringify({
                dataType,
                data
              }),
              whom: clientId
            });
          }
          break;
        case "datachannel":
          if (this.publisher.unreliableChannel.readyState === "open") {
            this.publisher.unreliableChannel.send(JSON.stringify({
              clientId,
              dataType,
              data
            }));
          }
          break;
        default:
          this.unreliableTransport(clientId, dataType, data);
          break;
      }
    }
  }
  sendDataGuaranteed(clientId, dataType, data) {
    if (!this.publisher) {
      console.warn("sendDataGuaranteed called without a publisher");
    } else {
      switch (this.reliableTransport) {
        case "websocket":
          if (this.ws.readyState === 1) {
            // OPEN
            this.publisher.handle.sendMessage({
              kind: "data",
              body: JSON.stringify({
                dataType,
                data
              }),
              whom: clientId
            });
          }
          break;
        case "datachannel":
          if (this.publisher.reliableChannel.readyState === "open") {
            this.publisher.reliableChannel.send(JSON.stringify({
              clientId,
              dataType,
              data
            }));
          }
          break;
        default:
          this.reliableTransport(clientId, dataType, data);
          break;
      }
    }
  }
  broadcastData(dataType, data) {
    if (!this.publisher) {
      console.warn("broadcastData called without a publisher");
    } else {
      switch (this.unreliableTransport) {
        case "websocket":
          if (this.ws.readyState === 1) {
            // OPEN
            this.publisher.handle.sendMessage({
              kind: "data",
              body: JSON.stringify({
                dataType,
                data
              })
            });
          }
          break;
        case "datachannel":
          if (this.publisher.unreliableChannel.readyState === "open") {
            this.publisher.unreliableChannel.send(JSON.stringify({
              dataType,
              data
            }));
          }
          break;
        default:
          this.unreliableTransport(undefined, dataType, data);
          break;
      }
    }
  }
  broadcastDataGuaranteed(dataType, data) {
    if (!this.publisher) {
      console.warn("broadcastDataGuaranteed called without a publisher");
    } else {
      switch (this.reliableTransport) {
        case "websocket":
          if (this.ws.readyState === 1) {
            // OPEN
            this.publisher.handle.sendMessage({
              kind: "data",
              body: JSON.stringify({
                dataType,
                data
              })
            });
          }
          break;
        case "datachannel":
          if (this.publisher.reliableChannel.readyState === "open") {
            this.publisher.reliableChannel.send(JSON.stringify({
              dataType,
              data
            }));
          }
          break;
        default:
          this.reliableTransport(undefined, dataType, data);
          break;
      }
    }
  }
  kick(clientId, permsToken) {
    return this.publisher.handle.sendMessage({
      kind: "kick",
      room_id: this.room,
      user_id: clientId,
      token: permsToken
    }).then(() => {
      document.body.dispatchEvent(new CustomEvent("kicked", {
        detail: {
          clientId: clientId
        }
      }));
    });
  }
  block(clientId) {
    return this.publisher.handle.sendMessage({
      kind: "block",
      whom: clientId
    }).then(() => {
      this.blockedClients.set(clientId, true);
      document.body.dispatchEvent(new CustomEvent("blocked", {
        detail: {
          clientId: clientId
        }
      }));
    });
  }
  unblock(clientId) {
    return this.publisher.handle.sendMessage({
      kind: "unblock",
      whom: clientId
    }).then(() => {
      this.blockedClients.delete(clientId);
      document.body.dispatchEvent(new CustomEvent("unblocked", {
        detail: {
          clientId: clientId
        }
      }));
    });
  }
}
NAF.adapters.register("janus", JanusAdapter);
module.exports = JanusAdapter;

/***/ }),

/***/ "./node_modules/sdp/sdp.js":
/*!*********************************!*\
  !*** ./node_modules/sdp/sdp.js ***!
  \*********************************/
/***/ ((module) => {

"use strict";
/* eslint-env node */


// SDP helpers.
const SDPUtils = {};

// Generate an alphanumeric identifier for cname or mids.
// TODO: use UUIDs instead? https://gist.github.com/jed/982883
SDPUtils.generateIdentifier = function() {
  return Math.random().toString(36).substring(2, 12);
};

// The RTCP CNAME used by all peerconnections from the same JS.
SDPUtils.localCName = SDPUtils.generateIdentifier();

// Splits SDP into lines, dealing with both CRLF and LF.
SDPUtils.splitLines = function(blob) {
  return blob.trim().split('\n').map(line => line.trim());
};
// Splits SDP into sessionpart and mediasections. Ensures CRLF.
SDPUtils.splitSections = function(blob) {
  const parts = blob.split('\nm=');
  return parts.map((part, index) => (index > 0 ?
    'm=' + part : part).trim() + '\r\n');
};

// Returns the session description.
SDPUtils.getDescription = function(blob) {
  const sections = SDPUtils.splitSections(blob);
  return sections && sections[0];
};

// Returns the individual media sections.
SDPUtils.getMediaSections = function(blob) {
  const sections = SDPUtils.splitSections(blob);
  sections.shift();
  return sections;
};

// Returns lines that start with a certain prefix.
SDPUtils.matchPrefix = function(blob, prefix) {
  return SDPUtils.splitLines(blob).filter(line => line.indexOf(prefix) === 0);
};

// Parses an ICE candidate line. Sample input:
// candidate:702786350 2 udp 41819902 8.8.8.8 60769 typ relay raddr 8.8.8.8
// rport 55996"
// Input can be prefixed with a=.
SDPUtils.parseCandidate = function(line) {
  let parts;
  // Parse both variants.
  if (line.indexOf('a=candidate:') === 0) {
    parts = line.substring(12).split(' ');
  } else {
    parts = line.substring(10).split(' ');
  }

  const candidate = {
    foundation: parts[0],
    component: {1: 'rtp', 2: 'rtcp'}[parts[1]] || parts[1],
    protocol: parts[2].toLowerCase(),
    priority: parseInt(parts[3], 10),
    ip: parts[4],
    address: parts[4], // address is an alias for ip.
    port: parseInt(parts[5], 10),
    // skip parts[6] == 'typ'
    type: parts[7],
  };

  for (let i = 8; i < parts.length; i += 2) {
    switch (parts[i]) {
      case 'raddr':
        candidate.relatedAddress = parts[i + 1];
        break;
      case 'rport':
        candidate.relatedPort = parseInt(parts[i + 1], 10);
        break;
      case 'tcptype':
        candidate.tcpType = parts[i + 1];
        break;
      case 'ufrag':
        candidate.ufrag = parts[i + 1]; // for backward compatibility.
        candidate.usernameFragment = parts[i + 1];
        break;
      default: // extension handling, in particular ufrag. Don't overwrite.
        if (candidate[parts[i]] === undefined) {
          candidate[parts[i]] = parts[i + 1];
        }
        break;
    }
  }
  return candidate;
};

// Translates a candidate object into SDP candidate attribute.
// This does not include the a= prefix!
SDPUtils.writeCandidate = function(candidate) {
  const sdp = [];
  sdp.push(candidate.foundation);

  const component = candidate.component;
  if (component === 'rtp') {
    sdp.push(1);
  } else if (component === 'rtcp') {
    sdp.push(2);
  } else {
    sdp.push(component);
  }
  sdp.push(candidate.protocol.toUpperCase());
  sdp.push(candidate.priority);
  sdp.push(candidate.address || candidate.ip);
  sdp.push(candidate.port);

  const type = candidate.type;
  sdp.push('typ');
  sdp.push(type);
  if (type !== 'host' && candidate.relatedAddress &&
      candidate.relatedPort) {
    sdp.push('raddr');
    sdp.push(candidate.relatedAddress);
    sdp.push('rport');
    sdp.push(candidate.relatedPort);
  }
  if (candidate.tcpType && candidate.protocol.toLowerCase() === 'tcp') {
    sdp.push('tcptype');
    sdp.push(candidate.tcpType);
  }
  if (candidate.usernameFragment || candidate.ufrag) {
    sdp.push('ufrag');
    sdp.push(candidate.usernameFragment || candidate.ufrag);
  }
  return 'candidate:' + sdp.join(' ');
};

// Parses an ice-options line, returns an array of option tags.
// Sample input:
// a=ice-options:foo bar
SDPUtils.parseIceOptions = function(line) {
  return line.substring(14).split(' ');
};

// Parses a rtpmap line, returns RTCRtpCoddecParameters. Sample input:
// a=rtpmap:111 opus/48000/2
SDPUtils.parseRtpMap = function(line) {
  let parts = line.substring(9).split(' ');
  const parsed = {
    payloadType: parseInt(parts.shift(), 10), // was: id
  };

  parts = parts[0].split('/');

  parsed.name = parts[0];
  parsed.clockRate = parseInt(parts[1], 10); // was: clockrate
  parsed.channels = parts.length === 3 ? parseInt(parts[2], 10) : 1;
  // legacy alias, got renamed back to channels in ORTC.
  parsed.numChannels = parsed.channels;
  return parsed;
};

// Generates a rtpmap line from RTCRtpCodecCapability or
// RTCRtpCodecParameters.
SDPUtils.writeRtpMap = function(codec) {
  let pt = codec.payloadType;
  if (codec.preferredPayloadType !== undefined) {
    pt = codec.preferredPayloadType;
  }
  const channels = codec.channels || codec.numChannels || 1;
  return 'a=rtpmap:' + pt + ' ' + codec.name + '/' + codec.clockRate +
      (channels !== 1 ? '/' + channels : '') + '\r\n';
};

// Parses a extmap line (headerextension from RFC 5285). Sample input:
// a=extmap:2 urn:ietf:params:rtp-hdrext:toffset
// a=extmap:2/sendonly urn:ietf:params:rtp-hdrext:toffset
SDPUtils.parseExtmap = function(line) {
  const parts = line.substring(9).split(' ');
  return {
    id: parseInt(parts[0], 10),
    direction: parts[0].indexOf('/') > 0 ? parts[0].split('/')[1] : 'sendrecv',
    uri: parts[1],
    attributes: parts.slice(2).join(' '),
  };
};

// Generates an extmap line from RTCRtpHeaderExtensionParameters or
// RTCRtpHeaderExtension.
SDPUtils.writeExtmap = function(headerExtension) {
  return 'a=extmap:' + (headerExtension.id || headerExtension.preferredId) +
      (headerExtension.direction && headerExtension.direction !== 'sendrecv'
        ? '/' + headerExtension.direction
        : '') +
      ' ' + headerExtension.uri +
      (headerExtension.attributes ? ' ' + headerExtension.attributes : '') +
      '\r\n';
};

// Parses a fmtp line, returns dictionary. Sample input:
// a=fmtp:96 vbr=on;cng=on
// Also deals with vbr=on; cng=on
SDPUtils.parseFmtp = function(line) {
  const parsed = {};
  let kv;
  const parts = line.substring(line.indexOf(' ') + 1).split(';');
  for (let j = 0; j < parts.length; j++) {
    kv = parts[j].trim().split('=');
    parsed[kv[0].trim()] = kv[1];
  }
  return parsed;
};

// Generates a fmtp line from RTCRtpCodecCapability or RTCRtpCodecParameters.
SDPUtils.writeFmtp = function(codec) {
  let line = '';
  let pt = codec.payloadType;
  if (codec.preferredPayloadType !== undefined) {
    pt = codec.preferredPayloadType;
  }
  if (codec.parameters && Object.keys(codec.parameters).length) {
    const params = [];
    Object.keys(codec.parameters).forEach(param => {
      if (codec.parameters[param] !== undefined) {
        params.push(param + '=' + codec.parameters[param]);
      } else {
        params.push(param);
      }
    });
    line += 'a=fmtp:' + pt + ' ' + params.join(';') + '\r\n';
  }
  return line;
};

// Parses a rtcp-fb line, returns RTCPRtcpFeedback object. Sample input:
// a=rtcp-fb:98 nack rpsi
SDPUtils.parseRtcpFb = function(line) {
  const parts = line.substring(line.indexOf(' ') + 1).split(' ');
  return {
    type: parts.shift(),
    parameter: parts.join(' '),
  };
};

// Generate a=rtcp-fb lines from RTCRtpCodecCapability or RTCRtpCodecParameters.
SDPUtils.writeRtcpFb = function(codec) {
  let lines = '';
  let pt = codec.payloadType;
  if (codec.preferredPayloadType !== undefined) {
    pt = codec.preferredPayloadType;
  }
  if (codec.rtcpFeedback && codec.rtcpFeedback.length) {
    // FIXME: special handling for trr-int?
    codec.rtcpFeedback.forEach(fb => {
      lines += 'a=rtcp-fb:' + pt + ' ' + fb.type +
      (fb.parameter && fb.parameter.length ? ' ' + fb.parameter : '') +
          '\r\n';
    });
  }
  return lines;
};

// Parses a RFC 5576 ssrc media attribute. Sample input:
// a=ssrc:3735928559 cname:something
SDPUtils.parseSsrcMedia = function(line) {
  const sp = line.indexOf(' ');
  const parts = {
    ssrc: parseInt(line.substring(7, sp), 10),
  };
  const colon = line.indexOf(':', sp);
  if (colon > -1) {
    parts.attribute = line.substring(sp + 1, colon);
    parts.value = line.substring(colon + 1);
  } else {
    parts.attribute = line.substring(sp + 1);
  }
  return parts;
};

// Parse a ssrc-group line (see RFC 5576). Sample input:
// a=ssrc-group:semantics 12 34
SDPUtils.parseSsrcGroup = function(line) {
  const parts = line.substring(13).split(' ');
  return {
    semantics: parts.shift(),
    ssrcs: parts.map(ssrc => parseInt(ssrc, 10)),
  };
};

// Extracts the MID (RFC 5888) from a media section.
// Returns the MID or undefined if no mid line was found.
SDPUtils.getMid = function(mediaSection) {
  const mid = SDPUtils.matchPrefix(mediaSection, 'a=mid:')[0];
  if (mid) {
    return mid.substring(6);
  }
};

// Parses a fingerprint line for DTLS-SRTP.
SDPUtils.parseFingerprint = function(line) {
  const parts = line.substring(14).split(' ');
  return {
    algorithm: parts[0].toLowerCase(), // algorithm is case-sensitive in Edge.
    value: parts[1].toUpperCase(), // the definition is upper-case in RFC 4572.
  };
};

// Extracts DTLS parameters from SDP media section or sessionpart.
// FIXME: for consistency with other functions this should only
//   get the fingerprint line as input. See also getIceParameters.
SDPUtils.getDtlsParameters = function(mediaSection, sessionpart) {
  const lines = SDPUtils.matchPrefix(mediaSection + sessionpart,
    'a=fingerprint:');
  // Note: a=setup line is ignored since we use the 'auto' role in Edge.
  return {
    role: 'auto',
    fingerprints: lines.map(SDPUtils.parseFingerprint),
  };
};

// Serializes DTLS parameters to SDP.
SDPUtils.writeDtlsParameters = function(params, setupType) {
  let sdp = 'a=setup:' + setupType + '\r\n';
  params.fingerprints.forEach(fp => {
    sdp += 'a=fingerprint:' + fp.algorithm + ' ' + fp.value + '\r\n';
  });
  return sdp;
};

// Parses a=crypto lines into
//   https://rawgit.com/aboba/edgertc/master/msortc-rs4.html#dictionary-rtcsrtpsdesparameters-members
SDPUtils.parseCryptoLine = function(line) {
  const parts = line.substring(9).split(' ');
  return {
    tag: parseInt(parts[0], 10),
    cryptoSuite: parts[1],
    keyParams: parts[2],
    sessionParams: parts.slice(3),
  };
};

SDPUtils.writeCryptoLine = function(parameters) {
  return 'a=crypto:' + parameters.tag + ' ' +
    parameters.cryptoSuite + ' ' +
    (typeof parameters.keyParams === 'object'
      ? SDPUtils.writeCryptoKeyParams(parameters.keyParams)
      : parameters.keyParams) +
    (parameters.sessionParams ? ' ' + parameters.sessionParams.join(' ') : '') +
    '\r\n';
};

// Parses the crypto key parameters into
//   https://rawgit.com/aboba/edgertc/master/msortc-rs4.html#rtcsrtpkeyparam*
SDPUtils.parseCryptoKeyParams = function(keyParams) {
  if (keyParams.indexOf('inline:') !== 0) {
    return null;
  }
  const parts = keyParams.substring(7).split('|');
  return {
    keyMethod: 'inline',
    keySalt: parts[0],
    lifeTime: parts[1],
    mkiValue: parts[2] ? parts[2].split(':')[0] : undefined,
    mkiLength: parts[2] ? parts[2].split(':')[1] : undefined,
  };
};

SDPUtils.writeCryptoKeyParams = function(keyParams) {
  return keyParams.keyMethod + ':'
    + keyParams.keySalt +
    (keyParams.lifeTime ? '|' + keyParams.lifeTime : '') +
    (keyParams.mkiValue && keyParams.mkiLength
      ? '|' + keyParams.mkiValue + ':' + keyParams.mkiLength
      : '');
};

// Extracts all SDES parameters.
SDPUtils.getCryptoParameters = function(mediaSection, sessionpart) {
  const lines = SDPUtils.matchPrefix(mediaSection + sessionpart,
    'a=crypto:');
  return lines.map(SDPUtils.parseCryptoLine);
};

// Parses ICE information from SDP media section or sessionpart.
// FIXME: for consistency with other functions this should only
//   get the ice-ufrag and ice-pwd lines as input.
SDPUtils.getIceParameters = function(mediaSection, sessionpart) {
  const ufrag = SDPUtils.matchPrefix(mediaSection + sessionpart,
    'a=ice-ufrag:')[0];
  const pwd = SDPUtils.matchPrefix(mediaSection + sessionpart,
    'a=ice-pwd:')[0];
  if (!(ufrag && pwd)) {
    return null;
  }
  return {
    usernameFragment: ufrag.substring(12),
    password: pwd.substring(10),
  };
};

// Serializes ICE parameters to SDP.
SDPUtils.writeIceParameters = function(params) {
  let sdp = 'a=ice-ufrag:' + params.usernameFragment + '\r\n' +
      'a=ice-pwd:' + params.password + '\r\n';
  if (params.iceLite) {
    sdp += 'a=ice-lite\r\n';
  }
  return sdp;
};

// Parses the SDP media section and returns RTCRtpParameters.
SDPUtils.parseRtpParameters = function(mediaSection) {
  const description = {
    codecs: [],
    headerExtensions: [],
    fecMechanisms: [],
    rtcp: [],
  };
  const lines = SDPUtils.splitLines(mediaSection);
  const mline = lines[0].split(' ');
  description.profile = mline[2];
  for (let i = 3; i < mline.length; i++) { // find all codecs from mline[3..]
    const pt = mline[i];
    const rtpmapline = SDPUtils.matchPrefix(
      mediaSection, 'a=rtpmap:' + pt + ' ')[0];
    if (rtpmapline) {
      const codec = SDPUtils.parseRtpMap(rtpmapline);
      const fmtps = SDPUtils.matchPrefix(
        mediaSection, 'a=fmtp:' + pt + ' ');
      // Only the first a=fmtp:<pt> is considered.
      codec.parameters = fmtps.length ? SDPUtils.parseFmtp(fmtps[0]) : {};
      codec.rtcpFeedback = SDPUtils.matchPrefix(
        mediaSection, 'a=rtcp-fb:' + pt + ' ')
        .map(SDPUtils.parseRtcpFb);
      description.codecs.push(codec);
      // parse FEC mechanisms from rtpmap lines.
      switch (codec.name.toUpperCase()) {
        case 'RED':
        case 'ULPFEC':
          description.fecMechanisms.push(codec.name.toUpperCase());
          break;
        default: // only RED and ULPFEC are recognized as FEC mechanisms.
          break;
      }
    }
  }
  SDPUtils.matchPrefix(mediaSection, 'a=extmap:').forEach(line => {
    description.headerExtensions.push(SDPUtils.parseExtmap(line));
  });
  const wildcardRtcpFb = SDPUtils.matchPrefix(mediaSection, 'a=rtcp-fb:* ')
    .map(SDPUtils.parseRtcpFb);
  description.codecs.forEach(codec => {
    wildcardRtcpFb.forEach(fb=> {
      const duplicate = codec.rtcpFeedback.find(existingFeedback => {
        return existingFeedback.type === fb.type &&
          existingFeedback.parameter === fb.parameter;
      });
      if (!duplicate) {
        codec.rtcpFeedback.push(fb);
      }
    });
  });
  // FIXME: parse rtcp.
  return description;
};

// Generates parts of the SDP media section describing the capabilities /
// parameters.
SDPUtils.writeRtpDescription = function(kind, caps) {
  let sdp = '';

  // Build the mline.
  sdp += 'm=' + kind + ' ';
  sdp += caps.codecs.length > 0 ? '9' : '0'; // reject if no codecs.
  sdp += ' ' + (caps.profile || 'UDP/TLS/RTP/SAVPF') + ' ';
  sdp += caps.codecs.map(codec => {
    if (codec.preferredPayloadType !== undefined) {
      return codec.preferredPayloadType;
    }
    return codec.payloadType;
  }).join(' ') + '\r\n';

  sdp += 'c=IN IP4 0.0.0.0\r\n';
  sdp += 'a=rtcp:9 IN IP4 0.0.0.0\r\n';

  // Add a=rtpmap lines for each codec. Also fmtp and rtcp-fb.
  caps.codecs.forEach(codec => {
    sdp += SDPUtils.writeRtpMap(codec);
    sdp += SDPUtils.writeFmtp(codec);
    sdp += SDPUtils.writeRtcpFb(codec);
  });
  let maxptime = 0;
  caps.codecs.forEach(codec => {
    if (codec.maxptime > maxptime) {
      maxptime = codec.maxptime;
    }
  });
  if (maxptime > 0) {
    sdp += 'a=maxptime:' + maxptime + '\r\n';
  }

  if (caps.headerExtensions) {
    caps.headerExtensions.forEach(extension => {
      sdp += SDPUtils.writeExtmap(extension);
    });
  }
  // FIXME: write fecMechanisms.
  return sdp;
};

// Parses the SDP media section and returns an array of
// RTCRtpEncodingParameters.
SDPUtils.parseRtpEncodingParameters = function(mediaSection) {
  const encodingParameters = [];
  const description = SDPUtils.parseRtpParameters(mediaSection);
  const hasRed = description.fecMechanisms.indexOf('RED') !== -1;
  const hasUlpfec = description.fecMechanisms.indexOf('ULPFEC') !== -1;

  // filter a=ssrc:... cname:, ignore PlanB-msid
  const ssrcs = SDPUtils.matchPrefix(mediaSection, 'a=ssrc:')
    .map(line => SDPUtils.parseSsrcMedia(line))
    .filter(parts => parts.attribute === 'cname');
  const primarySsrc = ssrcs.length > 0 && ssrcs[0].ssrc;
  let secondarySsrc;

  const flows = SDPUtils.matchPrefix(mediaSection, 'a=ssrc-group:FID')
    .map(line => {
      const parts = line.substring(17).split(' ');
      return parts.map(part => parseInt(part, 10));
    });
  if (flows.length > 0 && flows[0].length > 1 && flows[0][0] === primarySsrc) {
    secondarySsrc = flows[0][1];
  }

  description.codecs.forEach(codec => {
    if (codec.name.toUpperCase() === 'RTX' && codec.parameters.apt) {
      let encParam = {
        ssrc: primarySsrc,
        codecPayloadType: parseInt(codec.parameters.apt, 10),
      };
      if (primarySsrc && secondarySsrc) {
        encParam.rtx = {ssrc: secondarySsrc};
      }
      encodingParameters.push(encParam);
      if (hasRed) {
        encParam = JSON.parse(JSON.stringify(encParam));
        encParam.fec = {
          ssrc: primarySsrc,
          mechanism: hasUlpfec ? 'red+ulpfec' : 'red',
        };
        encodingParameters.push(encParam);
      }
    }
  });
  if (encodingParameters.length === 0 && primarySsrc) {
    encodingParameters.push({
      ssrc: primarySsrc,
    });
  }

  // we support both b=AS and b=TIAS but interpret AS as TIAS.
  let bandwidth = SDPUtils.matchPrefix(mediaSection, 'b=');
  if (bandwidth.length) {
    if (bandwidth[0].indexOf('b=TIAS:') === 0) {
      bandwidth = parseInt(bandwidth[0].substring(7), 10);
    } else if (bandwidth[0].indexOf('b=AS:') === 0) {
      // use formula from JSEP to convert b=AS to TIAS value.
      bandwidth = parseInt(bandwidth[0].substring(5), 10) * 1000 * 0.95
          - (50 * 40 * 8);
    } else {
      bandwidth = undefined;
    }
    encodingParameters.forEach(params => {
      params.maxBitrate = bandwidth;
    });
  }
  return encodingParameters;
};

// parses http://draft.ortc.org/#rtcrtcpparameters*
SDPUtils.parseRtcpParameters = function(mediaSection) {
  const rtcpParameters = {};

  // Gets the first SSRC. Note that with RTX there might be multiple
  // SSRCs.
  const remoteSsrc = SDPUtils.matchPrefix(mediaSection, 'a=ssrc:')
    .map(line => SDPUtils.parseSsrcMedia(line))
    .filter(obj => obj.attribute === 'cname')[0];
  if (remoteSsrc) {
    rtcpParameters.cname = remoteSsrc.value;
    rtcpParameters.ssrc = remoteSsrc.ssrc;
  }

  // Edge uses the compound attribute instead of reducedSize
  // compound is !reducedSize
  const rsize = SDPUtils.matchPrefix(mediaSection, 'a=rtcp-rsize');
  rtcpParameters.reducedSize = rsize.length > 0;
  rtcpParameters.compound = rsize.length === 0;

  // parses the rtcp-mux attrіbute.
  // Note that Edge does not support unmuxed RTCP.
  const mux = SDPUtils.matchPrefix(mediaSection, 'a=rtcp-mux');
  rtcpParameters.mux = mux.length > 0;

  return rtcpParameters;
};

SDPUtils.writeRtcpParameters = function(rtcpParameters) {
  let sdp = '';
  if (rtcpParameters.reducedSize) {
    sdp += 'a=rtcp-rsize\r\n';
  }
  if (rtcpParameters.mux) {
    sdp += 'a=rtcp-mux\r\n';
  }
  if (rtcpParameters.ssrc !== undefined && rtcpParameters.cname) {
    sdp += 'a=ssrc:' + rtcpParameters.ssrc +
      ' cname:' + rtcpParameters.cname + '\r\n';
  }
  return sdp;
};


// parses either a=msid: or a=ssrc:... msid lines and returns
// the id of the MediaStream and MediaStreamTrack.
SDPUtils.parseMsid = function(mediaSection) {
  let parts;
  const spec = SDPUtils.matchPrefix(mediaSection, 'a=msid:');
  if (spec.length === 1) {
    parts = spec[0].substring(7).split(' ');
    return {stream: parts[0], track: parts[1]};
  }
  const planB = SDPUtils.matchPrefix(mediaSection, 'a=ssrc:')
    .map(line => SDPUtils.parseSsrcMedia(line))
    .filter(msidParts => msidParts.attribute === 'msid');
  if (planB.length > 0) {
    parts = planB[0].value.split(' ');
    return {stream: parts[0], track: parts[1]};
  }
};

// SCTP
// parses draft-ietf-mmusic-sctp-sdp-26 first and falls back
// to draft-ietf-mmusic-sctp-sdp-05
SDPUtils.parseSctpDescription = function(mediaSection) {
  const mline = SDPUtils.parseMLine(mediaSection);
  const maxSizeLine = SDPUtils.matchPrefix(mediaSection, 'a=max-message-size:');
  let maxMessageSize;
  if (maxSizeLine.length > 0) {
    maxMessageSize = parseInt(maxSizeLine[0].substring(19), 10);
  }
  if (isNaN(maxMessageSize)) {
    maxMessageSize = 65536;
  }
  const sctpPort = SDPUtils.matchPrefix(mediaSection, 'a=sctp-port:');
  if (sctpPort.length > 0) {
    return {
      port: parseInt(sctpPort[0].substring(12), 10),
      protocol: mline.fmt,
      maxMessageSize,
    };
  }
  const sctpMapLines = SDPUtils.matchPrefix(mediaSection, 'a=sctpmap:');
  if (sctpMapLines.length > 0) {
    const parts = sctpMapLines[0]
      .substring(10)
      .split(' ');
    return {
      port: parseInt(parts[0], 10),
      protocol: parts[1],
      maxMessageSize,
    };
  }
};

// SCTP
// outputs the draft-ietf-mmusic-sctp-sdp-26 version that all browsers
// support by now receiving in this format, unless we originally parsed
// as the draft-ietf-mmusic-sctp-sdp-05 format (indicated by the m-line
// protocol of DTLS/SCTP -- without UDP/ or TCP/)
SDPUtils.writeSctpDescription = function(media, sctp) {
  let output = [];
  if (media.protocol !== 'DTLS/SCTP') {
    output = [
      'm=' + media.kind + ' 9 ' + media.protocol + ' ' + sctp.protocol + '\r\n',
      'c=IN IP4 0.0.0.0\r\n',
      'a=sctp-port:' + sctp.port + '\r\n',
    ];
  } else {
    output = [
      'm=' + media.kind + ' 9 ' + media.protocol + ' ' + sctp.port + '\r\n',
      'c=IN IP4 0.0.0.0\r\n',
      'a=sctpmap:' + sctp.port + ' ' + sctp.protocol + ' 65535\r\n',
    ];
  }
  if (sctp.maxMessageSize !== undefined) {
    output.push('a=max-message-size:' + sctp.maxMessageSize + '\r\n');
  }
  return output.join('');
};

// Generate a session ID for SDP.
// https://tools.ietf.org/html/draft-ietf-rtcweb-jsep-20#section-5.2.1
// recommends using a cryptographically random +ve 64-bit value
// but right now this should be acceptable and within the right range
SDPUtils.generateSessionId = function() {
  return Math.random().toString().substr(2, 22);
};

// Write boiler plate for start of SDP
// sessId argument is optional - if not supplied it will
// be generated randomly
// sessVersion is optional and defaults to 2
// sessUser is optional and defaults to 'thisisadapterortc'
SDPUtils.writeSessionBoilerplate = function(sessId, sessVer, sessUser) {
  let sessionId;
  const version = sessVer !== undefined ? sessVer : 2;
  if (sessId) {
    sessionId = sessId;
  } else {
    sessionId = SDPUtils.generateSessionId();
  }
  const user = sessUser || 'thisisadapterortc';
  // FIXME: sess-id should be an NTP timestamp.
  return 'v=0\r\n' +
      'o=' + user + ' ' + sessionId + ' ' + version +
        ' IN IP4 127.0.0.1\r\n' +
      's=-\r\n' +
      't=0 0\r\n';
};

// Gets the direction from the mediaSection or the sessionpart.
SDPUtils.getDirection = function(mediaSection, sessionpart) {
  // Look for sendrecv, sendonly, recvonly, inactive, default to sendrecv.
  const lines = SDPUtils.splitLines(mediaSection);
  for (let i = 0; i < lines.length; i++) {
    switch (lines[i]) {
      case 'a=sendrecv':
      case 'a=sendonly':
      case 'a=recvonly':
      case 'a=inactive':
        return lines[i].substring(2);
      default:
        // FIXME: What should happen here?
    }
  }
  if (sessionpart) {
    return SDPUtils.getDirection(sessionpart);
  }
  return 'sendrecv';
};

SDPUtils.getKind = function(mediaSection) {
  const lines = SDPUtils.splitLines(mediaSection);
  const mline = lines[0].split(' ');
  return mline[0].substring(2);
};

SDPUtils.isRejected = function(mediaSection) {
  return mediaSection.split(' ', 2)[1] === '0';
};

SDPUtils.parseMLine = function(mediaSection) {
  const lines = SDPUtils.splitLines(mediaSection);
  const parts = lines[0].substring(2).split(' ');
  return {
    kind: parts[0],
    port: parseInt(parts[1], 10),
    protocol: parts[2],
    fmt: parts.slice(3).join(' '),
  };
};

SDPUtils.parseOLine = function(mediaSection) {
  const line = SDPUtils.matchPrefix(mediaSection, 'o=')[0];
  const parts = line.substring(2).split(' ');
  return {
    username: parts[0],
    sessionId: parts[1],
    sessionVersion: parseInt(parts[2], 10),
    netType: parts[3],
    addressType: parts[4],
    address: parts[5],
  };
};

// a very naive interpretation of a valid SDP.
SDPUtils.isValidSDP = function(blob) {
  if (typeof blob !== 'string' || blob.length === 0) {
    return false;
  }
  const lines = SDPUtils.splitLines(blob);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].length < 2 || lines[i].charAt(1) !== '=') {
      return false;
    }
    // TODO: check the modifier a bit more.
  }
  return true;
};

// Expose public methods.
if (true) {
  module.exports = SDPUtils;
}


/***/ })

/******/ 	});
/************************************************************************/
/******/ 	// The module cache
/******/ 	var __webpack_module_cache__ = {};
/******/ 	
/******/ 	// The require function
/******/ 	function __webpack_require__(moduleId) {
/******/ 		// Check if module is in cache
/******/ 		var cachedModule = __webpack_module_cache__[moduleId];
/******/ 		if (cachedModule !== undefined) {
/******/ 			return cachedModule.exports;
/******/ 		}
/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = __webpack_module_cache__[moduleId] = {
/******/ 			// no module.id needed
/******/ 			// no module.loaded needed
/******/ 			exports: {}
/******/ 		};
/******/ 	
/******/ 		// Execute the module function
/******/ 		__webpack_modules__[moduleId](module, module.exports, __webpack_require__);
/******/ 	
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/ 	
/************************************************************************/
/******/ 	
/******/ 	// startup
/******/ 	// Load entry module and return exports
/******/ 	// This entry module is referenced by other modules so it can't be inlined
/******/ 	var __webpack_exports__ = __webpack_require__("./src/index.js");
/******/ 	
/******/ })()
;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,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QTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQUVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsS0FBSztBQUNMO0FBQ0E7QUFDQTs7QUFFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsSUFBSTtBQUNKO0FBQ0E7QUFDQTtBQUNBOztBQUVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUFFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQUVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FBRUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQUVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSxHQUFHO0FBQ0g7QUFDQTs7QUFFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQUVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUFFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FBRUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUFFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FBRUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FBRUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQUVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSxrQkFBa0Isa0JBQWtCLE9BQU87QUFDM0M7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLEdBQUc7QUFDSDtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLE9BQU87QUFDUDtBQUNBO0FBQ0E7QUFDQSxLQUFLO0FBQ0wsR0FBRztBQUNIO0FBQ0E7QUFDQTs7QUFFQTtBQUNBO0FBQ0E7QUFDQTs7QUFFQTtBQUNBO0FBQ0EsNkNBQTZDO0FBQzdDO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLEdBQUc7O0FBRUg7QUFDQTs7QUFFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsR0FBRztBQUNIO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSxHQUFHO0FBQ0g7QUFDQTtBQUNBOztBQUVBO0FBQ0E7QUFDQTtBQUNBLEtBQUs7QUFDTDtBQUNBO0FBQ0E7QUFDQTs7QUFFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUFFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FBRUE7QUFDQTtBQUNBO0FBQ0E7QUFDQSxLQUFLO0FBQ0w7QUFDQTtBQUNBOztBQUVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0Esd0JBQXdCO0FBQ3hCO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSxHQUFHO0FBQ0g7QUFDQTtBQUNBO0FBQ0EsS0FBSztBQUNMOztBQUVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSxNQUFNO0FBQ047QUFDQTtBQUNBO0FBQ0EsTUFBTTtBQUNOO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsS0FBSztBQUNMO0FBQ0E7QUFDQTs7QUFFQTtBQUNBO0FBQ0E7O0FBRUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQUVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FBRUE7QUFDQTtBQUNBO0FBQ0E7O0FBRUE7QUFDQTs7QUFFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7QUFHQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLFlBQVk7QUFDWjtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSxZQUFZO0FBQ1o7QUFDQTs7QUFFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FBRUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSxJQUFJO0FBQ0o7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUFFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUFFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLElBQUk7QUFDSjtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUFFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLGtCQUFrQixrQkFBa0I7QUFDcEM7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQUVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FBRUE7QUFDQTtBQUNBOztBQUVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQUVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUFFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSxrQkFBa0Isa0JBQWtCO0FBQ3BDO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQUVBO0FBQ0EsSUFBSSxJQUEwQjtBQUM5QjtBQUNBOzs7Ozs7O1VDanlCQTtVQUNBOztVQUVBO1VBQ0E7VUFDQTtVQUNBO1VBQ0E7VUFDQTtVQUNBO1VBQ0E7VUFDQTtVQUNBO1VBQ0E7VUFDQTtVQUNBOztVQUVBO1VBQ0E7O1VBRUE7VUFDQTtVQUNBOzs7O1VFdEJBO1VBQ0E7VUFDQTtVQUNBIiwic291cmNlcyI6WyJ3ZWJwYWNrOi8vQG5ldHdvcmtlZC1hZnJhbWUvbmFmLWphbnVzLWFkYXB0ZXIvLi9ub2RlX21vZHVsZXMvQG5ldHdvcmtlZC1hZnJhbWUvbWluaWphbnVzL21pbmlqYW51cy5qcyIsIndlYnBhY2s6Ly9AbmV0d29ya2VkLWFmcmFtZS9uYWYtamFudXMtYWRhcHRlci8uL3NyYy9pbmRleC5qcyIsIndlYnBhY2s6Ly9AbmV0d29ya2VkLWFmcmFtZS9uYWYtamFudXMtYWRhcHRlci8uL25vZGVfbW9kdWxlcy9zZHAvc2RwLmpzIiwid2VicGFjazovL0BuZXR3b3JrZWQtYWZyYW1lL25hZi1qYW51cy1hZGFwdGVyL3dlYnBhY2svYm9vdHN0cmFwIiwid2VicGFjazovL0BuZXR3b3JrZWQtYWZyYW1lL25hZi1qYW51cy1hZGFwdGVyL3dlYnBhY2svYmVmb3JlLXN0YXJ0dXAiLCJ3ZWJwYWNrOi8vQG5ldHdvcmtlZC1hZnJhbWUvbmFmLWphbnVzLWFkYXB0ZXIvd2VicGFjay9zdGFydHVwIiwid2VicGFjazovL0BuZXR3b3JrZWQtYWZyYW1lL25hZi1qYW51cy1hZGFwdGVyL3dlYnBhY2svYWZ0ZXItc3RhcnR1cCJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIFJlcHJlc2VudHMgYSBoYW5kbGUgdG8gYSBzaW5nbGUgSmFudXMgcGx1Z2luIG9uIGEgSmFudXMgc2Vzc2lvbi4gRWFjaCBXZWJSVEMgY29ubmVjdGlvbiB0byB0aGUgSmFudXMgc2VydmVyIHdpbGwgYmVcbiAqIGFzc29jaWF0ZWQgd2l0aCBhIHNpbmdsZSBoYW5kbGUuIE9uY2UgYXR0YWNoZWQgdG8gdGhlIHNlcnZlciwgdGhpcyBoYW5kbGUgd2lsbCBiZSBnaXZlbiBhIHVuaXF1ZSBJRCB3aGljaCBzaG91bGQgYmVcbiAqIHVzZWQgdG8gYXNzb2NpYXRlIGl0IHdpdGggZnV0dXJlIHNpZ25hbGxpbmcgbWVzc2FnZXMuXG4gKlxuICogU2VlIGh0dHBzOi8vamFudXMuY29uZi5tZWV0ZWNoby5jb20vZG9jcy9yZXN0Lmh0bWwjaGFuZGxlcy5cbiAqKi9cbmZ1bmN0aW9uIEphbnVzUGx1Z2luSGFuZGxlKHNlc3Npb24pIHtcbiAgdGhpcy5zZXNzaW9uID0gc2Vzc2lvbjtcbiAgdGhpcy5pZCA9IHVuZGVmaW5lZDtcbn1cblxuLyoqIEF0dGFjaGVzIHRoaXMgaGFuZGxlIHRvIHRoZSBKYW51cyBzZXJ2ZXIgYW5kIHNldHMgaXRzIElELiAqKi9cbkphbnVzUGx1Z2luSGFuZGxlLnByb3RvdHlwZS5hdHRhY2ggPSBmdW5jdGlvbihwbHVnaW4sIGxvb3BfaW5kZXgpIHtcbiAgdmFyIHBheWxvYWQgPSB7IHBsdWdpbjogcGx1Z2luLCBsb29wX2luZGV4OiBsb29wX2luZGV4LCBcImZvcmNlLWJ1bmRsZVwiOiB0cnVlLCBcImZvcmNlLXJ0Y3AtbXV4XCI6IHRydWUgfTtcbiAgcmV0dXJuIHRoaXMuc2Vzc2lvbi5zZW5kKFwiYXR0YWNoXCIsIHBheWxvYWQpLnRoZW4ocmVzcCA9PiB7XG4gICAgdGhpcy5pZCA9IHJlc3AuZGF0YS5pZDtcbiAgICByZXR1cm4gcmVzcDtcbiAgfSk7XG59O1xuXG4vKiogRGV0YWNoZXMgdGhpcyBoYW5kbGUuICoqL1xuSmFudXNQbHVnaW5IYW5kbGUucHJvdG90eXBlLmRldGFjaCA9IGZ1bmN0aW9uKCkge1xuICByZXR1cm4gdGhpcy5zZW5kKFwiZGV0YWNoXCIpO1xufTtcblxuLyoqIFJlZ2lzdGVycyBhIGNhbGxiYWNrIHRvIGJlIGZpcmVkIHVwb24gdGhlIHJlY2VwdGlvbiBvZiBhbnkgaW5jb21pbmcgSmFudXMgc2lnbmFscyBmb3IgdGhpcyBwbHVnaW4gaGFuZGxlIHdpdGggdGhlXG4gKiBgamFudXNgIGF0dHJpYnV0ZSBlcXVhbCB0byBgZXZgLlxuICoqL1xuSmFudXNQbHVnaW5IYW5kbGUucHJvdG90eXBlLm9uID0gZnVuY3Rpb24oZXYsIGNhbGxiYWNrKSB7XG4gIHJldHVybiB0aGlzLnNlc3Npb24ub24oZXYsIHNpZ25hbCA9PiB7XG4gICAgaWYgKHNpZ25hbC5zZW5kZXIgPT0gdGhpcy5pZCkge1xuICAgICAgY2FsbGJhY2soc2lnbmFsKTtcbiAgICB9XG4gIH0pO1xufTtcblxuLyoqXG4gKiBTZW5kcyBhIHNpZ25hbCBhc3NvY2lhdGVkIHdpdGggdGhpcyBoYW5kbGUuIFNpZ25hbHMgc2hvdWxkIGJlIEpTT04tc2VyaWFsaXphYmxlIG9iamVjdHMuIFJldHVybnMgYSBwcm9taXNlIHRoYXQgd2lsbFxuICogYmUgcmVzb2x2ZWQgb3IgcmVqZWN0ZWQgd2hlbiBhIHJlc3BvbnNlIHRvIHRoaXMgc2lnbmFsIGlzIHJlY2VpdmVkLCBvciB3aGVuIG5vIHJlc3BvbnNlIGlzIHJlY2VpdmVkIHdpdGhpbiB0aGVcbiAqIHNlc3Npb24gdGltZW91dC5cbiAqKi9cbkphbnVzUGx1Z2luSGFuZGxlLnByb3RvdHlwZS5zZW5kID0gZnVuY3Rpb24odHlwZSwgc2lnbmFsKSB7XG4gIHJldHVybiB0aGlzLnNlc3Npb24uc2VuZCh0eXBlLCBPYmplY3QuYXNzaWduKHsgaGFuZGxlX2lkOiB0aGlzLmlkIH0sIHNpZ25hbCkpO1xufTtcblxuLyoqIFNlbmRzIGEgcGx1Z2luLXNwZWNpZmljIG1lc3NhZ2UgYXNzb2NpYXRlZCB3aXRoIHRoaXMgaGFuZGxlLiAqKi9cbkphbnVzUGx1Z2luSGFuZGxlLnByb3RvdHlwZS5zZW5kTWVzc2FnZSA9IGZ1bmN0aW9uKGJvZHkpIHtcbiAgcmV0dXJuIHRoaXMuc2VuZChcIm1lc3NhZ2VcIiwgeyBib2R5OiBib2R5IH0pO1xufTtcblxuLyoqIFNlbmRzIGEgSlNFUCBvZmZlciBvciBhbnN3ZXIgYXNzb2NpYXRlZCB3aXRoIHRoaXMgaGFuZGxlLiAqKi9cbkphbnVzUGx1Z2luSGFuZGxlLnByb3RvdHlwZS5zZW5kSnNlcCA9IGZ1bmN0aW9uKGpzZXApIHtcbiAgcmV0dXJuIHRoaXMuc2VuZChcIm1lc3NhZ2VcIiwgeyBib2R5OiB7fSwganNlcDoganNlcCB9KTtcbn07XG5cbi8qKiBTZW5kcyBhbiBJQ0UgdHJpY2tsZSBjYW5kaWRhdGUgYXNzb2NpYXRlZCB3aXRoIHRoaXMgaGFuZGxlLiAqKi9cbkphbnVzUGx1Z2luSGFuZGxlLnByb3RvdHlwZS5zZW5kVHJpY2tsZSA9IGZ1bmN0aW9uKGNhbmRpZGF0ZSkge1xuICByZXR1cm4gdGhpcy5zZW5kKFwidHJpY2tsZVwiLCB7IGNhbmRpZGF0ZTogY2FuZGlkYXRlIH0pO1xufTtcblxuLyoqXG4gKiBSZXByZXNlbnRzIGEgSmFudXMgc2Vzc2lvbiAtLSBhIEphbnVzIGNvbnRleHQgZnJvbSB3aXRoaW4gd2hpY2ggeW91IGNhbiBvcGVuIG11bHRpcGxlIGhhbmRsZXMgYW5kIGNvbm5lY3Rpb25zLiBPbmNlXG4gKiBjcmVhdGVkLCB0aGlzIHNlc3Npb24gd2lsbCBiZSBnaXZlbiBhIHVuaXF1ZSBJRCB3aGljaCBzaG91bGQgYmUgdXNlZCB0byBhc3NvY2lhdGUgaXQgd2l0aCBmdXR1cmUgc2lnbmFsbGluZyBtZXNzYWdlcy5cbiAqXG4gKiBTZWUgaHR0cHM6Ly9qYW51cy5jb25mLm1lZXRlY2hvLmNvbS9kb2NzL3Jlc3QuaHRtbCNzZXNzaW9ucy5cbiAqKi9cbmZ1bmN0aW9uIEphbnVzU2Vzc2lvbihvdXRwdXQsIG9wdGlvbnMpIHtcbiAgdGhpcy5vdXRwdXQgPSBvdXRwdXQ7XG4gIHRoaXMuaWQgPSB1bmRlZmluZWQ7XG4gIHRoaXMubmV4dFR4SWQgPSAwO1xuICB0aGlzLnR4bnMgPSB7fTtcbiAgdGhpcy5ldmVudEhhbmRsZXJzID0ge307XG4gIHRoaXMub3B0aW9ucyA9IE9iamVjdC5hc3NpZ24oe1xuICAgIHZlcmJvc2U6IGZhbHNlLFxuICAgIHRpbWVvdXRNczogMTAwMDAsXG4gICAga2VlcGFsaXZlTXM6IDMwMDAwXG4gIH0sIG9wdGlvbnMpO1xufVxuXG4vKiogQ3JlYXRlcyB0aGlzIHNlc3Npb24gb24gdGhlIEphbnVzIHNlcnZlciBhbmQgc2V0cyBpdHMgSUQuICoqL1xuSmFudXNTZXNzaW9uLnByb3RvdHlwZS5jcmVhdGUgPSBmdW5jdGlvbigpIHtcbiAgcmV0dXJuIHRoaXMuc2VuZChcImNyZWF0ZVwiKS50aGVuKHJlc3AgPT4ge1xuICAgIHRoaXMuaWQgPSByZXNwLmRhdGEuaWQ7XG4gICAgcmV0dXJuIHJlc3A7XG4gIH0pO1xufTtcblxuLyoqXG4gKiBEZXN0cm95cyB0aGlzIHNlc3Npb24uIE5vdGUgdGhhdCB1cG9uIGRlc3RydWN0aW9uLCBKYW51cyB3aWxsIGFsc28gY2xvc2UgdGhlIHNpZ25hbGxpbmcgdHJhbnNwb3J0IChpZiBhcHBsaWNhYmxlKSBhbmRcbiAqIGFueSBvcGVuIFdlYlJUQyBjb25uZWN0aW9ucy5cbiAqKi9cbkphbnVzU2Vzc2lvbi5wcm90b3R5cGUuZGVzdHJveSA9IGZ1bmN0aW9uKCkge1xuICByZXR1cm4gdGhpcy5zZW5kKFwiZGVzdHJveVwiKS50aGVuKChyZXNwKSA9PiB7XG4gICAgdGhpcy5kaXNwb3NlKCk7XG4gICAgcmV0dXJuIHJlc3A7XG4gIH0pO1xufTtcblxuLyoqXG4gKiBEaXNwb3NlcyBvZiB0aGlzIHNlc3Npb24gaW4gYSB3YXkgc3VjaCB0aGF0IG5vIGZ1cnRoZXIgaW5jb21pbmcgc2lnbmFsbGluZyBtZXNzYWdlcyB3aWxsIGJlIHByb2Nlc3NlZC5cbiAqIE91dHN0YW5kaW5nIHRyYW5zYWN0aW9ucyB3aWxsIGJlIHJlamVjdGVkLlxuICoqL1xuSmFudXNTZXNzaW9uLnByb3RvdHlwZS5kaXNwb3NlID0gZnVuY3Rpb24oKSB7XG4gIHRoaXMuX2tpbGxLZWVwYWxpdmUoKTtcbiAgdGhpcy5ldmVudEhhbmRsZXJzID0ge307XG4gIGZvciAodmFyIHR4SWQgaW4gdGhpcy50eG5zKSB7XG4gICAgaWYgKHRoaXMudHhucy5oYXNPd25Qcm9wZXJ0eSh0eElkKSkge1xuICAgICAgdmFyIHR4biA9IHRoaXMudHhuc1t0eElkXTtcbiAgICAgIGNsZWFyVGltZW91dCh0eG4udGltZW91dCk7XG4gICAgICB0eG4ucmVqZWN0KG5ldyBFcnJvcihcIkphbnVzIHNlc3Npb24gd2FzIGRpc3Bvc2VkLlwiKSk7XG4gICAgICBkZWxldGUgdGhpcy50eG5zW3R4SWRdO1xuICAgIH1cbiAgfVxufTtcblxuLyoqXG4gKiBXaGV0aGVyIHRoaXMgc2lnbmFsIHJlcHJlc2VudHMgYW4gZXJyb3IsIGFuZCB0aGUgYXNzb2NpYXRlZCBwcm9taXNlIChpZiBhbnkpIHNob3VsZCBiZSByZWplY3RlZC5cbiAqIFVzZXJzIHNob3VsZCBvdmVycmlkZSB0aGlzIHRvIGhhbmRsZSBhbnkgY3VzdG9tIHBsdWdpbi1zcGVjaWZpYyBlcnJvciBjb252ZW50aW9ucy5cbiAqKi9cbkphbnVzU2Vzc2lvbi5wcm90b3R5cGUuaXNFcnJvciA9IGZ1bmN0aW9uKHNpZ25hbCkge1xuICByZXR1cm4gc2lnbmFsLmphbnVzID09PSBcImVycm9yXCI7XG59O1xuXG4vKiogUmVnaXN0ZXJzIGEgY2FsbGJhY2sgdG8gYmUgZmlyZWQgdXBvbiB0aGUgcmVjZXB0aW9uIG9mIGFueSBpbmNvbWluZyBKYW51cyBzaWduYWxzIGZvciB0aGlzIHNlc3Npb24gd2l0aCB0aGVcbiAqIGBqYW51c2AgYXR0cmlidXRlIGVxdWFsIHRvIGBldmAuXG4gKiovXG5KYW51c1Nlc3Npb24ucHJvdG90eXBlLm9uID0gZnVuY3Rpb24oZXYsIGNhbGxiYWNrKSB7XG4gIHZhciBoYW5kbGVycyA9IHRoaXMuZXZlbnRIYW5kbGVyc1tldl07XG4gIGlmIChoYW5kbGVycyA9PSBudWxsKSB7XG4gICAgaGFuZGxlcnMgPSB0aGlzLmV2ZW50SGFuZGxlcnNbZXZdID0gW107XG4gIH1cbiAgaGFuZGxlcnMucHVzaChjYWxsYmFjayk7XG59O1xuXG4vKipcbiAqIENhbGxiYWNrIGZvciByZWNlaXZpbmcgSlNPTiBzaWduYWxsaW5nIG1lc3NhZ2VzIHBlcnRpbmVudCB0byB0aGlzIHNlc3Npb24uIElmIHRoZSBzaWduYWxzIGFyZSByZXNwb25zZXMgdG8gcHJldmlvdXNseVxuICogc2VudCBzaWduYWxzLCB0aGUgcHJvbWlzZXMgZm9yIHRoZSBvdXRnb2luZyBzaWduYWxzIHdpbGwgYmUgcmVzb2x2ZWQgb3IgcmVqZWN0ZWQgYXBwcm9wcmlhdGVseSB3aXRoIHRoaXMgc2lnbmFsIGFzIGFuXG4gKiBhcmd1bWVudC5cbiAqXG4gKiBFeHRlcm5hbCBjYWxsZXJzIHNob3VsZCBjYWxsIHRoaXMgZnVuY3Rpb24gZXZlcnkgdGltZSBhIG5ldyBzaWduYWwgYXJyaXZlcyBvbiB0aGUgdHJhbnNwb3J0OyBmb3IgZXhhbXBsZSwgaW4gYVxuICogV2ViU29ja2V0J3MgYG1lc3NhZ2VgIGV2ZW50LCBvciB3aGVuIGEgbmV3IGRhdHVtIHNob3dzIHVwIGluIGFuIEhUVFAgbG9uZy1wb2xsaW5nIHJlc3BvbnNlLlxuICoqL1xuSmFudXNTZXNzaW9uLnByb3RvdHlwZS5yZWNlaXZlID0gZnVuY3Rpb24oc2lnbmFsKSB7XG4gIGlmICh0aGlzLm9wdGlvbnMudmVyYm9zZSkge1xuICAgIHRoaXMuX2xvZ0luY29taW5nKHNpZ25hbCk7XG4gIH1cbiAgaWYgKHNpZ25hbC5zZXNzaW9uX2lkICE9IHRoaXMuaWQpIHtcbiAgICBjb25zb2xlLndhcm4oXCJJbmNvcnJlY3Qgc2Vzc2lvbiBJRCByZWNlaXZlZCBpbiBKYW51cyBzaWduYWxsaW5nIG1lc3NhZ2U6IHdhcyBcIiArIHNpZ25hbC5zZXNzaW9uX2lkICsgXCIsIGV4cGVjdGVkIFwiICsgdGhpcy5pZCArIFwiLlwiKTtcbiAgfVxuXG4gIHZhciByZXNwb25zZVR5cGUgPSBzaWduYWwuamFudXM7XG4gIHZhciBoYW5kbGVycyA9IHRoaXMuZXZlbnRIYW5kbGVyc1tyZXNwb25zZVR5cGVdO1xuICBpZiAoaGFuZGxlcnMgIT0gbnVsbCkge1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgaGFuZGxlcnMubGVuZ3RoOyBpKyspIHtcbiAgICAgIGhhbmRsZXJzW2ldKHNpZ25hbCk7XG4gICAgfVxuICB9XG5cbiAgaWYgKHNpZ25hbC50cmFuc2FjdGlvbiAhPSBudWxsKSB7XG4gICAgdmFyIHR4biA9IHRoaXMudHhuc1tzaWduYWwudHJhbnNhY3Rpb25dO1xuICAgIGlmICh0eG4gPT0gbnVsbCkge1xuICAgICAgLy8gdGhpcyBpcyBhIHJlc3BvbnNlIHRvIGEgdHJhbnNhY3Rpb24gdGhhdCB3YXNuJ3QgY2F1c2VkIHZpYSBKYW51c1Nlc3Npb24uc2VuZCwgb3IgYSBwbHVnaW4gcmVwbGllZCB0d2ljZSB0byBhXG4gICAgICAvLyBzaW5nbGUgcmVxdWVzdCwgb3IgdGhlIHNlc3Npb24gd2FzIGRpc3Bvc2VkLCBvciBzb21ldGhpbmcgZWxzZSB0aGF0IGlzbid0IHVuZGVyIG91ciBwdXJ2aWV3OyB0aGF0J3MgZmluZVxuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGlmIChyZXNwb25zZVR5cGUgPT09IFwiYWNrXCIgJiYgdHhuLnR5cGUgPT0gXCJtZXNzYWdlXCIpIHtcbiAgICAgIC8vIHRoaXMgaXMgYW4gYWNrIG9mIGFuIGFzeW5jaHJvbm91c2x5LXByb2Nlc3NlZCBwbHVnaW4gcmVxdWVzdCwgd2Ugc2hvdWxkIHdhaXQgdG8gcmVzb2x2ZSB0aGUgcHJvbWlzZSB1bnRpbCB0aGVcbiAgICAgIC8vIGFjdHVhbCByZXNwb25zZSBjb21lcyBpblxuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNsZWFyVGltZW91dCh0eG4udGltZW91dCk7XG5cbiAgICBkZWxldGUgdGhpcy50eG5zW3NpZ25hbC50cmFuc2FjdGlvbl07XG4gICAgKHRoaXMuaXNFcnJvcihzaWduYWwpID8gdHhuLnJlamVjdCA6IHR4bi5yZXNvbHZlKShzaWduYWwpO1xuICB9XG59O1xuXG4vKipcbiAqIFNlbmRzIGEgc2lnbmFsIGFzc29jaWF0ZWQgd2l0aCB0aGlzIHNlc3Npb24sIGJlZ2lubmluZyBhIG5ldyB0cmFuc2FjdGlvbi4gUmV0dXJucyBhIHByb21pc2UgdGhhdCB3aWxsIGJlIHJlc29sdmVkIG9yXG4gKiByZWplY3RlZCB3aGVuIGEgcmVzcG9uc2UgaXMgcmVjZWl2ZWQgaW4gdGhlIHNhbWUgdHJhbnNhY3Rpb24sIG9yIHdoZW4gbm8gcmVzcG9uc2UgaXMgcmVjZWl2ZWQgd2l0aGluIHRoZSBzZXNzaW9uXG4gKiB0aW1lb3V0LlxuICoqL1xuSmFudXNTZXNzaW9uLnByb3RvdHlwZS5zZW5kID0gZnVuY3Rpb24odHlwZSwgc2lnbmFsKSB7XG4gIHNpZ25hbCA9IE9iamVjdC5hc3NpZ24oeyB0cmFuc2FjdGlvbjogKHRoaXMubmV4dFR4SWQrKykudG9TdHJpbmcoKSB9LCBzaWduYWwpO1xuICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgIHZhciB0aW1lb3V0ID0gbnVsbDtcbiAgICBpZiAodGhpcy5vcHRpb25zLnRpbWVvdXRNcykge1xuICAgICAgdGltZW91dCA9IHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgICBkZWxldGUgdGhpcy50eG5zW3NpZ25hbC50cmFuc2FjdGlvbl07XG4gICAgICAgIHJlamVjdChuZXcgRXJyb3IoXCJTaWduYWxsaW5nIHRyYW5zYWN0aW9uIHdpdGggdHhpZCBcIiArIHNpZ25hbC50cmFuc2FjdGlvbiArIFwiIHRpbWVkIG91dC5cIikpO1xuICAgICAgfSwgdGhpcy5vcHRpb25zLnRpbWVvdXRNcyk7XG4gICAgfVxuICAgIHRoaXMudHhuc1tzaWduYWwudHJhbnNhY3Rpb25dID0geyByZXNvbHZlOiByZXNvbHZlLCByZWplY3Q6IHJlamVjdCwgdGltZW91dDogdGltZW91dCwgdHlwZTogdHlwZSB9O1xuICAgIHRoaXMuX3RyYW5zbWl0KHR5cGUsIHNpZ25hbCk7XG4gIH0pO1xufTtcblxuSmFudXNTZXNzaW9uLnByb3RvdHlwZS5fdHJhbnNtaXQgPSBmdW5jdGlvbih0eXBlLCBzaWduYWwpIHtcbiAgc2lnbmFsID0gT2JqZWN0LmFzc2lnbih7IGphbnVzOiB0eXBlIH0sIHNpZ25hbCk7XG5cbiAgaWYgKHRoaXMuaWQgIT0gbnVsbCkgeyAvLyB0aGlzLmlkIGlzIHVuZGVmaW5lZCBpbiB0aGUgc3BlY2lhbCBjYXNlIHdoZW4gd2UncmUgc2VuZGluZyB0aGUgc2Vzc2lvbiBjcmVhdGUgbWVzc2FnZVxuICAgIHNpZ25hbCA9IE9iamVjdC5hc3NpZ24oeyBzZXNzaW9uX2lkOiB0aGlzLmlkIH0sIHNpZ25hbCk7XG4gIH1cblxuICBpZiAodGhpcy5vcHRpb25zLnZlcmJvc2UpIHtcbiAgICB0aGlzLl9sb2dPdXRnb2luZyhzaWduYWwpO1xuICB9XG5cbiAgdGhpcy5vdXRwdXQoSlNPTi5zdHJpbmdpZnkoc2lnbmFsKSk7XG4gIHRoaXMuX3Jlc2V0S2VlcGFsaXZlKCk7XG59O1xuXG5KYW51c1Nlc3Npb24ucHJvdG90eXBlLl9sb2dPdXRnb2luZyA9IGZ1bmN0aW9uKHNpZ25hbCkge1xuICB2YXIga2luZCA9IHNpZ25hbC5qYW51cztcbiAgaWYgKGtpbmQgPT09IFwibWVzc2FnZVwiICYmIHNpZ25hbC5qc2VwKSB7XG4gICAga2luZCA9IHNpZ25hbC5qc2VwLnR5cGU7XG4gIH1cbiAgdmFyIG1lc3NhZ2UgPSBcIj4gT3V0Z29pbmcgSmFudXMgXCIgKyAoa2luZCB8fCBcInNpZ25hbFwiKSArIFwiICgjXCIgKyBzaWduYWwudHJhbnNhY3Rpb24gKyBcIik6IFwiO1xuICBjb25zb2xlLmRlYnVnKFwiJWNcIiArIG1lc3NhZ2UsIFwiY29sb3I6ICMwNDBcIiwgc2lnbmFsKTtcbn07XG5cbkphbnVzU2Vzc2lvbi5wcm90b3R5cGUuX2xvZ0luY29taW5nID0gZnVuY3Rpb24oc2lnbmFsKSB7XG4gIHZhciBraW5kID0gc2lnbmFsLmphbnVzO1xuICB2YXIgbWVzc2FnZSA9IHNpZ25hbC50cmFuc2FjdGlvbiA/XG4gICAgICBcIjwgSW5jb21pbmcgSmFudXMgXCIgKyAoa2luZCB8fCBcInNpZ25hbFwiKSArIFwiICgjXCIgKyBzaWduYWwudHJhbnNhY3Rpb24gKyBcIik6IFwiIDpcbiAgICAgIFwiPCBJbmNvbWluZyBKYW51cyBcIiArIChraW5kIHx8IFwic2lnbmFsXCIpICsgXCI6IFwiO1xuICBjb25zb2xlLmRlYnVnKFwiJWNcIiArIG1lc3NhZ2UsIFwiY29sb3I6ICMwMDRcIiwgc2lnbmFsKTtcbn07XG5cbkphbnVzU2Vzc2lvbi5wcm90b3R5cGUuX3NlbmRLZWVwYWxpdmUgPSBmdW5jdGlvbigpIHtcbiAgcmV0dXJuIHRoaXMuc2VuZChcImtlZXBhbGl2ZVwiKTtcbn07XG5cbkphbnVzU2Vzc2lvbi5wcm90b3R5cGUuX2tpbGxLZWVwYWxpdmUgPSBmdW5jdGlvbigpIHtcbiAgY2xlYXJUaW1lb3V0KHRoaXMua2VlcGFsaXZlVGltZW91dCk7XG59O1xuXG5KYW51c1Nlc3Npb24ucHJvdG90eXBlLl9yZXNldEtlZXBhbGl2ZSA9IGZ1bmN0aW9uKCkge1xuICB0aGlzLl9raWxsS2VlcGFsaXZlKCk7XG4gIGlmICh0aGlzLm9wdGlvbnMua2VlcGFsaXZlTXMpIHtcbiAgICB0aGlzLmtlZXBhbGl2ZVRpbWVvdXQgPSBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICAgIHRoaXMuX3NlbmRLZWVwYWxpdmUoKS5jYXRjaChlID0+IGNvbnNvbGUuZXJyb3IoXCJFcnJvciByZWNlaXZlZCBmcm9tIGtlZXBhbGl2ZTogXCIsIGUpKTtcbiAgICB9LCB0aGlzLm9wdGlvbnMua2VlcGFsaXZlTXMpO1xuICB9XG59O1xuXG5tb2R1bGUuZXhwb3J0cyA9IHtcbiAgSmFudXNQbHVnaW5IYW5kbGUsXG4gIEphbnVzU2Vzc2lvblxufTtcbiIsIi8qIGdsb2JhbCBOQUYgKi9cbnZhciBtaiA9IHJlcXVpcmUoXCJAbmV0d29ya2VkLWFmcmFtZS9taW5pamFudXNcIik7XG5tai5KYW51c1Nlc3Npb24ucHJvdG90eXBlLnNlbmRPcmlnaW5hbCA9IG1qLkphbnVzU2Vzc2lvbi5wcm90b3R5cGUuc2VuZDtcbm1qLkphbnVzU2Vzc2lvbi5wcm90b3R5cGUuc2VuZCA9IGZ1bmN0aW9uKHR5cGUsIHNpZ25hbCkge1xuICByZXR1cm4gdGhpcy5zZW5kT3JpZ2luYWwodHlwZSwgc2lnbmFsKS5jYXRjaCgoZSkgPT4ge1xuICAgIGlmIChlLm1lc3NhZ2UgJiYgZS5tZXNzYWdlLmluZGV4T2YoXCJ0aW1lZCBvdXRcIikgPiAtMSkge1xuICAgICAgY29uc29sZS5lcnJvcihcIndlYiBzb2NrZXQgdGltZWQgb3V0XCIpO1xuICAgICAgTkFGLmNvbm5lY3Rpb24uYWRhcHRlci5yZWNvbm5lY3QoKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhyb3coZSk7XG4gICAgfVxuICB9KTtcbn1cblxudmFyIHNkcFV0aWxzID0gcmVxdWlyZShcInNkcFwiKTtcbi8vdmFyIGRlYnVnID0gcmVxdWlyZShcImRlYnVnXCIpKFwibmFmLWphbnVzLWFkYXB0ZXI6ZGVidWdcIik7XG4vL3ZhciB3YXJuID0gcmVxdWlyZShcImRlYnVnXCIpKFwibmFmLWphbnVzLWFkYXB0ZXI6d2FyblwiKTtcbi8vdmFyIGVycm9yID0gcmVxdWlyZShcImRlYnVnXCIpKFwibmFmLWphbnVzLWFkYXB0ZXI6ZXJyb3JcIik7XG52YXIgZGVidWcgPSBjb25zb2xlLmxvZztcbnZhciB3YXJuID0gY29uc29sZS53YXJuO1xudmFyIGVycm9yID0gY29uc29sZS5lcnJvcjtcbnZhciBpc1NhZmFyaSA9IC9eKCg/IWNocm9tZXxhbmRyb2lkKS4pKnNhZmFyaS9pLnRlc3QobmF2aWdhdG9yLnVzZXJBZ2VudCk7XG5cbmZ1bmN0aW9uIGRlYm91bmNlKGZuKSB7XG4gIHZhciBjdXJyID0gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIHJldHVybiBmdW5jdGlvbigpIHtcbiAgICB2YXIgYXJncyA9IEFycmF5LnByb3RvdHlwZS5zbGljZS5jYWxsKGFyZ3VtZW50cyk7XG4gICAgY3VyciA9IGN1cnIudGhlbihfID0+IGZuLmFwcGx5KHRoaXMsIGFyZ3MpKTtcbiAgfTtcbn1cblxuZnVuY3Rpb24gcmFuZG9tVWludCgpIHtcbiAgcmV0dXJuIE1hdGguZmxvb3IoTWF0aC5yYW5kb20oKSAqIE51bWJlci5NQVhfU0FGRV9JTlRFR0VSKTtcbn1cblxuZnVuY3Rpb24gdW50aWxEYXRhQ2hhbm5lbE9wZW4oZGF0YUNoYW5uZWwpIHtcbiAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICBpZiAoZGF0YUNoYW5uZWwucmVhZHlTdGF0ZSA9PT0gXCJvcGVuXCIpIHtcbiAgICAgIHJlc29sdmUoKTtcbiAgICB9IGVsc2Uge1xuICAgICAgbGV0IHJlc29sdmVyLCByZWplY3RvcjtcblxuICAgICAgY29uc3QgY2xlYXIgPSAoKSA9PiB7XG4gICAgICAgIGRhdGFDaGFubmVsLnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJvcGVuXCIsIHJlc29sdmVyKTtcbiAgICAgICAgZGF0YUNoYW5uZWwucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImVycm9yXCIsIHJlamVjdG9yKTtcbiAgICAgIH07XG5cbiAgICAgIHJlc29sdmVyID0gKCkgPT4ge1xuICAgICAgICBjbGVhcigpO1xuICAgICAgICByZXNvbHZlKCk7XG4gICAgICB9O1xuICAgICAgcmVqZWN0b3IgPSAoKSA9PiB7XG4gICAgICAgIGNsZWFyKCk7XG4gICAgICAgIHJlamVjdCgpO1xuICAgICAgfTtcblxuICAgICAgZGF0YUNoYW5uZWwuYWRkRXZlbnRMaXN0ZW5lcihcIm9wZW5cIiwgcmVzb2x2ZXIpO1xuICAgICAgZGF0YUNoYW5uZWwuYWRkRXZlbnRMaXN0ZW5lcihcImVycm9yXCIsIHJlamVjdG9yKTtcbiAgICB9XG4gIH0pO1xufVxuXG5jb25zdCBpc0gyNjRWaWRlb1N1cHBvcnRlZCA9ICgoKSA9PiB7XG4gIGNvbnN0IHZpZGVvID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInZpZGVvXCIpO1xuICByZXR1cm4gdmlkZW8uY2FuUGxheVR5cGUoJ3ZpZGVvL21wNDsgY29kZWNzPVwiYXZjMS40MkUwMUUsIG1wNGEuNDAuMlwiJykgIT09IFwiXCI7XG59KSgpO1xuXG5jb25zdCBPUFVTX1BBUkFNRVRFUlMgPSB7XG4gIC8vIGluZGljYXRlcyB0aGF0IHdlIHdhbnQgdG8gZW5hYmxlIERUWCB0byBlbGlkZSBzaWxlbmNlIHBhY2tldHNcbiAgdXNlZHR4OiAxLFxuICAvLyBpbmRpY2F0ZXMgdGhhdCB3ZSBwcmVmZXIgdG8gcmVjZWl2ZSBtb25vIGF1ZGlvIChpbXBvcnRhbnQgZm9yIHZvaXAgcHJvZmlsZSlcbiAgc3RlcmVvOiAwLFxuICAvLyBpbmRpY2F0ZXMgdGhhdCB3ZSBwcmVmZXIgdG8gc2VuZCBtb25vIGF1ZGlvIChpbXBvcnRhbnQgZm9yIHZvaXAgcHJvZmlsZSlcbiAgXCJzcHJvcC1zdGVyZW9cIjogMFxufTtcblxuY29uc3QgREVGQVVMVF9QRUVSX0NPTk5FQ1RJT05fQ09ORklHID0ge1xuICBpY2VTZXJ2ZXJzOiBbeyB1cmxzOiBcInN0dW46c3R1bjEubC5nb29nbGUuY29tOjE5MzAyXCIgfSwgeyB1cmxzOiBcInN0dW46c3R1bjIubC5nb29nbGUuY29tOjE5MzAyXCIgfV1cbn07XG5cbmNvbnN0IFdTX05PUk1BTF9DTE9TVVJFID0gMTAwMDtcblxuY2xhc3MgSmFudXNBZGFwdGVyIHtcbiAgY29uc3RydWN0b3IoKSB7XG4gICAgdGhpcy5yb29tID0gbnVsbDtcbiAgICAvLyBXZSBleHBlY3QgdGhlIGNvbnN1bWVyIHRvIHNldCBhIGNsaWVudCBpZCBiZWZvcmUgY29ubmVjdGluZy5cbiAgICB0aGlzLmNsaWVudElkID0gbnVsbDtcbiAgICB0aGlzLmpvaW5Ub2tlbiA9IG51bGw7XG5cbiAgICB0aGlzLnNlcnZlclVybCA9IG51bGw7XG4gICAgdGhpcy53ZWJSdGNPcHRpb25zID0ge307XG4gICAgdGhpcy5wZWVyQ29ubmVjdGlvbkNvbmZpZyA9IG51bGw7XG4gICAgdGhpcy53cyA9IG51bGw7XG4gICAgdGhpcy5zZXNzaW9uID0gbnVsbDtcbiAgICB0aGlzLnJlbGlhYmxlVHJhbnNwb3J0ID0gXCJkYXRhY2hhbm5lbFwiO1xuICAgIHRoaXMudW5yZWxpYWJsZVRyYW5zcG9ydCA9IFwiZGF0YWNoYW5uZWxcIjtcblxuICAgIC8vIEluIHRoZSBldmVudCB0aGUgc2VydmVyIHJlc3RhcnRzIGFuZCBhbGwgY2xpZW50cyBsb3NlIGNvbm5lY3Rpb24sIHJlY29ubmVjdCB3aXRoXG4gICAgLy8gc29tZSByYW5kb20gaml0dGVyIGFkZGVkIHRvIHByZXZlbnQgc2ltdWx0YW5lb3VzIHJlY29ubmVjdGlvbiByZXF1ZXN0cy5cbiAgICB0aGlzLmluaXRpYWxSZWNvbm5lY3Rpb25EZWxheSA9IDEwMDAgKiBNYXRoLnJhbmRvbSgpO1xuICAgIHRoaXMucmVjb25uZWN0aW9uRGVsYXkgPSB0aGlzLmluaXRpYWxSZWNvbm5lY3Rpb25EZWxheTtcbiAgICB0aGlzLnJlY29ubmVjdGlvblRpbWVvdXQgPSBudWxsO1xuICAgIHRoaXMubWF4UmVjb25uZWN0aW9uQXR0ZW1wdHMgPSAxMDtcbiAgICB0aGlzLnJlY29ubmVjdGlvbkF0dGVtcHRzID0gMDtcblxuICAgIHRoaXMucHVibGlzaGVyID0gbnVsbDtcbiAgICB0aGlzLm9jY3VwYW50cyA9IHt9O1xuICAgIHRoaXMubGVmdE9jY3VwYW50cyA9IG5ldyBTZXQoKTtcbiAgICB0aGlzLm1lZGlhU3RyZWFtcyA9IHt9O1xuICAgIHRoaXMubG9jYWxNZWRpYVN0cmVhbSA9IG51bGw7XG4gICAgdGhpcy5wZW5kaW5nTWVkaWFSZXF1ZXN0cyA9IG5ldyBNYXAoKTtcblxuICAgIHRoaXMuYmxvY2tlZENsaWVudHMgPSBuZXcgTWFwKCk7XG4gICAgdGhpcy5mcm96ZW5VcGRhdGVzID0gbmV3IE1hcCgpO1xuXG4gICAgdGhpcy50aW1lT2Zmc2V0cyA9IFtdO1xuICAgIHRoaXMuc2VydmVyVGltZVJlcXVlc3RzID0gMDtcbiAgICB0aGlzLmF2Z1RpbWVPZmZzZXQgPSAwO1xuXG4gICAgdGhpcy5vbldlYnNvY2tldE9wZW4gPSB0aGlzLm9uV2Vic29ja2V0T3Blbi5iaW5kKHRoaXMpO1xuICAgIHRoaXMub25XZWJzb2NrZXRDbG9zZSA9IHRoaXMub25XZWJzb2NrZXRDbG9zZS5iaW5kKHRoaXMpO1xuICAgIHRoaXMub25XZWJzb2NrZXRNZXNzYWdlID0gdGhpcy5vbldlYnNvY2tldE1lc3NhZ2UuYmluZCh0aGlzKTtcbiAgICB0aGlzLm9uRGF0YUNoYW5uZWxNZXNzYWdlID0gdGhpcy5vbkRhdGFDaGFubmVsTWVzc2FnZS5iaW5kKHRoaXMpO1xuICAgIHRoaXMub25EYXRhID0gdGhpcy5vbkRhdGEuYmluZCh0aGlzKTtcbiAgfVxuXG4gIHNldFNlcnZlclVybCh1cmwpIHtcbiAgICB0aGlzLnNlcnZlclVybCA9IHVybDtcbiAgfVxuXG4gIHNldEFwcChhcHApIHt9XG5cbiAgc2V0Um9vbShyb29tTmFtZSkge1xuICAgIHRoaXMucm9vbSA9IHJvb21OYW1lO1xuICB9XG5cbiAgc2V0Sm9pblRva2VuKGpvaW5Ub2tlbikge1xuICAgIHRoaXMuam9pblRva2VuID0gam9pblRva2VuO1xuICB9XG5cbiAgc2V0Q2xpZW50SWQoY2xpZW50SWQpIHtcbiAgICB0aGlzLmNsaWVudElkID0gY2xpZW50SWQ7XG4gIH1cblxuICBzZXRXZWJSdGNPcHRpb25zKG9wdGlvbnMpIHtcbiAgICB0aGlzLndlYlJ0Y09wdGlvbnMgPSBvcHRpb25zO1xuICB9XG5cbiAgc2V0UGVlckNvbm5lY3Rpb25Db25maWcocGVlckNvbm5lY3Rpb25Db25maWcpIHtcbiAgICB0aGlzLnBlZXJDb25uZWN0aW9uQ29uZmlnID0gcGVlckNvbm5lY3Rpb25Db25maWc7XG4gIH1cblxuICBzZXRTZXJ2ZXJDb25uZWN0TGlzdGVuZXJzKHN1Y2Nlc3NMaXN0ZW5lciwgZmFpbHVyZUxpc3RlbmVyKSB7XG4gICAgdGhpcy5jb25uZWN0U3VjY2VzcyA9IHN1Y2Nlc3NMaXN0ZW5lcjtcbiAgICB0aGlzLmNvbm5lY3RGYWlsdXJlID0gZmFpbHVyZUxpc3RlbmVyO1xuICB9XG5cbiAgc2V0Um9vbU9jY3VwYW50TGlzdGVuZXIob2NjdXBhbnRMaXN0ZW5lcikge1xuICAgIGlmICh0aGlzLm9uT2NjdXBhbnRzQ2hhbmdlZCkge1xuICAgICAgdGhpcy5vbk9jY3VwYW50c0NoYW5nZWQucHVzaChvY2N1cGFudExpc3RlbmVyKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgIHRoaXMub25PY2N1cGFudHNDaGFuZ2VkID0gW29jY3VwYW50TGlzdGVuZXJdO1xuICB9XG5cbiAgc2V0RGF0YUNoYW5uZWxMaXN0ZW5lcnMob3Blbkxpc3RlbmVyLCBjbG9zZWRMaXN0ZW5lciwgbWVzc2FnZUxpc3RlbmVyKSB7XG4gICAgdGhpcy5vbk9jY3VwYW50Q29ubmVjdGVkID0gb3Blbkxpc3RlbmVyO1xuICAgIHRoaXMub25PY2N1cGFudERpc2Nvbm5lY3RlZCA9IGNsb3NlZExpc3RlbmVyO1xuICAgIHRoaXMub25PY2N1cGFudE1lc3NhZ2UgPSBtZXNzYWdlTGlzdGVuZXI7XG4gIH1cblxuICBzZXRSZWNvbm5lY3Rpb25MaXN0ZW5lcnMocmVjb25uZWN0aW5nTGlzdGVuZXIsIHJlY29ubmVjdGVkTGlzdGVuZXIsIHJlY29ubmVjdGlvbkVycm9yTGlzdGVuZXIpIHtcbiAgICAvLyBvblJlY29ubmVjdGluZyBpcyBjYWxsZWQgd2l0aCB0aGUgbnVtYmVyIG9mIG1pbGxpc2Vjb25kcyB1bnRpbCB0aGUgbmV4dCByZWNvbm5lY3Rpb24gYXR0ZW1wdFxuICAgIHRoaXMub25SZWNvbm5lY3RpbmcgPSByZWNvbm5lY3RpbmdMaXN0ZW5lcjtcbiAgICAvLyBvblJlY29ubmVjdGVkIGlzIGNhbGxlZCB3aGVuIHRoZSBjb25uZWN0aW9uIGhhcyBiZWVuIHJlZXN0YWJsaXNoZWRcbiAgICB0aGlzLm9uUmVjb25uZWN0ZWQgPSByZWNvbm5lY3RlZExpc3RlbmVyO1xuICAgIC8vIG9uUmVjb25uZWN0aW9uRXJyb3IgaXMgY2FsbGVkIHdpdGggYW4gZXJyb3Igd2hlbiBtYXhSZWNvbm5lY3Rpb25BdHRlbXB0cyBoYXMgYmVlbiByZWFjaGVkXG4gICAgdGhpcy5vblJlY29ubmVjdGlvbkVycm9yID0gcmVjb25uZWN0aW9uRXJyb3JMaXN0ZW5lcjtcbiAgfVxuXG4gIHNldEV2ZW50TG9vcHMobG9vcHMpIHtcbiAgICB0aGlzLmxvb3BzID0gbG9vcHM7XG4gIH1cblxuICBjb25uZWN0KCkge1xuICAgIGRlYnVnKGBjb25uZWN0aW5nIHRvICR7dGhpcy5zZXJ2ZXJVcmx9YCk7XG5cbiAgICBjb25zdCB3ZWJzb2NrZXRDb25uZWN0aW9uID0gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgICAgdGhpcy53cyA9IG5ldyBXZWJTb2NrZXQodGhpcy5zZXJ2ZXJVcmwsIFwiamFudXMtcHJvdG9jb2xcIik7XG5cbiAgICAgIHRoaXMuc2Vzc2lvbiA9IG5ldyBtai5KYW51c1Nlc3Npb24odGhpcy53cy5zZW5kLmJpbmQodGhpcy53cyksIHsgdGltZW91dE1zOiA0MDAwMCB9KTtcblxuICAgICAgdGhpcy53cy5hZGRFdmVudExpc3RlbmVyKFwiY2xvc2VcIiwgdGhpcy5vbldlYnNvY2tldENsb3NlKTtcbiAgICAgIHRoaXMud3MuYWRkRXZlbnRMaXN0ZW5lcihcIm1lc3NhZ2VcIiwgdGhpcy5vbldlYnNvY2tldE1lc3NhZ2UpO1xuXG4gICAgICB0aGlzLndzT25PcGVuID0gKCkgPT4ge1xuICAgICAgICB0aGlzLndzLnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJvcGVuXCIsIHRoaXMud3NPbk9wZW4pO1xuICAgICAgICB0aGlzLm9uV2Vic29ja2V0T3BlbigpXG4gICAgICAgICAgLnRoZW4ocmVzb2x2ZSlcbiAgICAgICAgICAuY2F0Y2gocmVqZWN0KTtcbiAgICAgIH07XG5cbiAgICAgIHRoaXMud3MuYWRkRXZlbnRMaXN0ZW5lcihcIm9wZW5cIiwgdGhpcy53c09uT3Blbik7XG4gICAgfSk7XG5cbiAgICByZXR1cm4gUHJvbWlzZS5hbGwoW3dlYnNvY2tldENvbm5lY3Rpb24sIHRoaXMudXBkYXRlVGltZU9mZnNldCgpXSk7XG4gIH1cblxuICBkaXNjb25uZWN0KCkge1xuICAgIGRlYnVnKGBkaXNjb25uZWN0aW5nYCk7XG5cbiAgICBjbGVhclRpbWVvdXQodGhpcy5yZWNvbm5lY3Rpb25UaW1lb3V0KTtcblxuICAgIHRoaXMucmVtb3ZlQWxsT2NjdXBhbnRzKCk7XG4gICAgdGhpcy5sZWZ0T2NjdXBhbnRzID0gbmV3IFNldCgpO1xuXG4gICAgaWYgKHRoaXMucHVibGlzaGVyKSB7XG4gICAgICAvLyBDbG9zZSB0aGUgcHVibGlzaGVyIHBlZXIgY29ubmVjdGlvbi4gV2hpY2ggYWxzbyBkZXRhY2hlcyB0aGUgcGx1Z2luIGhhbmRsZS5cbiAgICAgIHRoaXMucHVibGlzaGVyLmNvbm4uY2xvc2UoKTtcbiAgICAgIHRoaXMucHVibGlzaGVyID0gbnVsbDtcbiAgICB9XG5cbiAgICBpZiAodGhpcy5zZXNzaW9uKSB7XG4gICAgICB0aGlzLnNlc3Npb24uZGlzcG9zZSgpO1xuICAgICAgdGhpcy5zZXNzaW9uID0gbnVsbDtcbiAgICB9XG5cbiAgICBpZiAodGhpcy53cykge1xuICAgICAgdGhpcy53cy5yZW1vdmVFdmVudExpc3RlbmVyKFwib3BlblwiLCB0aGlzLndzT25PcGVuKTtcbiAgICAgIHRoaXMud3MucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImNsb3NlXCIsIHRoaXMub25XZWJzb2NrZXRDbG9zZSk7XG4gICAgICB0aGlzLndzLnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJtZXNzYWdlXCIsIHRoaXMub25XZWJzb2NrZXRNZXNzYWdlKTtcbiAgICAgIHRoaXMud3MuY2xvc2UoKTtcbiAgICAgIHRoaXMud3MgPSBudWxsO1xuICAgIH1cblxuICAgIC8vIE5vdyB0aGF0IGFsbCBSVENQZWVyQ29ubmVjdGlvbiBjbG9zZWQsIGJlIHN1cmUgdG8gbm90IGNhbGxcbiAgICAvLyByZWNvbm5lY3QoKSBhZ2FpbiB2aWEgcGVyZm9ybURlbGF5ZWRSZWNvbm5lY3QgaWYgcHJldmlvdXNcbiAgICAvLyBSVENQZWVyQ29ubmVjdGlvbiB3YXMgaW4gdGhlIGZhaWxlZCBzdGF0ZS5cbiAgICBpZiAodGhpcy5kZWxheWVkUmVjb25uZWN0VGltZW91dCkge1xuICAgICAgY2xlYXJUaW1lb3V0KHRoaXMuZGVsYXllZFJlY29ubmVjdFRpbWVvdXQpO1xuICAgICAgdGhpcy5kZWxheWVkUmVjb25uZWN0VGltZW91dCA9IG51bGw7XG4gICAgfVxuICB9XG5cbiAgaXNEaXNjb25uZWN0ZWQoKSB7XG4gICAgcmV0dXJuIHRoaXMud3MgPT09IG51bGw7XG4gIH1cblxuICBhc3luYyBvbldlYnNvY2tldE9wZW4oKSB7XG4gICAgLy8gQ3JlYXRlIHRoZSBKYW51cyBTZXNzaW9uXG4gICAgYXdhaXQgdGhpcy5zZXNzaW9uLmNyZWF0ZSgpO1xuXG4gICAgLy8gQXR0YWNoIHRoZSBTRlUgUGx1Z2luIGFuZCBjcmVhdGUgYSBSVENQZWVyQ29ubmVjdGlvbiBmb3IgdGhlIHB1Ymxpc2hlci5cbiAgICAvLyBUaGUgcHVibGlzaGVyIHNlbmRzIGF1ZGlvIGFuZCBvcGVucyB0d28gYmlkaXJlY3Rpb25hbCBkYXRhIGNoYW5uZWxzLlxuICAgIC8vIE9uZSByZWxpYWJsZSBkYXRhY2hhbm5lbCBhbmQgb25lIHVucmVsaWFibGUuXG4gICAgdGhpcy5wdWJsaXNoZXIgPSBhd2FpdCB0aGlzLmNyZWF0ZVB1Ymxpc2hlcigpO1xuXG4gICAgLy8gQ2FsbCB0aGUgbmFmIGNvbm5lY3RTdWNjZXNzIGNhbGxiYWNrIGJlZm9yZSB3ZSBzdGFydCByZWNlaXZpbmcgV2ViUlRDIG1lc3NhZ2VzLlxuICAgIHRoaXMuY29ubmVjdFN1Y2Nlc3ModGhpcy5jbGllbnRJZCk7XG5cbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IHRoaXMucHVibGlzaGVyLmluaXRpYWxPY2N1cGFudHMubGVuZ3RoOyBpKyspIHtcbiAgICAgIGNvbnN0IG9jY3VwYW50SWQgPSB0aGlzLnB1Ymxpc2hlci5pbml0aWFsT2NjdXBhbnRzW2ldO1xuICAgICAgaWYgKG9jY3VwYW50SWQgPT09IHRoaXMuY2xpZW50SWQpIGNvbnRpbnVlOyAvLyBIYXBwZW5zIGR1cmluZyBub24tZ3JhY2VmdWwgcmVjb25uZWN0cyBkdWUgdG8gem9tYmllIHNlc3Npb25zXG5cbiAgICAgIGF3YWl0IHRoaXMuYWRkT2NjdXBhbnQob2NjdXBhbnRJZCk7XG4gICAgfVxuICB9XG5cbiAgb25XZWJzb2NrZXRDbG9zZShldmVudCkge1xuICAgIC8vIFRoZSBjb25uZWN0aW9uIHdhcyBjbG9zZWQgc3VjY2Vzc2Z1bGx5LiBEb24ndCB0cnkgdG8gcmVjb25uZWN0LlxuICAgIGlmIChldmVudC5jb2RlID09PSBXU19OT1JNQUxfQ0xPU1VSRSkge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnNvbGUud2FybihcIkphbnVzIHdlYnNvY2tldCBjbG9zZWQgdW5leHBlY3RlZGx5LlwiKTtcbiAgICBpZiAodGhpcy5vblJlY29ubmVjdGluZykge1xuICAgICAgdGhpcy5vblJlY29ubmVjdGluZyh0aGlzLnJlY29ubmVjdGlvbkRlbGF5KTtcbiAgICB9XG5cbiAgICB0aGlzLnJlY29ubmVjdGlvblRpbWVvdXQgPSBzZXRUaW1lb3V0KCgpID0+IHRoaXMucmVjb25uZWN0KCksIHRoaXMucmVjb25uZWN0aW9uRGVsYXkpO1xuICB9XG5cbiAgcmVjb25uZWN0KCkge1xuICAgIC8vIERpc3Bvc2Ugb2YgYWxsIG5ldHdvcmtlZCBlbnRpdGllcyBhbmQgb3RoZXIgcmVzb3VyY2VzIHRpZWQgdG8gdGhlIHNlc3Npb24uXG4gICAgdGhpcy5kaXNjb25uZWN0KCk7XG5cbiAgICB0aGlzLmNvbm5lY3QoKVxuICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICB0aGlzLnJlY29ubmVjdGlvbkRlbGF5ID0gdGhpcy5pbml0aWFsUmVjb25uZWN0aW9uRGVsYXk7XG4gICAgICAgIHRoaXMucmVjb25uZWN0aW9uQXR0ZW1wdHMgPSAwO1xuXG4gICAgICAgIGlmICh0aGlzLm9uUmVjb25uZWN0ZWQpIHtcbiAgICAgICAgICB0aGlzLm9uUmVjb25uZWN0ZWQoKTtcbiAgICAgICAgfVxuICAgICAgfSlcbiAgICAgIC5jYXRjaChlcnJvciA9PiB7XG4gICAgICAgIHRoaXMucmVjb25uZWN0aW9uRGVsYXkgKz0gMTAwMDtcbiAgICAgICAgdGhpcy5yZWNvbm5lY3Rpb25BdHRlbXB0cysrO1xuXG4gICAgICAgIGlmICh0aGlzLnJlY29ubmVjdGlvbkF0dGVtcHRzID4gdGhpcy5tYXhSZWNvbm5lY3Rpb25BdHRlbXB0cyAmJiB0aGlzLm9uUmVjb25uZWN0aW9uRXJyb3IpIHtcbiAgICAgICAgICByZXR1cm4gdGhpcy5vblJlY29ubmVjdGlvbkVycm9yKFxuICAgICAgICAgICAgbmV3IEVycm9yKFwiQ29ubmVjdGlvbiBjb3VsZCBub3QgYmUgcmVlc3RhYmxpc2hlZCwgZXhjZWVkZWQgbWF4aW11bSBudW1iZXIgb2YgcmVjb25uZWN0aW9uIGF0dGVtcHRzLlwiKVxuICAgICAgICAgICk7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zb2xlLndhcm4oXCJFcnJvciBkdXJpbmcgcmVjb25uZWN0LCByZXRyeWluZy5cIik7XG4gICAgICAgIGNvbnNvbGUud2FybihlcnJvcik7XG5cbiAgICAgICAgaWYgKHRoaXMub25SZWNvbm5lY3RpbmcpIHtcbiAgICAgICAgICB0aGlzLm9uUmVjb25uZWN0aW5nKHRoaXMucmVjb25uZWN0aW9uRGVsYXkpO1xuICAgICAgICB9XG5cbiAgICAgICAgdGhpcy5yZWNvbm5lY3Rpb25UaW1lb3V0ID0gc2V0VGltZW91dCgoKSA9PiB0aGlzLnJlY29ubmVjdCgpLCB0aGlzLnJlY29ubmVjdGlvbkRlbGF5KTtcbiAgICAgIH0pO1xuICB9XG5cbiAgcGVyZm9ybURlbGF5ZWRSZWNvbm5lY3QoKSB7XG4gICAgaWYgKHRoaXMuZGVsYXllZFJlY29ubmVjdFRpbWVvdXQpIHtcbiAgICAgIGNsZWFyVGltZW91dCh0aGlzLmRlbGF5ZWRSZWNvbm5lY3RUaW1lb3V0KTtcbiAgICB9XG5cbiAgICB0aGlzLmRlbGF5ZWRSZWNvbm5lY3RUaW1lb3V0ID0gc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICB0aGlzLmRlbGF5ZWRSZWNvbm5lY3RUaW1lb3V0ID0gbnVsbDtcbiAgICAgIHRoaXMucmVjb25uZWN0KCk7XG4gICAgfSwgMTAwMDApO1xuICB9XG5cbiAgb25XZWJzb2NrZXRNZXNzYWdlKGV2ZW50KSB7XG4gICAgdGhpcy5zZXNzaW9uLnJlY2VpdmUoSlNPTi5wYXJzZShldmVudC5kYXRhKSk7XG4gIH1cblxuICBhc3luYyBhZGRPY2N1cGFudChvY2N1cGFudElkKSB7XG4gICAgaWYgKHRoaXMub2NjdXBhbnRzW29jY3VwYW50SWRdKSB7XG4gICAgICB0aGlzLnJlbW92ZU9jY3VwYW50KG9jY3VwYW50SWQpO1xuICAgIH1cblxuICAgIHRoaXMubGVmdE9jY3VwYW50cy5kZWxldGUob2NjdXBhbnRJZCk7XG5cbiAgICB2YXIgc3Vic2NyaWJlciA9IGF3YWl0IHRoaXMuY3JlYXRlU3Vic2NyaWJlcihvY2N1cGFudElkKTtcblxuICAgIGlmICghc3Vic2NyaWJlcikgcmV0dXJuO1xuXG4gICAgdGhpcy5vY2N1cGFudHNbb2NjdXBhbnRJZF0gPSBzdWJzY3JpYmVyO1xuXG4gICAgdGhpcy5zZXRNZWRpYVN0cmVhbShvY2N1cGFudElkLCBzdWJzY3JpYmVyLm1lZGlhU3RyZWFtKTtcblxuICAgIC8vIENhbGwgdGhlIE5ldHdvcmtlZCBBRnJhbWUgY2FsbGJhY2tzIGZvciB0aGUgbmV3IG9jY3VwYW50LlxuICAgIHRoaXMub25PY2N1cGFudENvbm5lY3RlZChvY2N1cGFudElkKTtcbiAgICB0aGlzLm9uT2NjdXBhbnRzQ2hhbmdlZC5mb3JFYWNoKChsaXN0ZW5lcikgPT4gbGlzdGVuZXIodGhpcy5vY2N1cGFudHMpKTtcblxuICAgIHJldHVybiBzdWJzY3JpYmVyO1xuICB9XG5cbiAgcmVtb3ZlQWxsT2NjdXBhbnRzKCkge1xuICAgIGZvciAoY29uc3Qgb2NjdXBhbnRJZCBvZiBPYmplY3QuZ2V0T3duUHJvcGVydHlOYW1lcyh0aGlzLm9jY3VwYW50cykpIHtcbiAgICAgIHRoaXMucmVtb3ZlT2NjdXBhbnQob2NjdXBhbnRJZCk7XG4gICAgfVxuICB9XG5cbiAgcmVtb3ZlT2NjdXBhbnQob2NjdXBhbnRJZCkge1xuICAgIHRoaXMubGVmdE9jY3VwYW50cy5hZGQob2NjdXBhbnRJZCk7XG5cbiAgICBpZiAodGhpcy5vY2N1cGFudHNbb2NjdXBhbnRJZF0pIHtcbiAgICAgIC8vIENsb3NlIHRoZSBzdWJzY3JpYmVyIHBlZXIgY29ubmVjdGlvbi4gV2hpY2ggYWxzbyBkZXRhY2hlcyB0aGUgcGx1Z2luIGhhbmRsZS5cbiAgICAgIHRoaXMub2NjdXBhbnRzW29jY3VwYW50SWRdLmNvbm4uY2xvc2UoKTtcbiAgICAgIGRlbGV0ZSB0aGlzLm9jY3VwYW50c1tvY2N1cGFudElkXTtcbiAgICB9XG5cbiAgICBpZiAodGhpcy5tZWRpYVN0cmVhbXNbb2NjdXBhbnRJZF0pIHtcbiAgICAgIGRlbGV0ZSB0aGlzLm1lZGlhU3RyZWFtc1tvY2N1cGFudElkXTtcbiAgICB9XG5cbiAgICBpZiAodGhpcy5wZW5kaW5nTWVkaWFSZXF1ZXN0cy5oYXMob2NjdXBhbnRJZCkpIHtcbiAgICAgIGNvbnN0IG1zZyA9IFwiVGhlIHVzZXIgZGlzY29ubmVjdGVkIGJlZm9yZSB0aGUgbWVkaWEgc3RyZWFtIHdhcyByZXNvbHZlZC5cIjtcbiAgICAgIHRoaXMucGVuZGluZ01lZGlhUmVxdWVzdHMuZ2V0KG9jY3VwYW50SWQpLmF1ZGlvLnJlamVjdChtc2cpO1xuICAgICAgdGhpcy5wZW5kaW5nTWVkaWFSZXF1ZXN0cy5nZXQob2NjdXBhbnRJZCkudmlkZW8ucmVqZWN0KG1zZyk7XG4gICAgICB0aGlzLnBlbmRpbmdNZWRpYVJlcXVlc3RzLmRlbGV0ZShvY2N1cGFudElkKTtcbiAgICB9XG5cbiAgICAvLyBDYWxsIHRoZSBOZXR3b3JrZWQgQUZyYW1lIGNhbGxiYWNrcyBmb3IgdGhlIHJlbW92ZWQgb2NjdXBhbnQuXG4gICAgdGhpcy5vbk9jY3VwYW50RGlzY29ubmVjdGVkKG9jY3VwYW50SWQpO1xuICAgIHRoaXMub25PY2N1cGFudHNDaGFuZ2VkLmZvckVhY2goKGxpc3RlbmVyKSA9PiBsaXN0ZW5lcih0aGlzLm9jY3VwYW50cykpO1xuICB9XG5cbiAgYXNzb2NpYXRlKGNvbm4sIGhhbmRsZSkge1xuICAgIGNvbm4uYWRkRXZlbnRMaXN0ZW5lcihcImljZWNhbmRpZGF0ZVwiLCBldiA9PiB7XG4gICAgICBoYW5kbGUuc2VuZFRyaWNrbGUoZXYuY2FuZGlkYXRlIHx8IG51bGwpLmNhdGNoKGUgPT4gZXJyb3IoXCJFcnJvciB0cmlja2xpbmcgSUNFOiAlb1wiLCBlKSk7XG4gICAgfSk7XG4gICAgY29ubi5hZGRFdmVudExpc3RlbmVyKFwiaWNlY29ubmVjdGlvbnN0YXRlY2hhbmdlXCIsIGV2ID0+IHtcbiAgICAgIGlmIChjb25uLmljZUNvbm5lY3Rpb25TdGF0ZSA9PT0gXCJjb25uZWN0ZWRcIikge1xuICAgICAgICBjb25zb2xlLmxvZyhcIklDRSBzdGF0ZSBjaGFuZ2VkIHRvIGNvbm5lY3RlZFwiKTtcbiAgICAgIH1cbiAgICAgIGlmIChjb25uLmljZUNvbm5lY3Rpb25TdGF0ZSA9PT0gXCJkaXNjb25uZWN0ZWRcIikge1xuICAgICAgICBjb25zb2xlLndhcm4oXCJJQ0Ugc3RhdGUgY2hhbmdlZCB0byBkaXNjb25uZWN0ZWRcIik7XG4gICAgICB9XG4gICAgICBpZiAoY29ubi5pY2VDb25uZWN0aW9uU3RhdGUgPT09IFwiZmFpbGVkXCIpIHtcbiAgICAgICAgY29uc29sZS53YXJuKFwiSUNFIGZhaWx1cmUgZGV0ZWN0ZWQuIFJlY29ubmVjdGluZyBpbiAxMHMuXCIpO1xuICAgICAgICB0aGlzLnBlcmZvcm1EZWxheWVkUmVjb25uZWN0KCk7XG4gICAgICB9XG4gICAgfSlcblxuICAgIC8vIHdlIGhhdmUgdG8gZGVib3VuY2UgdGhlc2UgYmVjYXVzZSBqYW51cyBnZXRzIGFuZ3J5IGlmIHlvdSBzZW5kIGl0IGEgbmV3IFNEUCBiZWZvcmVcbiAgICAvLyBpdCdzIGZpbmlzaGVkIHByb2Nlc3NpbmcgYW4gZXhpc3RpbmcgU0RQLiBpbiBhY3R1YWxpdHksIGl0IHNlZW1zIGxpa2UgdGhpcyBpcyBtYXliZVxuICAgIC8vIHRvbyBsaWJlcmFsIGFuZCB3ZSBuZWVkIHRvIHdhaXQgc29tZSBhbW91bnQgb2YgdGltZSBhZnRlciBhbiBvZmZlciBiZWZvcmUgc2VuZGluZyBhbm90aGVyLFxuICAgIC8vIGJ1dCB3ZSBkb24ndCBjdXJyZW50bHkga25vdyBhbnkgZ29vZCB3YXkgb2YgZGV0ZWN0aW5nIGV4YWN0bHkgaG93IGxvbmcgOihcbiAgICBjb25uLmFkZEV2ZW50TGlzdGVuZXIoXG4gICAgICBcIm5lZ290aWF0aW9ubmVlZGVkXCIsXG4gICAgICBkZWJvdW5jZShldiA9PiB7XG4gICAgICAgIGRlYnVnKFwiU2VuZGluZyBuZXcgb2ZmZXIgZm9yIGhhbmRsZTogJW9cIiwgaGFuZGxlKTtcbiAgICAgICAgdmFyIG9mZmVyID0gY29ubi5jcmVhdGVPZmZlcigpLnRoZW4odGhpcy5jb25maWd1cmVQdWJsaXNoZXJTZHApLnRoZW4odGhpcy5maXhTYWZhcmlJY2VVRnJhZyk7XG4gICAgICAgIHZhciBsb2NhbCA9IG9mZmVyLnRoZW4obyA9PiBjb25uLnNldExvY2FsRGVzY3JpcHRpb24obykpO1xuICAgICAgICB2YXIgcmVtb3RlID0gb2ZmZXI7XG5cbiAgICAgICAgcmVtb3RlID0gcmVtb3RlXG4gICAgICAgICAgLnRoZW4odGhpcy5maXhTYWZhcmlJY2VVRnJhZylcbiAgICAgICAgICAudGhlbihqID0+IGhhbmRsZS5zZW5kSnNlcChqKSlcbiAgICAgICAgICAudGhlbihyID0+IGNvbm4uc2V0UmVtb3RlRGVzY3JpcHRpb24oci5qc2VwKSk7XG4gICAgICAgIHJldHVybiBQcm9taXNlLmFsbChbbG9jYWwsIHJlbW90ZV0pLmNhdGNoKGUgPT4gZXJyb3IoXCJFcnJvciBuZWdvdGlhdGluZyBvZmZlcjogJW9cIiwgZSkpO1xuICAgICAgfSlcbiAgICApO1xuICAgIGhhbmRsZS5vbihcbiAgICAgIFwiZXZlbnRcIixcbiAgICAgIGRlYm91bmNlKGV2ID0+IHtcbiAgICAgICAgdmFyIGpzZXAgPSBldi5qc2VwO1xuICAgICAgICBpZiAoanNlcCAmJiBqc2VwLnR5cGUgPT0gXCJvZmZlclwiKSB7XG4gICAgICAgICAgZGVidWcoXCJBY2NlcHRpbmcgbmV3IG9mZmVyIGZvciBoYW5kbGU6ICVvXCIsIGhhbmRsZSk7XG4gICAgICAgICAgdmFyIGFuc3dlciA9IGNvbm5cbiAgICAgICAgICAgIC5zZXRSZW1vdGVEZXNjcmlwdGlvbih0aGlzLmNvbmZpZ3VyZVN1YnNjcmliZXJTZHAoanNlcCkpXG4gICAgICAgICAgICAudGhlbihfID0+IGNvbm4uY3JlYXRlQW5zd2VyKCkpXG4gICAgICAgICAgICAudGhlbih0aGlzLmZpeFNhZmFyaUljZVVGcmFnKTtcbiAgICAgICAgICB2YXIgbG9jYWwgPSBhbnN3ZXIudGhlbihhID0+IGNvbm4uc2V0TG9jYWxEZXNjcmlwdGlvbihhKSk7XG4gICAgICAgICAgdmFyIHJlbW90ZSA9IGFuc3dlci50aGVuKGogPT4gaGFuZGxlLnNlbmRKc2VwKGopKTtcbiAgICAgICAgICByZXR1cm4gUHJvbWlzZS5hbGwoW2xvY2FsLCByZW1vdGVdKS5jYXRjaChlID0+IGVycm9yKFwiRXJyb3IgbmVnb3RpYXRpbmcgYW5zd2VyOiAlb1wiLCBlKSk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgLy8gc29tZSBvdGhlciBraW5kIG9mIGV2ZW50LCBub3RoaW5nIHRvIGRvXG4gICAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICAgIH1cbiAgICAgIH0pXG4gICAgKTtcbiAgfVxuXG4gIGFzeW5jIGNyZWF0ZVB1Ymxpc2hlcigpIHtcbiAgICB2YXIgaGFuZGxlID0gbmV3IG1qLkphbnVzUGx1Z2luSGFuZGxlKHRoaXMuc2Vzc2lvbik7XG4gICAgdmFyIGNvbm4gPSBuZXcgUlRDUGVlckNvbm5lY3Rpb24odGhpcy5wZWVyQ29ubmVjdGlvbkNvbmZpZyB8fCBERUZBVUxUX1BFRVJfQ09OTkVDVElPTl9DT05GSUcpO1xuXG4gICAgZGVidWcoXCJwdWIgd2FpdGluZyBmb3Igc2Z1XCIpO1xuICAgIGF3YWl0IGhhbmRsZS5hdHRhY2goXCJqYW51cy5wbHVnaW4uc2Z1XCIsIHRoaXMubG9vcHMgJiYgdGhpcy5jbGllbnRJZCA/IHBhcnNlSW50KHRoaXMuY2xpZW50SWQpICUgdGhpcy5sb29wcyA6IHVuZGVmaW5lZCk7XG5cbiAgICB0aGlzLmFzc29jaWF0ZShjb25uLCBoYW5kbGUpO1xuXG4gICAgZGVidWcoXCJwdWIgd2FpdGluZyBmb3IgZGF0YSBjaGFubmVscyAmIHdlYnJ0Y3VwXCIpO1xuICAgIHZhciB3ZWJydGN1cCA9IG5ldyBQcm9taXNlKHJlc29sdmUgPT4gaGFuZGxlLm9uKFwid2VicnRjdXBcIiwgcmVzb2x2ZSkpO1xuXG4gICAgLy8gVW5yZWxpYWJsZSBkYXRhY2hhbm5lbDogc2VuZGluZyBhbmQgcmVjZWl2aW5nIGNvbXBvbmVudCB1cGRhdGVzLlxuICAgIC8vIFJlbGlhYmxlIGRhdGFjaGFubmVsOiBzZW5kaW5nIGFuZCByZWNpZXZpbmcgZW50aXR5IGluc3RhbnRpYXRpb25zLlxuICAgIHZhciByZWxpYWJsZUNoYW5uZWwgPSBjb25uLmNyZWF0ZURhdGFDaGFubmVsKFwicmVsaWFibGVcIiwgeyBvcmRlcmVkOiB0cnVlIH0pO1xuICAgIHZhciB1bnJlbGlhYmxlQ2hhbm5lbCA9IGNvbm4uY3JlYXRlRGF0YUNoYW5uZWwoXCJ1bnJlbGlhYmxlXCIsIHtcbiAgICAgIG9yZGVyZWQ6IGZhbHNlLFxuICAgICAgbWF4UmV0cmFuc21pdHM6IDBcbiAgICB9KTtcblxuICAgIHJlbGlhYmxlQ2hhbm5lbC5hZGRFdmVudExpc3RlbmVyKFwibWVzc2FnZVwiLCBlID0+IHRoaXMub25EYXRhQ2hhbm5lbE1lc3NhZ2UoZSwgXCJqYW51cy1yZWxpYWJsZVwiKSk7XG4gICAgdW5yZWxpYWJsZUNoYW5uZWwuYWRkRXZlbnRMaXN0ZW5lcihcIm1lc3NhZ2VcIiwgZSA9PiB0aGlzLm9uRGF0YUNoYW5uZWxNZXNzYWdlKGUsIFwiamFudXMtdW5yZWxpYWJsZVwiKSk7XG5cbiAgICBhd2FpdCB3ZWJydGN1cDtcbiAgICBhd2FpdCB1bnRpbERhdGFDaGFubmVsT3BlbihyZWxpYWJsZUNoYW5uZWwpO1xuICAgIGF3YWl0IHVudGlsRGF0YUNoYW5uZWxPcGVuKHVucmVsaWFibGVDaGFubmVsKTtcblxuICAgIC8vIGRvaW5nIHRoaXMgaGVyZSBpcyBzb3J0IG9mIGEgaGFjayBhcm91bmQgY2hyb21lIHJlbmVnb3RpYXRpb24gd2VpcmRuZXNzIC0tXG4gICAgLy8gaWYgd2UgZG8gaXQgcHJpb3IgdG8gd2VicnRjdXAsIGNocm9tZSBvbiBnZWFyIFZSIHdpbGwgc29tZXRpbWVzIHB1dCBhXG4gICAgLy8gcmVuZWdvdGlhdGlvbiBvZmZlciBpbiBmbGlnaHQgd2hpbGUgdGhlIGZpcnN0IG9mZmVyIHdhcyBzdGlsbCBiZWluZ1xuICAgIC8vIHByb2Nlc3NlZCBieSBqYW51cy4gd2Ugc2hvdWxkIGZpbmQgc29tZSBtb3JlIHByaW5jaXBsZWQgd2F5IHRvIGZpZ3VyZSBvdXRcbiAgICAvLyB3aGVuIGphbnVzIGlzIGRvbmUgaW4gdGhlIGZ1dHVyZS5cbiAgICBpZiAodGhpcy5sb2NhbE1lZGlhU3RyZWFtKSB7XG4gICAgICB0aGlzLmxvY2FsTWVkaWFTdHJlYW0uZ2V0VHJhY2tzKCkuZm9yRWFjaCh0cmFjayA9PiB7XG4gICAgICAgIGNvbm4uYWRkVHJhY2sodHJhY2ssIHRoaXMubG9jYWxNZWRpYVN0cmVhbSk7XG4gICAgICB9KTtcbiAgICB9XG5cbiAgICAvLyBIYW5kbGUgYWxsIG9mIHRoZSBqb2luIGFuZCBsZWF2ZSBldmVudHMuXG4gICAgaGFuZGxlLm9uKFwiZXZlbnRcIiwgZXYgPT4ge1xuICAgICAgdmFyIGRhdGEgPSBldi5wbHVnaW5kYXRhLmRhdGE7XG4gICAgICBpZiAoZGF0YS5ldmVudCA9PSBcImpvaW5cIiAmJiBkYXRhLnJvb21faWQgPT0gdGhpcy5yb29tKSB7XG4gICAgICAgIGlmICh0aGlzLmRlbGF5ZWRSZWNvbm5lY3RUaW1lb3V0KSB7XG4gICAgICAgICAgLy8gRG9uJ3QgY3JlYXRlIGEgbmV3IFJUQ1BlZXJDb25uZWN0aW9uLCBhbGwgUlRDUGVlckNvbm5lY3Rpb24gd2lsbCBiZSBjbG9zZWQgaW4gbGVzcyB0aGFuIDEwcy5cbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgdGhpcy5hZGRPY2N1cGFudChkYXRhLnVzZXJfaWQpO1xuICAgICAgfSBlbHNlIGlmIChkYXRhLmV2ZW50ID09IFwibGVhdmVcIiAmJiBkYXRhLnJvb21faWQgPT0gdGhpcy5yb29tKSB7XG4gICAgICAgIHRoaXMucmVtb3ZlT2NjdXBhbnQoZGF0YS51c2VyX2lkKTtcbiAgICAgIH0gZWxzZSBpZiAoZGF0YS5ldmVudCA9PSBcImJsb2NrZWRcIikge1xuICAgICAgICBkb2N1bWVudC5ib2R5LmRpc3BhdGNoRXZlbnQobmV3IEN1c3RvbUV2ZW50KFwiYmxvY2tlZFwiLCB7IGRldGFpbDogeyBjbGllbnRJZDogZGF0YS5ieSB9IH0pKTtcbiAgICAgIH0gZWxzZSBpZiAoZGF0YS5ldmVudCA9PSBcInVuYmxvY2tlZFwiKSB7XG4gICAgICAgIGRvY3VtZW50LmJvZHkuZGlzcGF0Y2hFdmVudChuZXcgQ3VzdG9tRXZlbnQoXCJ1bmJsb2NrZWRcIiwgeyBkZXRhaWw6IHsgY2xpZW50SWQ6IGRhdGEuYnkgfSB9KSk7XG4gICAgICB9IGVsc2UgaWYgKGRhdGEuZXZlbnQgPT09IFwiZGF0YVwiKSB7XG4gICAgICAgIHRoaXMub25EYXRhKEpTT04ucGFyc2UoZGF0YS5ib2R5KSwgXCJqYW51cy1ldmVudFwiKTtcbiAgICAgIH1cbiAgICB9KTtcblxuICAgIGRlYnVnKFwicHViIHdhaXRpbmcgZm9yIGpvaW5cIik7XG5cbiAgICAvLyBTZW5kIGpvaW4gbWVzc2FnZSB0byBqYW51cy4gTGlzdGVuIGZvciBqb2luL2xlYXZlIG1lc3NhZ2VzLiBBdXRvbWF0aWNhbGx5IHN1YnNjcmliZSB0byBhbGwgdXNlcnMnIFdlYlJUQyBkYXRhLlxuICAgIHZhciBtZXNzYWdlID0gYXdhaXQgdGhpcy5zZW5kSm9pbihoYW5kbGUsIHtcbiAgICAgIG5vdGlmaWNhdGlvbnM6IHRydWUsXG4gICAgICBkYXRhOiB0cnVlXG4gICAgfSk7XG5cbiAgICBpZiAoIW1lc3NhZ2UucGx1Z2luZGF0YS5kYXRhLnN1Y2Nlc3MpIHtcbiAgICAgIGNvbnN0IGVyciA9IG1lc3NhZ2UucGx1Z2luZGF0YS5kYXRhLmVycm9yO1xuICAgICAgY29uc29sZS5lcnJvcihlcnIpO1xuICAgICAgLy8gV2UgbWF5IGdldCBoZXJlIGJlY2F1c2Ugb2YgYW4gZXhwaXJlZCBKV1QuXG4gICAgICAvLyBDbG9zZSB0aGUgY29ubmVjdGlvbiBvdXJzZWxmIG90aGVyd2lzZSBqYW51cyB3aWxsIGNsb3NlIGl0IGFmdGVyXG4gICAgICAvLyBzZXNzaW9uX3RpbWVvdXQgYmVjYXVzZSB3ZSBkaWRuJ3Qgc2VuZCBhbnkga2VlcGFsaXZlIGFuZCB0aGlzIHdpbGxcbiAgICAgIC8vIHRyaWdnZXIgYSBkZWxheWVkIHJlY29ubmVjdCBiZWNhdXNlIG9mIHRoZSBpY2Vjb25uZWN0aW9uc3RhdGVjaGFuZ2VcbiAgICAgIC8vIGxpc3RlbmVyIGZvciBmYWlsdXJlIHN0YXRlLlxuICAgICAgLy8gRXZlbiBpZiB0aGUgYXBwIGNvZGUgY2FsbHMgZGlzY29ubmVjdCBpbiBjYXNlIG9mIGVycm9yLCBkaXNjb25uZWN0XG4gICAgICAvLyB3b24ndCBjbG9zZSB0aGUgcGVlciBjb25uZWN0aW9uIGJlY2F1c2UgdGhpcy5wdWJsaXNoZXIgaXMgbm90IHNldC5cbiAgICAgIGNvbm4uY2xvc2UoKTtcbiAgICAgIHRocm93IGVycjtcbiAgICB9XG5cbiAgICB2YXIgaW5pdGlhbE9jY3VwYW50cyA9IG1lc3NhZ2UucGx1Z2luZGF0YS5kYXRhLnJlc3BvbnNlLnVzZXJzW3RoaXMucm9vbV0gfHwgW107XG5cbiAgICBpZiAoaW5pdGlhbE9jY3VwYW50cy5pbmNsdWRlcyh0aGlzLmNsaWVudElkKSkge1xuICAgICAgY29uc29sZS53YXJuKFwiSmFudXMgc3RpbGwgaGFzIHByZXZpb3VzIHNlc3Npb24gZm9yIHRoaXMgY2xpZW50LiBSZWNvbm5lY3RpbmcgaW4gMTBzLlwiKTtcbiAgICAgIHRoaXMucGVyZm9ybURlbGF5ZWRSZWNvbm5lY3QoKTtcbiAgICB9XG5cbiAgICBkZWJ1ZyhcInB1Ymxpc2hlciByZWFkeVwiKTtcbiAgICByZXR1cm4ge1xuICAgICAgaGFuZGxlLFxuICAgICAgaW5pdGlhbE9jY3VwYW50cyxcbiAgICAgIHJlbGlhYmxlQ2hhbm5lbCxcbiAgICAgIHVucmVsaWFibGVDaGFubmVsLFxuICAgICAgY29ublxuICAgIH07XG4gIH1cblxuICBjb25maWd1cmVQdWJsaXNoZXJTZHAoanNlcCkge1xuICAgIGpzZXAuc2RwID0ganNlcC5zZHAucmVwbGFjZSgvYT1mbXRwOigxMDl8MTExKS4qXFxyXFxuL2csIChsaW5lLCBwdCkgPT4ge1xuICAgICAgY29uc3QgcGFyYW1ldGVycyA9IE9iamVjdC5hc3NpZ24oc2RwVXRpbHMucGFyc2VGbXRwKGxpbmUpLCBPUFVTX1BBUkFNRVRFUlMpO1xuICAgICAgcmV0dXJuIHNkcFV0aWxzLndyaXRlRm10cCh7IHBheWxvYWRUeXBlOiBwdCwgcGFyYW1ldGVyczogcGFyYW1ldGVycyB9KTtcbiAgICB9KTtcbiAgICByZXR1cm4ganNlcDtcbiAgfVxuXG4gIGNvbmZpZ3VyZVN1YnNjcmliZXJTZHAoanNlcCkge1xuICAgIC8vIHRvZG86IGNvbnNpZGVyIGNsZWFuaW5nIHVwIHRoZXNlIGhhY2tzIHRvIHVzZSBzZHB1dGlsc1xuICAgIGlmICghaXNIMjY0VmlkZW9TdXBwb3J0ZWQpIHtcbiAgICAgIGlmIChuYXZpZ2F0b3IudXNlckFnZW50LmluZGV4T2YoXCJIZWFkbGVzc0Nocm9tZVwiKSAhPT0gLTEpIHtcbiAgICAgICAgLy8gSGVhZGxlc3NDaHJvbWUgKGUuZy4gcHVwcGV0ZWVyKSBkb2Vzbid0IHN1cHBvcnQgd2VicnRjIHZpZGVvIHN0cmVhbXMsIHNvIHdlIHJlbW92ZSB0aG9zZSBsaW5lcyBmcm9tIHRoZSBTRFAuXG4gICAgICAgIGpzZXAuc2RwID0ganNlcC5zZHAucmVwbGFjZSgvbT12aWRlb1teXSptPS8sIFwibT1cIik7XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gVE9ETzogSGFjayB0byBnZXQgdmlkZW8gd29ya2luZyBvbiBDaHJvbWUgZm9yIEFuZHJvaWQuIGh0dHBzOi8vZ3JvdXBzLmdvb2dsZS5jb20vZm9ydW0vIyF0b3BpYy9tb3ppbGxhLmRldi5tZWRpYS9ZZTI5dnVNVHBvOFxuICAgIGlmIChuYXZpZ2F0b3IudXNlckFnZW50LmluZGV4T2YoXCJBbmRyb2lkXCIpID09PSAtMSkge1xuICAgICAganNlcC5zZHAgPSBqc2VwLnNkcC5yZXBsYWNlKFxuICAgICAgICBcImE9cnRjcC1mYjoxMDcgZ29vZy1yZW1iXFxyXFxuXCIsXG4gICAgICAgIFwiYT1ydGNwLWZiOjEwNyBnb29nLXJlbWJcXHJcXG5hPXJ0Y3AtZmI6MTA3IHRyYW5zcG9ydC1jY1xcclxcbmE9Zm10cDoxMDcgbGV2ZWwtYXN5bW1ldHJ5LWFsbG93ZWQ9MTtwYWNrZXRpemF0aW9uLW1vZGU9MTtwcm9maWxlLWxldmVsLWlkPTQyZTAxZlxcclxcblwiXG4gICAgICApO1xuICAgIH0gZWxzZSB7XG4gICAgICBqc2VwLnNkcCA9IGpzZXAuc2RwLnJlcGxhY2UoXG4gICAgICAgIFwiYT1ydGNwLWZiOjEwNyBnb29nLXJlbWJcXHJcXG5cIixcbiAgICAgICAgXCJhPXJ0Y3AtZmI6MTA3IGdvb2ctcmVtYlxcclxcbmE9cnRjcC1mYjoxMDcgdHJhbnNwb3J0LWNjXFxyXFxuYT1mbXRwOjEwNyBsZXZlbC1hc3ltbWV0cnktYWxsb3dlZD0xO3BhY2tldGl6YXRpb24tbW9kZT0xO3Byb2ZpbGUtbGV2ZWwtaWQ9NDIwMDFmXFxyXFxuXCJcbiAgICAgICk7XG4gICAgfVxuICAgIHJldHVybiBqc2VwO1xuICB9XG5cbiAgYXN5bmMgZml4U2FmYXJpSWNlVUZyYWcoanNlcCkge1xuICAgIC8vIFNhZmFyaSBwcm9kdWNlcyBhIFxcbiBpbnN0ZWFkIG9mIGFuIFxcclxcbiBmb3IgdGhlIGljZS11ZnJhZy4gU2VlIGh0dHBzOi8vZ2l0aHViLmNvbS9tZWV0ZWNoby9qYW51cy1nYXRld2F5L2lzc3Vlcy8xODE4XG4gICAganNlcC5zZHAgPSBqc2VwLnNkcC5yZXBsYWNlKC9bXlxccl1cXG5hPWljZS11ZnJhZy9nLCBcIlxcclxcbmE9aWNlLXVmcmFnXCIpO1xuICAgIHJldHVybiBqc2VwXG4gIH1cblxuICBhc3luYyBjcmVhdGVTdWJzY3JpYmVyKG9jY3VwYW50SWQsIG1heFJldHJpZXMgPSA1KSB7XG4gICAgaWYgKHRoaXMubGVmdE9jY3VwYW50cy5oYXMob2NjdXBhbnRJZCkpIHtcbiAgICAgIGNvbnNvbGUud2FybihvY2N1cGFudElkICsgXCI6IGNhbmNlbGxlZCBvY2N1cGFudCBjb25uZWN0aW9uLCBvY2N1cGFudCBsZWZ0IGJlZm9yZSBzdWJzY3JpcHRpb24gbmVnb3RhdGlvbi5cIik7XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG5cbiAgICB2YXIgaGFuZGxlID0gbmV3IG1qLkphbnVzUGx1Z2luSGFuZGxlKHRoaXMuc2Vzc2lvbik7XG4gICAgdmFyIGNvbm4gPSBuZXcgUlRDUGVlckNvbm5lY3Rpb24odGhpcy5wZWVyQ29ubmVjdGlvbkNvbmZpZyB8fCBERUZBVUxUX1BFRVJfQ09OTkVDVElPTl9DT05GSUcpO1xuXG4gICAgZGVidWcob2NjdXBhbnRJZCArIFwiOiBzdWIgd2FpdGluZyBmb3Igc2Z1XCIpO1xuICAgIGF3YWl0IGhhbmRsZS5hdHRhY2goXCJqYW51cy5wbHVnaW4uc2Z1XCIsIHRoaXMubG9vcHMgPyBwYXJzZUludChvY2N1cGFudElkKSAlIHRoaXMubG9vcHMgOiB1bmRlZmluZWQpO1xuXG4gICAgdGhpcy5hc3NvY2lhdGUoY29ubiwgaGFuZGxlKTtcblxuICAgIGRlYnVnKG9jY3VwYW50SWQgKyBcIjogc3ViIHdhaXRpbmcgZm9yIGpvaW5cIik7XG5cbiAgICBpZiAodGhpcy5sZWZ0T2NjdXBhbnRzLmhhcyhvY2N1cGFudElkKSkge1xuICAgICAgY29ubi5jbG9zZSgpO1xuICAgICAgY29uc29sZS53YXJuKG9jY3VwYW50SWQgKyBcIjogY2FuY2VsbGVkIG9jY3VwYW50IGNvbm5lY3Rpb24sIG9jY3VwYW50IGxlZnQgYWZ0ZXIgYXR0YWNoXCIpO1xuICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuXG4gICAgLy8gU2VuZCBqb2luIG1lc3NhZ2UgdG8gamFudXMuIERvbid0IGxpc3RlbiBmb3Igam9pbi9sZWF2ZSBtZXNzYWdlcy4gU3Vic2NyaWJlIHRvIHRoZSBvY2N1cGFudCdzIG1lZGlhLlxuICAgIC8vIEphbnVzIHNob3VsZCBzZW5kIHVzIGFuIG9mZmVyIGZvciB0aGlzIG9jY3VwYW50J3MgbWVkaWEgaW4gcmVzcG9uc2UgdG8gdGhpcy5cbiAgICBhd2FpdCB0aGlzLnNlbmRKb2luKGhhbmRsZSwgeyBtZWRpYTogb2NjdXBhbnRJZCB9KTtcblxuICAgIGlmICh0aGlzLmxlZnRPY2N1cGFudHMuaGFzKG9jY3VwYW50SWQpKSB7XG4gICAgICBjb25uLmNsb3NlKCk7XG4gICAgICBjb25zb2xlLndhcm4ob2NjdXBhbnRJZCArIFwiOiBjYW5jZWxsZWQgb2NjdXBhbnQgY29ubmVjdGlvbiwgb2NjdXBhbnQgbGVmdCBhZnRlciBqb2luXCIpO1xuICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuXG4gICAgZGVidWcob2NjdXBhbnRJZCArIFwiOiBzdWIgd2FpdGluZyBmb3Igd2VicnRjdXBcIik7XG5cbiAgICBhd2FpdCBuZXcgUHJvbWlzZShyZXNvbHZlID0+IHtcbiAgICAgIGNvbnN0IGludGVydmFsID0gc2V0SW50ZXJ2YWwoKCkgPT4ge1xuICAgICAgICBpZiAodGhpcy5sZWZ0T2NjdXBhbnRzLmhhcyhvY2N1cGFudElkKSkge1xuICAgICAgICAgIGNsZWFySW50ZXJ2YWwoaW50ZXJ2YWwpO1xuICAgICAgICAgIHJlc29sdmUoKTtcbiAgICAgICAgfVxuICAgICAgfSwgMTAwMCk7XG5cbiAgICAgIGhhbmRsZS5vbihcIndlYnJ0Y3VwXCIsICgpID0+IHtcbiAgICAgICAgY2xlYXJJbnRlcnZhbChpbnRlcnZhbCk7XG4gICAgICAgIHJlc29sdmUoKTtcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgaWYgKHRoaXMubGVmdE9jY3VwYW50cy5oYXMob2NjdXBhbnRJZCkpIHtcbiAgICAgIGNvbm4uY2xvc2UoKTtcbiAgICAgIGNvbnNvbGUud2FybihvY2N1cGFudElkICsgXCI6IGNhbmNlbCBvY2N1cGFudCBjb25uZWN0aW9uLCBvY2N1cGFudCBsZWZ0IGR1cmluZyBvciBhZnRlciB3ZWJydGN1cFwiKTtcbiAgICAgIHJldHVybiBudWxsO1xuICAgIH1cblxuICAgIGlmIChpc1NhZmFyaSAmJiAhdGhpcy5faU9TSGFja0RlbGF5ZWRJbml0aWFsUGVlcikge1xuICAgICAgLy8gSEFDSzogdGhlIGZpcnN0IHBlZXIgb24gU2FmYXJpIGR1cmluZyBwYWdlIGxvYWQgY2FuIGZhaWwgdG8gd29yayBpZiB3ZSBkb24ndFxuICAgICAgLy8gd2FpdCBzb21lIHRpbWUgYmVmb3JlIGNvbnRpbnVpbmcgaGVyZS4gU2VlOiBodHRwczovL2dpdGh1Yi5jb20vbW96aWxsYS9odWJzL3B1bGwvMTY5MlxuICAgICAgYXdhaXQgKG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiBzZXRUaW1lb3V0KHJlc29sdmUsIDMwMDApKSk7XG4gICAgICB0aGlzLl9pT1NIYWNrRGVsYXllZEluaXRpYWxQZWVyID0gdHJ1ZTtcbiAgICB9XG5cbiAgICB2YXIgbWVkaWFTdHJlYW0gPSBuZXcgTWVkaWFTdHJlYW0oKTtcbiAgICB2YXIgcmVjZWl2ZXJzID0gY29ubi5nZXRSZWNlaXZlcnMoKTtcbiAgICByZWNlaXZlcnMuZm9yRWFjaChyZWNlaXZlciA9PiB7XG4gICAgICBpZiAocmVjZWl2ZXIudHJhY2spIHtcbiAgICAgICAgbWVkaWFTdHJlYW0uYWRkVHJhY2socmVjZWl2ZXIudHJhY2spO1xuICAgICAgfVxuICAgIH0pO1xuICAgIGlmIChtZWRpYVN0cmVhbS5nZXRUcmFja3MoKS5sZW5ndGggPT09IDApIHtcbiAgICAgIG1lZGlhU3RyZWFtID0gbnVsbDtcbiAgICB9XG5cbiAgICBkZWJ1ZyhvY2N1cGFudElkICsgXCI6IHN1YnNjcmliZXIgcmVhZHlcIik7XG4gICAgcmV0dXJuIHtcbiAgICAgIGhhbmRsZSxcbiAgICAgIG1lZGlhU3RyZWFtLFxuICAgICAgY29ublxuICAgIH07XG4gIH1cblxuICBzZW5kSm9pbihoYW5kbGUsIHN1YnNjcmliZSkge1xuICAgIHJldHVybiBoYW5kbGUuc2VuZE1lc3NhZ2Uoe1xuICAgICAga2luZDogXCJqb2luXCIsXG4gICAgICByb29tX2lkOiB0aGlzLnJvb20sXG4gICAgICB1c2VyX2lkOiB0aGlzLmNsaWVudElkLFxuICAgICAgc3Vic2NyaWJlLFxuICAgICAgdG9rZW46IHRoaXMuam9pblRva2VuXG4gICAgfSk7XG4gIH1cblxuICB0b2dnbGVGcmVlemUoKSB7XG4gICAgaWYgKHRoaXMuZnJvemVuKSB7XG4gICAgICB0aGlzLnVuZnJlZXplKCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMuZnJlZXplKCk7XG4gICAgfVxuICB9XG5cbiAgZnJlZXplKCkge1xuICAgIHRoaXMuZnJvemVuID0gdHJ1ZTtcbiAgfVxuXG4gIHVuZnJlZXplKCkge1xuICAgIHRoaXMuZnJvemVuID0gZmFsc2U7XG4gICAgdGhpcy5mbHVzaFBlbmRpbmdVcGRhdGVzKCk7XG4gIH1cblxuICBkYXRhRm9yVXBkYXRlTXVsdGlNZXNzYWdlKG5ldHdvcmtJZCwgbWVzc2FnZSkge1xuICAgIC8vIFwiZFwiIGlzIGFuIGFycmF5IG9mIGVudGl0eSBkYXRhcywgd2hlcmUgZWFjaCBpdGVtIGluIHRoZSBhcnJheSByZXByZXNlbnRzIGEgdW5pcXVlIGVudGl0eSBhbmQgY29udGFpbnNcbiAgICAvLyBtZXRhZGF0YSBmb3IgdGhlIGVudGl0eSwgYW5kIGFuIGFycmF5IG9mIGNvbXBvbmVudHMgdGhhdCBoYXZlIGJlZW4gdXBkYXRlZCBvbiB0aGUgZW50aXR5LlxuICAgIC8vIFRoaXMgbWV0aG9kIGZpbmRzIHRoZSBkYXRhIGNvcnJlc3BvbmRpbmcgdG8gdGhlIGdpdmVuIG5ldHdvcmtJZC5cbiAgICBmb3IgKGxldCBpID0gMCwgbCA9IG1lc3NhZ2UuZGF0YS5kLmxlbmd0aDsgaSA8IGw7IGkrKykge1xuICAgICAgY29uc3QgZGF0YSA9IG1lc3NhZ2UuZGF0YS5kW2ldO1xuXG4gICAgICBpZiAoZGF0YS5uZXR3b3JrSWQgPT09IG5ldHdvcmtJZCkge1xuICAgICAgICByZXR1cm4gZGF0YTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuXG4gIGdldFBlbmRpbmdEYXRhKG5ldHdvcmtJZCwgbWVzc2FnZSkge1xuICAgIGlmICghbWVzc2FnZSkgcmV0dXJuIG51bGw7XG5cbiAgICBsZXQgZGF0YSA9IG1lc3NhZ2UuZGF0YVR5cGUgPT09IFwidW1cIiA/IHRoaXMuZGF0YUZvclVwZGF0ZU11bHRpTWVzc2FnZShuZXR3b3JrSWQsIG1lc3NhZ2UpIDogbWVzc2FnZS5kYXRhO1xuXG4gICAgLy8gSWdub3JlIG1lc3NhZ2VzIHJlbGF0aW5nIHRvIHVzZXJzIHdobyBoYXZlIGRpc2Nvbm5lY3RlZCBzaW5jZSBmcmVlemluZywgdGhlaXIgZW50aXRpZXNcbiAgICAvLyB3aWxsIGhhdmUgYWxlYWR5IGJlZW4gcmVtb3ZlZCBieSBOQUYuXG4gICAgLy8gTm90ZSB0aGF0IGRlbGV0ZSBtZXNzYWdlcyBoYXZlIG5vIFwib3duZXJcIiBzbyB3ZSBoYXZlIHRvIGNoZWNrIGZvciB0aGF0IGFzIHdlbGwuXG4gICAgaWYgKGRhdGEub3duZXIgJiYgIXRoaXMub2NjdXBhbnRzW2RhdGEub3duZXJdKSByZXR1cm4gbnVsbDtcblxuICAgIC8vIElnbm9yZSBtZXNzYWdlcyBmcm9tIHVzZXJzIHRoYXQgd2UgbWF5IGhhdmUgYmxvY2tlZCB3aGlsZSBmcm96ZW4uXG4gICAgaWYgKGRhdGEub3duZXIgJiYgdGhpcy5ibG9ja2VkQ2xpZW50cy5oYXMoZGF0YS5vd25lcikpIHJldHVybiBudWxsO1xuXG4gICAgcmV0dXJuIGRhdGFcbiAgfVxuXG4gIC8vIFVzZWQgZXh0ZXJuYWxseVxuICBnZXRQZW5kaW5nRGF0YUZvck5ldHdvcmtJZChuZXR3b3JrSWQpIHtcbiAgICByZXR1cm4gdGhpcy5nZXRQZW5kaW5nRGF0YShuZXR3b3JrSWQsIHRoaXMuZnJvemVuVXBkYXRlcy5nZXQobmV0d29ya0lkKSk7XG4gIH1cblxuICBmbHVzaFBlbmRpbmdVcGRhdGVzKCkge1xuICAgIGZvciAoY29uc3QgW25ldHdvcmtJZCwgbWVzc2FnZV0gb2YgdGhpcy5mcm96ZW5VcGRhdGVzKSB7XG4gICAgICBsZXQgZGF0YSA9IHRoaXMuZ2V0UGVuZGluZ0RhdGEobmV0d29ya0lkLCBtZXNzYWdlKTtcbiAgICAgIGlmICghZGF0YSkgY29udGludWU7XG5cbiAgICAgIC8vIE92ZXJyaWRlIHRoZSBkYXRhIHR5cGUgb24gXCJ1bVwiIG1lc3NhZ2VzIHR5cGVzLCBzaW5jZSB3ZSBleHRyYWN0IGVudGl0eSB1cGRhdGVzIGZyb20gXCJ1bVwiIG1lc3NhZ2VzIGludG9cbiAgICAgIC8vIGluZGl2aWR1YWwgZnJvemVuVXBkYXRlcyBpbiBzdG9yZVNpbmdsZU1lc3NhZ2UuXG4gICAgICBjb25zdCBkYXRhVHlwZSA9IG1lc3NhZ2UuZGF0YVR5cGUgPT09IFwidW1cIiA/IFwidVwiIDogbWVzc2FnZS5kYXRhVHlwZTtcblxuICAgICAgdGhpcy5vbk9jY3VwYW50TWVzc2FnZShudWxsLCBkYXRhVHlwZSwgZGF0YSwgbWVzc2FnZS5zb3VyY2UpO1xuICAgIH1cbiAgICB0aGlzLmZyb3plblVwZGF0ZXMuY2xlYXIoKTtcbiAgfVxuXG4gIHN0b3JlTWVzc2FnZShtZXNzYWdlKSB7XG4gICAgaWYgKG1lc3NhZ2UuZGF0YVR5cGUgPT09IFwidW1cIikgeyAvLyBVcGRhdGVNdWx0aVxuICAgICAgZm9yIChsZXQgaSA9IDAsIGwgPSBtZXNzYWdlLmRhdGEuZC5sZW5ndGg7IGkgPCBsOyBpKyspIHtcbiAgICAgICAgdGhpcy5zdG9yZVNpbmdsZU1lc3NhZ2UobWVzc2FnZSwgaSk7XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMuc3RvcmVTaW5nbGVNZXNzYWdlKG1lc3NhZ2UpO1xuICAgIH1cbiAgfVxuXG4gIHN0b3JlU2luZ2xlTWVzc2FnZShtZXNzYWdlLCBpbmRleCkge1xuICAgIGNvbnN0IGRhdGEgPSBpbmRleCAhPT0gdW5kZWZpbmVkID8gbWVzc2FnZS5kYXRhLmRbaW5kZXhdIDogbWVzc2FnZS5kYXRhO1xuICAgIGNvbnN0IGRhdGFUeXBlID0gbWVzc2FnZS5kYXRhVHlwZTtcbiAgICBjb25zdCBzb3VyY2UgPSBtZXNzYWdlLnNvdXJjZTtcblxuICAgIGNvbnN0IG5ldHdvcmtJZCA9IGRhdGEubmV0d29ya0lkO1xuXG4gICAgaWYgKCF0aGlzLmZyb3plblVwZGF0ZXMuaGFzKG5ldHdvcmtJZCkpIHtcbiAgICAgIHRoaXMuZnJvemVuVXBkYXRlcy5zZXQobmV0d29ya0lkLCBtZXNzYWdlKTtcbiAgICB9IGVsc2Uge1xuICAgICAgY29uc3Qgc3RvcmVkTWVzc2FnZSA9IHRoaXMuZnJvemVuVXBkYXRlcy5nZXQobmV0d29ya0lkKTtcbiAgICAgIGNvbnN0IHN0b3JlZERhdGEgPSBzdG9yZWRNZXNzYWdlLmRhdGFUeXBlID09PSBcInVtXCIgPyB0aGlzLmRhdGFGb3JVcGRhdGVNdWx0aU1lc3NhZ2UobmV0d29ya0lkLCBzdG9yZWRNZXNzYWdlKSA6IHN0b3JlZE1lc3NhZ2UuZGF0YTtcblxuICAgICAgLy8gQXZvaWQgdXBkYXRpbmcgY29tcG9uZW50cyBpZiB0aGUgZW50aXR5IGRhdGEgcmVjZWl2ZWQgZGlkIG5vdCBjb21lIGZyb20gdGhlIGN1cnJlbnQgb3duZXIuXG4gICAgICBjb25zdCBpc091dGRhdGVkTWVzc2FnZSA9IGRhdGEubGFzdE93bmVyVGltZSA8IHN0b3JlZERhdGEubGFzdE93bmVyVGltZTtcbiAgICAgIGNvbnN0IGlzQ29udGVtcG9yYW5lb3VzTWVzc2FnZSA9IGRhdGEubGFzdE93bmVyVGltZSA9PT0gc3RvcmVkRGF0YS5sYXN0T3duZXJUaW1lO1xuICAgICAgaWYgKGlzT3V0ZGF0ZWRNZXNzYWdlIHx8IChpc0NvbnRlbXBvcmFuZW91c01lc3NhZ2UgJiYgc3RvcmVkRGF0YS5vd25lciA+IGRhdGEub3duZXIpKSB7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgaWYgKGRhdGFUeXBlID09PSBcInJcIikge1xuICAgICAgICBjb25zdCBjcmVhdGVkV2hpbGVGcm96ZW4gPSBzdG9yZWREYXRhICYmIHN0b3JlZERhdGEuaXNGaXJzdFN5bmM7XG4gICAgICAgIGlmIChjcmVhdGVkV2hpbGVGcm96ZW4pIHtcbiAgICAgICAgICAvLyBJZiB0aGUgZW50aXR5IHdhcyBjcmVhdGVkIGFuZCBkZWxldGVkIHdoaWxlIGZyb3plbiwgZG9uJ3QgYm90aGVyIGNvbnZleWluZyBhbnl0aGluZyB0byB0aGUgY29uc3VtZXIuXG4gICAgICAgICAgdGhpcy5mcm96ZW5VcGRhdGVzLmRlbGV0ZShuZXR3b3JrSWQpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIC8vIERlbGV0ZSBtZXNzYWdlcyBvdmVycmlkZSBhbnkgb3RoZXIgbWVzc2FnZXMgZm9yIHRoaXMgZW50aXR5XG4gICAgICAgICAgdGhpcy5mcm96ZW5VcGRhdGVzLnNldChuZXR3b3JrSWQsIG1lc3NhZ2UpO1xuICAgICAgICB9XG4gICAgICB9IGVsc2Uge1xuICAgICAgICAvLyBtZXJnZSBpbiBjb21wb25lbnQgdXBkYXRlc1xuICAgICAgICBpZiAoc3RvcmVkRGF0YS5jb21wb25lbnRzICYmIGRhdGEuY29tcG9uZW50cykge1xuICAgICAgICAgIE9iamVjdC5hc3NpZ24oc3RvcmVkRGF0YS5jb21wb25lbnRzLCBkYXRhLmNvbXBvbmVudHMpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgb25EYXRhQ2hhbm5lbE1lc3NhZ2UoZSwgc291cmNlKSB7XG4gICAgdGhpcy5vbkRhdGEoSlNPTi5wYXJzZShlLmRhdGEpLCBzb3VyY2UpO1xuICB9XG5cbiAgb25EYXRhKG1lc3NhZ2UsIHNvdXJjZSkge1xuICAgIGlmIChkZWJ1Zy5lbmFibGVkKSB7XG4gICAgICBkZWJ1ZyhgREMgaW46ICR7bWVzc2FnZX1gKTtcbiAgICB9XG5cbiAgICBpZiAoIW1lc3NhZ2UuZGF0YVR5cGUpIHJldHVybjtcblxuICAgIG1lc3NhZ2Uuc291cmNlID0gc291cmNlO1xuXG4gICAgaWYgKHRoaXMuZnJvemVuKSB7XG4gICAgICB0aGlzLnN0b3JlTWVzc2FnZShtZXNzYWdlKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5vbk9jY3VwYW50TWVzc2FnZShudWxsLCBtZXNzYWdlLmRhdGFUeXBlLCBtZXNzYWdlLmRhdGEsIG1lc3NhZ2Uuc291cmNlKTtcbiAgICB9XG4gIH1cblxuICBzaG91bGRTdGFydENvbm5lY3Rpb25UbyhjbGllbnQpIHtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuXG4gIHN0YXJ0U3RyZWFtQ29ubmVjdGlvbihjbGllbnQpIHt9XG5cbiAgY2xvc2VTdHJlYW1Db25uZWN0aW9uKGNsaWVudCkge31cblxuICBnZXRDb25uZWN0U3RhdHVzKGNsaWVudElkKSB7XG4gICAgcmV0dXJuIHRoaXMub2NjdXBhbnRzW2NsaWVudElkXSA/IE5BRi5hZGFwdGVycy5JU19DT05ORUNURUQgOiBOQUYuYWRhcHRlcnMuTk9UX0NPTk5FQ1RFRDtcbiAgfVxuXG4gIGFzeW5jIHVwZGF0ZVRpbWVPZmZzZXQoKSB7XG4gICAgaWYgKHRoaXMuaXNEaXNjb25uZWN0ZWQoKSkgcmV0dXJuO1xuXG4gICAgY29uc3QgY2xpZW50U2VudFRpbWUgPSBEYXRlLm5vdygpO1xuXG4gICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goZG9jdW1lbnQubG9jYXRpb24uaHJlZiwge1xuICAgICAgbWV0aG9kOiBcIkhFQURcIixcbiAgICAgIGNhY2hlOiBcIm5vLWNhY2hlXCJcbiAgICB9KTtcblxuICAgIGNvbnN0IHByZWNpc2lvbiA9IDEwMDA7XG4gICAgY29uc3Qgc2VydmVyUmVjZWl2ZWRUaW1lID0gbmV3IERhdGUocmVzLmhlYWRlcnMuZ2V0KFwiRGF0ZVwiKSkuZ2V0VGltZSgpICsgcHJlY2lzaW9uIC8gMjtcbiAgICBjb25zdCBjbGllbnRSZWNlaXZlZFRpbWUgPSBEYXRlLm5vdygpO1xuICAgIGNvbnN0IHNlcnZlclRpbWUgPSBzZXJ2ZXJSZWNlaXZlZFRpbWUgKyAoY2xpZW50UmVjZWl2ZWRUaW1lIC0gY2xpZW50U2VudFRpbWUpIC8gMjtcbiAgICBjb25zdCB0aW1lT2Zmc2V0ID0gc2VydmVyVGltZSAtIGNsaWVudFJlY2VpdmVkVGltZTtcblxuICAgIHRoaXMuc2VydmVyVGltZVJlcXVlc3RzKys7XG5cbiAgICBpZiAodGhpcy5zZXJ2ZXJUaW1lUmVxdWVzdHMgPD0gMTApIHtcbiAgICAgIHRoaXMudGltZU9mZnNldHMucHVzaCh0aW1lT2Zmc2V0KTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy50aW1lT2Zmc2V0c1t0aGlzLnNlcnZlclRpbWVSZXF1ZXN0cyAlIDEwXSA9IHRpbWVPZmZzZXQ7XG4gICAgfVxuXG4gICAgdGhpcy5hdmdUaW1lT2Zmc2V0ID0gdGhpcy50aW1lT2Zmc2V0cy5yZWR1Y2UoKGFjYywgb2Zmc2V0KSA9PiAoYWNjICs9IG9mZnNldCksIDApIC8gdGhpcy50aW1lT2Zmc2V0cy5sZW5ndGg7XG5cbiAgICBpZiAodGhpcy5zZXJ2ZXJUaW1lUmVxdWVzdHMgPiAxMCkge1xuICAgICAgZGVidWcoYG5ldyBzZXJ2ZXIgdGltZSBvZmZzZXQ6ICR7dGhpcy5hdmdUaW1lT2Zmc2V0fW1zYCk7XG4gICAgICBzZXRUaW1lb3V0KCgpID0+IHRoaXMudXBkYXRlVGltZU9mZnNldCgpLCA1ICogNjAgKiAxMDAwKTsgLy8gU3luYyBjbG9jayBldmVyeSA1IG1pbnV0ZXMuXG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMudXBkYXRlVGltZU9mZnNldCgpO1xuICAgIH1cbiAgfVxuXG4gIGdldFNlcnZlclRpbWUoKSB7XG4gICAgcmV0dXJuIERhdGUubm93KCkgKyB0aGlzLmF2Z1RpbWVPZmZzZXQ7XG4gIH1cblxuICBnZXRNZWRpYVN0cmVhbShjbGllbnRJZCwgdHlwZSA9IFwiYXVkaW9cIikge1xuICAgIGlmICh0aGlzLm1lZGlhU3RyZWFtc1tjbGllbnRJZF0pIHtcbiAgICAgIGRlYnVnKGBBbHJlYWR5IGhhZCAke3R5cGV9IGZvciAke2NsaWVudElkfWApO1xuICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh0aGlzLm1lZGlhU3RyZWFtc1tjbGllbnRJZF1bdHlwZV0pO1xuICAgIH0gZWxzZSB7XG4gICAgICBkZWJ1ZyhgV2FpdGluZyBvbiAke3R5cGV9IGZvciAke2NsaWVudElkfWApO1xuICAgICAgaWYgKCF0aGlzLnBlbmRpbmdNZWRpYVJlcXVlc3RzLmhhcyhjbGllbnRJZCkpIHtcbiAgICAgICAgdGhpcy5wZW5kaW5nTWVkaWFSZXF1ZXN0cy5zZXQoY2xpZW50SWQsIHt9KTtcblxuICAgICAgICBjb25zdCBhdWRpb1Byb21pc2UgPSBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICAgICAgdGhpcy5wZW5kaW5nTWVkaWFSZXF1ZXN0cy5nZXQoY2xpZW50SWQpLmF1ZGlvID0geyByZXNvbHZlLCByZWplY3QgfTtcbiAgICAgICAgfSk7XG4gICAgICAgIGNvbnN0IHZpZGVvUHJvbWlzZSA9IG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgICAgICB0aGlzLnBlbmRpbmdNZWRpYVJlcXVlc3RzLmdldChjbGllbnRJZCkudmlkZW8gPSB7IHJlc29sdmUsIHJlamVjdCB9O1xuICAgICAgICB9KTtcblxuICAgICAgICB0aGlzLnBlbmRpbmdNZWRpYVJlcXVlc3RzLmdldChjbGllbnRJZCkuYXVkaW8ucHJvbWlzZSA9IGF1ZGlvUHJvbWlzZTtcbiAgICAgICAgdGhpcy5wZW5kaW5nTWVkaWFSZXF1ZXN0cy5nZXQoY2xpZW50SWQpLnZpZGVvLnByb21pc2UgPSB2aWRlb1Byb21pc2U7XG5cbiAgICAgICAgYXVkaW9Qcm9taXNlLmNhdGNoKGUgPT4gY29uc29sZS53YXJuKGAke2NsaWVudElkfSBnZXRNZWRpYVN0cmVhbSBBdWRpbyBFcnJvcmAsIGUpKTtcbiAgICAgICAgdmlkZW9Qcm9taXNlLmNhdGNoKGUgPT4gY29uc29sZS53YXJuKGAke2NsaWVudElkfSBnZXRNZWRpYVN0cmVhbSBWaWRlbyBFcnJvcmAsIGUpKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiB0aGlzLnBlbmRpbmdNZWRpYVJlcXVlc3RzLmdldChjbGllbnRJZClbdHlwZV0ucHJvbWlzZTtcbiAgICB9XG4gIH1cblxuICBzZXRNZWRpYVN0cmVhbShjbGllbnRJZCwgc3RyZWFtKSB7XG4gICAgLy8gU2FmYXJpIGRvZXNuJ3QgbGlrZSBpdCB3aGVuIHlvdSB1c2Ugc2luZ2xlIGEgbWl4ZWQgbWVkaWEgc3RyZWFtIHdoZXJlIG9uZSBvZiB0aGUgdHJhY2tzIGlzIGluYWN0aXZlLCBzbyB3ZVxuICAgIC8vIHNwbGl0IHRoZSB0cmFja3MgaW50byB0d28gc3RyZWFtcy5cbiAgICBjb25zdCBhdWRpb1N0cmVhbSA9IG5ldyBNZWRpYVN0cmVhbSgpO1xuICAgIHRyeSB7XG4gICAgc3RyZWFtLmdldEF1ZGlvVHJhY2tzKCkuZm9yRWFjaCh0cmFjayA9PiBhdWRpb1N0cmVhbS5hZGRUcmFjayh0cmFjaykpO1xuXG4gICAgfSBjYXRjaChlKSB7XG4gICAgICBjb25zb2xlLndhcm4oYCR7Y2xpZW50SWR9IHNldE1lZGlhU3RyZWFtIEF1ZGlvIEVycm9yYCwgZSk7XG4gICAgfVxuICAgIGNvbnN0IHZpZGVvU3RyZWFtID0gbmV3IE1lZGlhU3RyZWFtKCk7XG4gICAgdHJ5IHtcbiAgICBzdHJlYW0uZ2V0VmlkZW9UcmFja3MoKS5mb3JFYWNoKHRyYWNrID0+IHZpZGVvU3RyZWFtLmFkZFRyYWNrKHRyYWNrKSk7XG5cbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBjb25zb2xlLndhcm4oYCR7Y2xpZW50SWR9IHNldE1lZGlhU3RyZWFtIFZpZGVvIEVycm9yYCwgZSk7XG4gICAgfVxuXG4gICAgdGhpcy5tZWRpYVN0cmVhbXNbY2xpZW50SWRdID0geyBhdWRpbzogYXVkaW9TdHJlYW0sIHZpZGVvOiB2aWRlb1N0cmVhbSB9O1xuXG4gICAgLy8gUmVzb2x2ZSB0aGUgcHJvbWlzZSBmb3IgdGhlIHVzZXIncyBtZWRpYSBzdHJlYW0gaWYgaXQgZXhpc3RzLlxuICAgIGlmICh0aGlzLnBlbmRpbmdNZWRpYVJlcXVlc3RzLmhhcyhjbGllbnRJZCkpIHtcbiAgICAgIHRoaXMucGVuZGluZ01lZGlhUmVxdWVzdHMuZ2V0KGNsaWVudElkKS5hdWRpby5yZXNvbHZlKGF1ZGlvU3RyZWFtKTtcbiAgICAgIHRoaXMucGVuZGluZ01lZGlhUmVxdWVzdHMuZ2V0KGNsaWVudElkKS52aWRlby5yZXNvbHZlKHZpZGVvU3RyZWFtKTtcbiAgICB9XG4gIH1cblxuICBnZXRMb2NhbE1lZGlhU3RyZWFtKCkge1xuICAgIHJldHVybiB0aGlzLmxvY2FsTWVkaWFTdHJlYW07XG4gIH1cblxuICBhc3luYyBzZXRMb2NhbE1lZGlhU3RyZWFtKHN0cmVhbSkge1xuICAgIC8vIG91ciBqb2IgaGVyZSBpcyB0byBtYWtlIHN1cmUgdGhlIGNvbm5lY3Rpb24gd2luZHMgdXAgd2l0aCBSVFAgc2VuZGVycyBzZW5kaW5nIHRoZSBzdHVmZiBpbiB0aGlzIHN0cmVhbSxcbiAgICAvLyBhbmQgbm90IHRoZSBzdHVmZiB0aGF0IGlzbid0IGluIHRoaXMgc3RyZWFtLiBzdHJhdGVneSBpcyB0byByZXBsYWNlIGV4aXN0aW5nIHRyYWNrcyBpZiB3ZSBjYW4sIGFkZCB0cmFja3NcbiAgICAvLyB0aGF0IHdlIGNhbid0IHJlcGxhY2UsIGFuZCBkaXNhYmxlIHRyYWNrcyB0aGF0IGRvbid0IGV4aXN0IGFueW1vcmUuXG5cbiAgICAvLyBub3RlIHRoYXQgd2UgZG9uJ3QgZXZlciByZW1vdmUgYSB0cmFjayBmcm9tIHRoZSBzdHJlYW0gLS0gc2luY2UgSmFudXMgZG9lc24ndCBzdXBwb3J0IFVuaWZpZWQgUGxhbiwgd2UgYWJzb2x1dGVseVxuICAgIC8vIGNhbid0IHdpbmQgdXAgd2l0aCBhIFNEUCB0aGF0IGhhcyA+MSBhdWRpbyBvciA+MSB2aWRlbyB0cmFja3MsIGV2ZW4gaWYgb25lIG9mIHRoZW0gaXMgaW5hY3RpdmUgKHdoYXQgeW91IGdldCBpZlxuICAgIC8vIHlvdSByZW1vdmUgYSB0cmFjayBmcm9tIGFuIGV4aXN0aW5nIHN0cmVhbS4pXG4gICAgaWYgKHRoaXMucHVibGlzaGVyICYmIHRoaXMucHVibGlzaGVyLmNvbm4pIHtcbiAgICAgIGNvbnN0IGV4aXN0aW5nU2VuZGVycyA9IHRoaXMucHVibGlzaGVyLmNvbm4uZ2V0U2VuZGVycygpO1xuICAgICAgY29uc3QgbmV3U2VuZGVycyA9IFtdO1xuICAgICAgY29uc3QgdHJhY2tzID0gc3RyZWFtLmdldFRyYWNrcygpO1xuXG4gICAgICBmb3IgKGxldCBpID0gMDsgaSA8IHRyYWNrcy5sZW5ndGg7IGkrKykge1xuICAgICAgICBjb25zdCB0ID0gdHJhY2tzW2ldO1xuICAgICAgICBjb25zdCBzZW5kZXIgPSBleGlzdGluZ1NlbmRlcnMuZmluZChzID0+IHMudHJhY2sgIT0gbnVsbCAmJiBzLnRyYWNrLmtpbmQgPT0gdC5raW5kKTtcblxuICAgICAgICBpZiAoc2VuZGVyICE9IG51bGwpIHtcbiAgICAgICAgICBpZiAoc2VuZGVyLnJlcGxhY2VUcmFjaykge1xuICAgICAgICAgICAgYXdhaXQgc2VuZGVyLnJlcGxhY2VUcmFjayh0KTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgLy8gRmFsbGJhY2sgZm9yIGJyb3dzZXJzIHRoYXQgZG9uJ3Qgc3VwcG9ydCByZXBsYWNlVHJhY2suIEF0IHRoaXMgdGltZSBvZiB0aGlzIHdyaXRpbmdcbiAgICAgICAgICAgIC8vIG1vc3QgYnJvd3NlcnMgc3VwcG9ydCBpdCwgYW5kIHRlc3RpbmcgdGhpcyBjb2RlIHBhdGggc2VlbXMgdG8gbm90IHdvcmsgcHJvcGVybHlcbiAgICAgICAgICAgIC8vIGluIENocm9tZSBhbnltb3JlLlxuICAgICAgICAgICAgc3RyZWFtLnJlbW92ZVRyYWNrKHNlbmRlci50cmFjayk7XG4gICAgICAgICAgICBzdHJlYW0uYWRkVHJhY2sodCk7XG4gICAgICAgICAgfVxuICAgICAgICAgIG5ld1NlbmRlcnMucHVzaChzZW5kZXIpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIG5ld1NlbmRlcnMucHVzaCh0aGlzLnB1Ymxpc2hlci5jb25uLmFkZFRyYWNrKHQsIHN0cmVhbSkpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBleGlzdGluZ1NlbmRlcnMuZm9yRWFjaChzID0+IHtcbiAgICAgICAgaWYgKCFuZXdTZW5kZXJzLmluY2x1ZGVzKHMpKSB7XG4gICAgICAgICAgcy50cmFjay5lbmFibGVkID0gZmFsc2U7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgIH1cbiAgICB0aGlzLmxvY2FsTWVkaWFTdHJlYW0gPSBzdHJlYW07XG4gICAgdGhpcy5zZXRNZWRpYVN0cmVhbSh0aGlzLmNsaWVudElkLCBzdHJlYW0pO1xuICB9XG5cbiAgZW5hYmxlTWljcm9waG9uZShlbmFibGVkKSB7XG4gICAgaWYgKHRoaXMucHVibGlzaGVyICYmIHRoaXMucHVibGlzaGVyLmNvbm4pIHtcbiAgICAgIHRoaXMucHVibGlzaGVyLmNvbm4uZ2V0U2VuZGVycygpLmZvckVhY2gocyA9PiB7XG4gICAgICAgIGlmIChzLnRyYWNrLmtpbmQgPT0gXCJhdWRpb1wiKSB7XG4gICAgICAgICAgcy50cmFjay5lbmFibGVkID0gZW5hYmxlZDtcbiAgICAgICAgfVxuICAgICAgfSk7XG4gICAgfVxuICB9XG5cbiAgc2VuZERhdGEoY2xpZW50SWQsIGRhdGFUeXBlLCBkYXRhKSB7XG4gICAgaWYgKCF0aGlzLnB1Ymxpc2hlcikge1xuICAgICAgY29uc29sZS53YXJuKFwic2VuZERhdGEgY2FsbGVkIHdpdGhvdXQgYSBwdWJsaXNoZXJcIik7XG4gICAgfSBlbHNlIHtcbiAgICAgIHN3aXRjaCAodGhpcy51bnJlbGlhYmxlVHJhbnNwb3J0KSB7XG4gICAgICAgIGNhc2UgXCJ3ZWJzb2NrZXRcIjpcbiAgICAgICAgICBpZiAodGhpcy53cy5yZWFkeVN0YXRlID09PSAxKSB7IC8vIE9QRU5cbiAgICAgICAgICAgIHRoaXMucHVibGlzaGVyLmhhbmRsZS5zZW5kTWVzc2FnZSh7IGtpbmQ6IFwiZGF0YVwiLCBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGRhdGFUeXBlLCBkYXRhIH0pLCB3aG9tOiBjbGllbnRJZCB9KTtcbiAgICAgICAgICB9XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIGNhc2UgXCJkYXRhY2hhbm5lbFwiOlxuICAgICAgICAgIGlmICh0aGlzLnB1Ymxpc2hlci51bnJlbGlhYmxlQ2hhbm5lbC5yZWFkeVN0YXRlID09PSBcIm9wZW5cIikge1xuICAgICAgICAgICAgdGhpcy5wdWJsaXNoZXIudW5yZWxpYWJsZUNoYW5uZWwuc2VuZChKU09OLnN0cmluZ2lmeSh7IGNsaWVudElkLCBkYXRhVHlwZSwgZGF0YSB9KSk7XG4gICAgICAgICAgfVxuICAgICAgICAgIGJyZWFrO1xuICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgIHRoaXMudW5yZWxpYWJsZVRyYW5zcG9ydChjbGllbnRJZCwgZGF0YVR5cGUsIGRhdGEpO1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIHNlbmREYXRhR3VhcmFudGVlZChjbGllbnRJZCwgZGF0YVR5cGUsIGRhdGEpIHtcbiAgICBpZiAoIXRoaXMucHVibGlzaGVyKSB7XG4gICAgICBjb25zb2xlLndhcm4oXCJzZW5kRGF0YUd1YXJhbnRlZWQgY2FsbGVkIHdpdGhvdXQgYSBwdWJsaXNoZXJcIik7XG4gICAgfSBlbHNlIHtcbiAgICAgIHN3aXRjaCAodGhpcy5yZWxpYWJsZVRyYW5zcG9ydCkge1xuICAgICAgICBjYXNlIFwid2Vic29ja2V0XCI6XG4gICAgICAgICAgaWYgKHRoaXMud3MucmVhZHlTdGF0ZSA9PT0gMSkgeyAvLyBPUEVOXG4gICAgICAgICAgICB0aGlzLnB1Ymxpc2hlci5oYW5kbGUuc2VuZE1lc3NhZ2UoeyBraW5kOiBcImRhdGFcIiwgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBkYXRhVHlwZSwgZGF0YSB9KSwgd2hvbTogY2xpZW50SWQgfSk7XG4gICAgICAgICAgfVxuICAgICAgICAgIGJyZWFrO1xuICAgICAgICBjYXNlIFwiZGF0YWNoYW5uZWxcIjpcbiAgICAgICAgICBpZiAodGhpcy5wdWJsaXNoZXIucmVsaWFibGVDaGFubmVsLnJlYWR5U3RhdGUgPT09IFwib3BlblwiKSB7XG4gICAgICAgICAgICB0aGlzLnB1Ymxpc2hlci5yZWxpYWJsZUNoYW5uZWwuc2VuZChKU09OLnN0cmluZ2lmeSh7IGNsaWVudElkLCBkYXRhVHlwZSwgZGF0YSB9KSk7XG4gICAgICAgICAgfVxuICAgICAgICAgIGJyZWFrO1xuICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgIHRoaXMucmVsaWFibGVUcmFuc3BvcnQoY2xpZW50SWQsIGRhdGFUeXBlLCBkYXRhKTtcbiAgICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBicm9hZGNhc3REYXRhKGRhdGFUeXBlLCBkYXRhKSB7XG4gICAgaWYgKCF0aGlzLnB1Ymxpc2hlcikge1xuICAgICAgY29uc29sZS53YXJuKFwiYnJvYWRjYXN0RGF0YSBjYWxsZWQgd2l0aG91dCBhIHB1Ymxpc2hlclwiKTtcbiAgICB9IGVsc2Uge1xuICAgICAgc3dpdGNoICh0aGlzLnVucmVsaWFibGVUcmFuc3BvcnQpIHtcbiAgICAgICAgY2FzZSBcIndlYnNvY2tldFwiOlxuICAgICAgICAgIGlmICh0aGlzLndzLnJlYWR5U3RhdGUgPT09IDEpIHsgLy8gT1BFTlxuICAgICAgICAgICAgdGhpcy5wdWJsaXNoZXIuaGFuZGxlLnNlbmRNZXNzYWdlKHsga2luZDogXCJkYXRhXCIsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZGF0YVR5cGUsIGRhdGEgfSkgfSk7XG4gICAgICAgICAgfVxuICAgICAgICAgIGJyZWFrO1xuICAgICAgICBjYXNlIFwiZGF0YWNoYW5uZWxcIjpcbiAgICAgICAgICBpZiAodGhpcy5wdWJsaXNoZXIudW5yZWxpYWJsZUNoYW5uZWwucmVhZHlTdGF0ZSA9PT0gXCJvcGVuXCIpIHtcbiAgICAgICAgICAgIHRoaXMucHVibGlzaGVyLnVucmVsaWFibGVDaGFubmVsLnNlbmQoSlNPTi5zdHJpbmdpZnkoeyBkYXRhVHlwZSwgZGF0YSB9KSk7XG4gICAgICAgICAgfVxuICAgICAgICAgIGJyZWFrO1xuICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgIHRoaXMudW5yZWxpYWJsZVRyYW5zcG9ydCh1bmRlZmluZWQsIGRhdGFUeXBlLCBkYXRhKTtcbiAgICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBicm9hZGNhc3REYXRhR3VhcmFudGVlZChkYXRhVHlwZSwgZGF0YSkge1xuICAgIGlmICghdGhpcy5wdWJsaXNoZXIpIHtcbiAgICAgIGNvbnNvbGUud2FybihcImJyb2FkY2FzdERhdGFHdWFyYW50ZWVkIGNhbGxlZCB3aXRob3V0IGEgcHVibGlzaGVyXCIpO1xuICAgIH0gZWxzZSB7XG4gICAgICBzd2l0Y2ggKHRoaXMucmVsaWFibGVUcmFuc3BvcnQpIHtcbiAgICAgICAgY2FzZSBcIndlYnNvY2tldFwiOlxuICAgICAgICAgIGlmICh0aGlzLndzLnJlYWR5U3RhdGUgPT09IDEpIHsgLy8gT1BFTlxuICAgICAgICAgICAgdGhpcy5wdWJsaXNoZXIuaGFuZGxlLnNlbmRNZXNzYWdlKHsga2luZDogXCJkYXRhXCIsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZGF0YVR5cGUsIGRhdGEgfSkgfSk7XG4gICAgICAgICAgfVxuICAgICAgICAgIGJyZWFrO1xuICAgICAgICBjYXNlIFwiZGF0YWNoYW5uZWxcIjpcbiAgICAgICAgICBpZiAodGhpcy5wdWJsaXNoZXIucmVsaWFibGVDaGFubmVsLnJlYWR5U3RhdGUgPT09IFwib3BlblwiKSB7XG4gICAgICAgICAgICB0aGlzLnB1Ymxpc2hlci5yZWxpYWJsZUNoYW5uZWwuc2VuZChKU09OLnN0cmluZ2lmeSh7IGRhdGFUeXBlLCBkYXRhIH0pKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgdGhpcy5yZWxpYWJsZVRyYW5zcG9ydCh1bmRlZmluZWQsIGRhdGFUeXBlLCBkYXRhKTtcbiAgICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBraWNrKGNsaWVudElkLCBwZXJtc1Rva2VuKSB7XG4gICAgcmV0dXJuIHRoaXMucHVibGlzaGVyLmhhbmRsZS5zZW5kTWVzc2FnZSh7IGtpbmQ6IFwia2lja1wiLCByb29tX2lkOiB0aGlzLnJvb20sIHVzZXJfaWQ6IGNsaWVudElkLCB0b2tlbjogcGVybXNUb2tlbiB9KS50aGVuKCgpID0+IHtcbiAgICAgIGRvY3VtZW50LmJvZHkuZGlzcGF0Y2hFdmVudChuZXcgQ3VzdG9tRXZlbnQoXCJraWNrZWRcIiwgeyBkZXRhaWw6IHsgY2xpZW50SWQ6IGNsaWVudElkIH0gfSkpO1xuICAgIH0pO1xuICB9XG5cbiAgYmxvY2soY2xpZW50SWQpIHtcbiAgICByZXR1cm4gdGhpcy5wdWJsaXNoZXIuaGFuZGxlLnNlbmRNZXNzYWdlKHsga2luZDogXCJibG9ja1wiLCB3aG9tOiBjbGllbnRJZCB9KS50aGVuKCgpID0+IHtcbiAgICAgIHRoaXMuYmxvY2tlZENsaWVudHMuc2V0KGNsaWVudElkLCB0cnVlKTtcbiAgICAgIGRvY3VtZW50LmJvZHkuZGlzcGF0Y2hFdmVudChuZXcgQ3VzdG9tRXZlbnQoXCJibG9ja2VkXCIsIHsgZGV0YWlsOiB7IGNsaWVudElkOiBjbGllbnRJZCB9IH0pKTtcbiAgICB9KTtcbiAgfVxuXG4gIHVuYmxvY2soY2xpZW50SWQpIHtcbiAgICByZXR1cm4gdGhpcy5wdWJsaXNoZXIuaGFuZGxlLnNlbmRNZXNzYWdlKHsga2luZDogXCJ1bmJsb2NrXCIsIHdob206IGNsaWVudElkIH0pLnRoZW4oKCkgPT4ge1xuICAgICAgdGhpcy5ibG9ja2VkQ2xpZW50cy5kZWxldGUoY2xpZW50SWQpO1xuICAgICAgZG9jdW1lbnQuYm9keS5kaXNwYXRjaEV2ZW50KG5ldyBDdXN0b21FdmVudChcInVuYmxvY2tlZFwiLCB7IGRldGFpbDogeyBjbGllbnRJZDogY2xpZW50SWQgfSB9KSk7XG4gICAgfSk7XG4gIH1cbn1cblxuTkFGLmFkYXB0ZXJzLnJlZ2lzdGVyKFwiamFudXNcIiwgSmFudXNBZGFwdGVyKTtcblxubW9kdWxlLmV4cG9ydHMgPSBKYW51c0FkYXB0ZXI7XG4iLCIvKiBlc2xpbnQtZW52IG5vZGUgKi9cbid1c2Ugc3RyaWN0JztcblxuLy8gU0RQIGhlbHBlcnMuXG5jb25zdCBTRFBVdGlscyA9IHt9O1xuXG4vLyBHZW5lcmF0ZSBhbiBhbHBoYW51bWVyaWMgaWRlbnRpZmllciBmb3IgY25hbWUgb3IgbWlkcy5cbi8vIFRPRE86IHVzZSBVVUlEcyBpbnN0ZWFkPyBodHRwczovL2dpc3QuZ2l0aHViLmNvbS9qZWQvOTgyODgzXG5TRFBVdGlscy5nZW5lcmF0ZUlkZW50aWZpZXIgPSBmdW5jdGlvbigpIHtcbiAgcmV0dXJuIE1hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnN1YnN0cmluZygyLCAxMik7XG59O1xuXG4vLyBUaGUgUlRDUCBDTkFNRSB1c2VkIGJ5IGFsbCBwZWVyY29ubmVjdGlvbnMgZnJvbSB0aGUgc2FtZSBKUy5cblNEUFV0aWxzLmxvY2FsQ05hbWUgPSBTRFBVdGlscy5nZW5lcmF0ZUlkZW50aWZpZXIoKTtcblxuLy8gU3BsaXRzIFNEUCBpbnRvIGxpbmVzLCBkZWFsaW5nIHdpdGggYm90aCBDUkxGIGFuZCBMRi5cblNEUFV0aWxzLnNwbGl0TGluZXMgPSBmdW5jdGlvbihibG9iKSB7XG4gIHJldHVybiBibG9iLnRyaW0oKS5zcGxpdCgnXFxuJykubWFwKGxpbmUgPT4gbGluZS50cmltKCkpO1xufTtcbi8vIFNwbGl0cyBTRFAgaW50byBzZXNzaW9ucGFydCBhbmQgbWVkaWFzZWN0aW9ucy4gRW5zdXJlcyBDUkxGLlxuU0RQVXRpbHMuc3BsaXRTZWN0aW9ucyA9IGZ1bmN0aW9uKGJsb2IpIHtcbiAgY29uc3QgcGFydHMgPSBibG9iLnNwbGl0KCdcXG5tPScpO1xuICByZXR1cm4gcGFydHMubWFwKChwYXJ0LCBpbmRleCkgPT4gKGluZGV4ID4gMCA/XG4gICAgJ209JyArIHBhcnQgOiBwYXJ0KS50cmltKCkgKyAnXFxyXFxuJyk7XG59O1xuXG4vLyBSZXR1cm5zIHRoZSBzZXNzaW9uIGRlc2NyaXB0aW9uLlxuU0RQVXRpbHMuZ2V0RGVzY3JpcHRpb24gPSBmdW5jdGlvbihibG9iKSB7XG4gIGNvbnN0IHNlY3Rpb25zID0gU0RQVXRpbHMuc3BsaXRTZWN0aW9ucyhibG9iKTtcbiAgcmV0dXJuIHNlY3Rpb25zICYmIHNlY3Rpb25zWzBdO1xufTtcblxuLy8gUmV0dXJucyB0aGUgaW5kaXZpZHVhbCBtZWRpYSBzZWN0aW9ucy5cblNEUFV0aWxzLmdldE1lZGlhU2VjdGlvbnMgPSBmdW5jdGlvbihibG9iKSB7XG4gIGNvbnN0IHNlY3Rpb25zID0gU0RQVXRpbHMuc3BsaXRTZWN0aW9ucyhibG9iKTtcbiAgc2VjdGlvbnMuc2hpZnQoKTtcbiAgcmV0dXJuIHNlY3Rpb25zO1xufTtcblxuLy8gUmV0dXJucyBsaW5lcyB0aGF0IHN0YXJ0IHdpdGggYSBjZXJ0YWluIHByZWZpeC5cblNEUFV0aWxzLm1hdGNoUHJlZml4ID0gZnVuY3Rpb24oYmxvYiwgcHJlZml4KSB7XG4gIHJldHVybiBTRFBVdGlscy5zcGxpdExpbmVzKGJsb2IpLmZpbHRlcihsaW5lID0+IGxpbmUuaW5kZXhPZihwcmVmaXgpID09PSAwKTtcbn07XG5cbi8vIFBhcnNlcyBhbiBJQ0UgY2FuZGlkYXRlIGxpbmUuIFNhbXBsZSBpbnB1dDpcbi8vIGNhbmRpZGF0ZTo3MDI3ODYzNTAgMiB1ZHAgNDE4MTk5MDIgOC44LjguOCA2MDc2OSB0eXAgcmVsYXkgcmFkZHIgOC44LjguOFxuLy8gcnBvcnQgNTU5OTZcIlxuLy8gSW5wdXQgY2FuIGJlIHByZWZpeGVkIHdpdGggYT0uXG5TRFBVdGlscy5wYXJzZUNhbmRpZGF0ZSA9IGZ1bmN0aW9uKGxpbmUpIHtcbiAgbGV0IHBhcnRzO1xuICAvLyBQYXJzZSBib3RoIHZhcmlhbnRzLlxuICBpZiAobGluZS5pbmRleE9mKCdhPWNhbmRpZGF0ZTonKSA9PT0gMCkge1xuICAgIHBhcnRzID0gbGluZS5zdWJzdHJpbmcoMTIpLnNwbGl0KCcgJyk7XG4gIH0gZWxzZSB7XG4gICAgcGFydHMgPSBsaW5lLnN1YnN0cmluZygxMCkuc3BsaXQoJyAnKTtcbiAgfVxuXG4gIGNvbnN0IGNhbmRpZGF0ZSA9IHtcbiAgICBmb3VuZGF0aW9uOiBwYXJ0c1swXSxcbiAgICBjb21wb25lbnQ6IHsxOiAncnRwJywgMjogJ3J0Y3AnfVtwYXJ0c1sxXV0gfHwgcGFydHNbMV0sXG4gICAgcHJvdG9jb2w6IHBhcnRzWzJdLnRvTG93ZXJDYXNlKCksXG4gICAgcHJpb3JpdHk6IHBhcnNlSW50KHBhcnRzWzNdLCAxMCksXG4gICAgaXA6IHBhcnRzWzRdLFxuICAgIGFkZHJlc3M6IHBhcnRzWzRdLCAvLyBhZGRyZXNzIGlzIGFuIGFsaWFzIGZvciBpcC5cbiAgICBwb3J0OiBwYXJzZUludChwYXJ0c1s1XSwgMTApLFxuICAgIC8vIHNraXAgcGFydHNbNl0gPT0gJ3R5cCdcbiAgICB0eXBlOiBwYXJ0c1s3XSxcbiAgfTtcblxuICBmb3IgKGxldCBpID0gODsgaSA8IHBhcnRzLmxlbmd0aDsgaSArPSAyKSB7XG4gICAgc3dpdGNoIChwYXJ0c1tpXSkge1xuICAgICAgY2FzZSAncmFkZHInOlxuICAgICAgICBjYW5kaWRhdGUucmVsYXRlZEFkZHJlc3MgPSBwYXJ0c1tpICsgMV07XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAncnBvcnQnOlxuICAgICAgICBjYW5kaWRhdGUucmVsYXRlZFBvcnQgPSBwYXJzZUludChwYXJ0c1tpICsgMV0sIDEwKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlICd0Y3B0eXBlJzpcbiAgICAgICAgY2FuZGlkYXRlLnRjcFR5cGUgPSBwYXJ0c1tpICsgMV07XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAndWZyYWcnOlxuICAgICAgICBjYW5kaWRhdGUudWZyYWcgPSBwYXJ0c1tpICsgMV07IC8vIGZvciBiYWNrd2FyZCBjb21wYXRpYmlsaXR5LlxuICAgICAgICBjYW5kaWRhdGUudXNlcm5hbWVGcmFnbWVudCA9IHBhcnRzW2kgKyAxXTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBkZWZhdWx0OiAvLyBleHRlbnNpb24gaGFuZGxpbmcsIGluIHBhcnRpY3VsYXIgdWZyYWcuIERvbid0IG92ZXJ3cml0ZS5cbiAgICAgICAgaWYgKGNhbmRpZGF0ZVtwYXJ0c1tpXV0gPT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgIGNhbmRpZGF0ZVtwYXJ0c1tpXV0gPSBwYXJ0c1tpICsgMV07XG4gICAgICAgIH1cbiAgICAgICAgYnJlYWs7XG4gICAgfVxuICB9XG4gIHJldHVybiBjYW5kaWRhdGU7XG59O1xuXG4vLyBUcmFuc2xhdGVzIGEgY2FuZGlkYXRlIG9iamVjdCBpbnRvIFNEUCBjYW5kaWRhdGUgYXR0cmlidXRlLlxuLy8gVGhpcyBkb2VzIG5vdCBpbmNsdWRlIHRoZSBhPSBwcmVmaXghXG5TRFBVdGlscy53cml0ZUNhbmRpZGF0ZSA9IGZ1bmN0aW9uKGNhbmRpZGF0ZSkge1xuICBjb25zdCBzZHAgPSBbXTtcbiAgc2RwLnB1c2goY2FuZGlkYXRlLmZvdW5kYXRpb24pO1xuXG4gIGNvbnN0IGNvbXBvbmVudCA9IGNhbmRpZGF0ZS5jb21wb25lbnQ7XG4gIGlmIChjb21wb25lbnQgPT09ICdydHAnKSB7XG4gICAgc2RwLnB1c2goMSk7XG4gIH0gZWxzZSBpZiAoY29tcG9uZW50ID09PSAncnRjcCcpIHtcbiAgICBzZHAucHVzaCgyKTtcbiAgfSBlbHNlIHtcbiAgICBzZHAucHVzaChjb21wb25lbnQpO1xuICB9XG4gIHNkcC5wdXNoKGNhbmRpZGF0ZS5wcm90b2NvbC50b1VwcGVyQ2FzZSgpKTtcbiAgc2RwLnB1c2goY2FuZGlkYXRlLnByaW9yaXR5KTtcbiAgc2RwLnB1c2goY2FuZGlkYXRlLmFkZHJlc3MgfHwgY2FuZGlkYXRlLmlwKTtcbiAgc2RwLnB1c2goY2FuZGlkYXRlLnBvcnQpO1xuXG4gIGNvbnN0IHR5cGUgPSBjYW5kaWRhdGUudHlwZTtcbiAgc2RwLnB1c2goJ3R5cCcpO1xuICBzZHAucHVzaCh0eXBlKTtcbiAgaWYgKHR5cGUgIT09ICdob3N0JyAmJiBjYW5kaWRhdGUucmVsYXRlZEFkZHJlc3MgJiZcbiAgICAgIGNhbmRpZGF0ZS5yZWxhdGVkUG9ydCkge1xuICAgIHNkcC5wdXNoKCdyYWRkcicpO1xuICAgIHNkcC5wdXNoKGNhbmRpZGF0ZS5yZWxhdGVkQWRkcmVzcyk7XG4gICAgc2RwLnB1c2goJ3Jwb3J0Jyk7XG4gICAgc2RwLnB1c2goY2FuZGlkYXRlLnJlbGF0ZWRQb3J0KTtcbiAgfVxuICBpZiAoY2FuZGlkYXRlLnRjcFR5cGUgJiYgY2FuZGlkYXRlLnByb3RvY29sLnRvTG93ZXJDYXNlKCkgPT09ICd0Y3AnKSB7XG4gICAgc2RwLnB1c2goJ3RjcHR5cGUnKTtcbiAgICBzZHAucHVzaChjYW5kaWRhdGUudGNwVHlwZSk7XG4gIH1cbiAgaWYgKGNhbmRpZGF0ZS51c2VybmFtZUZyYWdtZW50IHx8IGNhbmRpZGF0ZS51ZnJhZykge1xuICAgIHNkcC5wdXNoKCd1ZnJhZycpO1xuICAgIHNkcC5wdXNoKGNhbmRpZGF0ZS51c2VybmFtZUZyYWdtZW50IHx8IGNhbmRpZGF0ZS51ZnJhZyk7XG4gIH1cbiAgcmV0dXJuICdjYW5kaWRhdGU6JyArIHNkcC5qb2luKCcgJyk7XG59O1xuXG4vLyBQYXJzZXMgYW4gaWNlLW9wdGlvbnMgbGluZSwgcmV0dXJucyBhbiBhcnJheSBvZiBvcHRpb24gdGFncy5cbi8vIFNhbXBsZSBpbnB1dDpcbi8vIGE9aWNlLW9wdGlvbnM6Zm9vIGJhclxuU0RQVXRpbHMucGFyc2VJY2VPcHRpb25zID0gZnVuY3Rpb24obGluZSkge1xuICByZXR1cm4gbGluZS5zdWJzdHJpbmcoMTQpLnNwbGl0KCcgJyk7XG59O1xuXG4vLyBQYXJzZXMgYSBydHBtYXAgbGluZSwgcmV0dXJucyBSVENSdHBDb2RkZWNQYXJhbWV0ZXJzLiBTYW1wbGUgaW5wdXQ6XG4vLyBhPXJ0cG1hcDoxMTEgb3B1cy80ODAwMC8yXG5TRFBVdGlscy5wYXJzZVJ0cE1hcCA9IGZ1bmN0aW9uKGxpbmUpIHtcbiAgbGV0IHBhcnRzID0gbGluZS5zdWJzdHJpbmcoOSkuc3BsaXQoJyAnKTtcbiAgY29uc3QgcGFyc2VkID0ge1xuICAgIHBheWxvYWRUeXBlOiBwYXJzZUludChwYXJ0cy5zaGlmdCgpLCAxMCksIC8vIHdhczogaWRcbiAgfTtcblxuICBwYXJ0cyA9IHBhcnRzWzBdLnNwbGl0KCcvJyk7XG5cbiAgcGFyc2VkLm5hbWUgPSBwYXJ0c1swXTtcbiAgcGFyc2VkLmNsb2NrUmF0ZSA9IHBhcnNlSW50KHBhcnRzWzFdLCAxMCk7IC8vIHdhczogY2xvY2tyYXRlXG4gIHBhcnNlZC5jaGFubmVscyA9IHBhcnRzLmxlbmd0aCA9PT0gMyA/IHBhcnNlSW50KHBhcnRzWzJdLCAxMCkgOiAxO1xuICAvLyBsZWdhY3kgYWxpYXMsIGdvdCByZW5hbWVkIGJhY2sgdG8gY2hhbm5lbHMgaW4gT1JUQy5cbiAgcGFyc2VkLm51bUNoYW5uZWxzID0gcGFyc2VkLmNoYW5uZWxzO1xuICByZXR1cm4gcGFyc2VkO1xufTtcblxuLy8gR2VuZXJhdGVzIGEgcnRwbWFwIGxpbmUgZnJvbSBSVENSdHBDb2RlY0NhcGFiaWxpdHkgb3Jcbi8vIFJUQ1J0cENvZGVjUGFyYW1ldGVycy5cblNEUFV0aWxzLndyaXRlUnRwTWFwID0gZnVuY3Rpb24oY29kZWMpIHtcbiAgbGV0IHB0ID0gY29kZWMucGF5bG9hZFR5cGU7XG4gIGlmIChjb2RlYy5wcmVmZXJyZWRQYXlsb2FkVHlwZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcHQgPSBjb2RlYy5wcmVmZXJyZWRQYXlsb2FkVHlwZTtcbiAgfVxuICBjb25zdCBjaGFubmVscyA9IGNvZGVjLmNoYW5uZWxzIHx8IGNvZGVjLm51bUNoYW5uZWxzIHx8IDE7XG4gIHJldHVybiAnYT1ydHBtYXA6JyArIHB0ICsgJyAnICsgY29kZWMubmFtZSArICcvJyArIGNvZGVjLmNsb2NrUmF0ZSArXG4gICAgICAoY2hhbm5lbHMgIT09IDEgPyAnLycgKyBjaGFubmVscyA6ICcnKSArICdcXHJcXG4nO1xufTtcblxuLy8gUGFyc2VzIGEgZXh0bWFwIGxpbmUgKGhlYWRlcmV4dGVuc2lvbiBmcm9tIFJGQyA1Mjg1KS4gU2FtcGxlIGlucHV0OlxuLy8gYT1leHRtYXA6MiB1cm46aWV0ZjpwYXJhbXM6cnRwLWhkcmV4dDp0b2Zmc2V0XG4vLyBhPWV4dG1hcDoyL3NlbmRvbmx5IHVybjppZXRmOnBhcmFtczpydHAtaGRyZXh0OnRvZmZzZXRcblNEUFV0aWxzLnBhcnNlRXh0bWFwID0gZnVuY3Rpb24obGluZSkge1xuICBjb25zdCBwYXJ0cyA9IGxpbmUuc3Vic3RyaW5nKDkpLnNwbGl0KCcgJyk7XG4gIHJldHVybiB7XG4gICAgaWQ6IHBhcnNlSW50KHBhcnRzWzBdLCAxMCksXG4gICAgZGlyZWN0aW9uOiBwYXJ0c1swXS5pbmRleE9mKCcvJykgPiAwID8gcGFydHNbMF0uc3BsaXQoJy8nKVsxXSA6ICdzZW5kcmVjdicsXG4gICAgdXJpOiBwYXJ0c1sxXSxcbiAgICBhdHRyaWJ1dGVzOiBwYXJ0cy5zbGljZSgyKS5qb2luKCcgJyksXG4gIH07XG59O1xuXG4vLyBHZW5lcmF0ZXMgYW4gZXh0bWFwIGxpbmUgZnJvbSBSVENSdHBIZWFkZXJFeHRlbnNpb25QYXJhbWV0ZXJzIG9yXG4vLyBSVENSdHBIZWFkZXJFeHRlbnNpb24uXG5TRFBVdGlscy53cml0ZUV4dG1hcCA9IGZ1bmN0aW9uKGhlYWRlckV4dGVuc2lvbikge1xuICByZXR1cm4gJ2E9ZXh0bWFwOicgKyAoaGVhZGVyRXh0ZW5zaW9uLmlkIHx8IGhlYWRlckV4dGVuc2lvbi5wcmVmZXJyZWRJZCkgK1xuICAgICAgKGhlYWRlckV4dGVuc2lvbi5kaXJlY3Rpb24gJiYgaGVhZGVyRXh0ZW5zaW9uLmRpcmVjdGlvbiAhPT0gJ3NlbmRyZWN2J1xuICAgICAgICA/ICcvJyArIGhlYWRlckV4dGVuc2lvbi5kaXJlY3Rpb25cbiAgICAgICAgOiAnJykgK1xuICAgICAgJyAnICsgaGVhZGVyRXh0ZW5zaW9uLnVyaSArXG4gICAgICAoaGVhZGVyRXh0ZW5zaW9uLmF0dHJpYnV0ZXMgPyAnICcgKyBoZWFkZXJFeHRlbnNpb24uYXR0cmlidXRlcyA6ICcnKSArXG4gICAgICAnXFxyXFxuJztcbn07XG5cbi8vIFBhcnNlcyBhIGZtdHAgbGluZSwgcmV0dXJucyBkaWN0aW9uYXJ5LiBTYW1wbGUgaW5wdXQ6XG4vLyBhPWZtdHA6OTYgdmJyPW9uO2NuZz1vblxuLy8gQWxzbyBkZWFscyB3aXRoIHZicj1vbjsgY25nPW9uXG5TRFBVdGlscy5wYXJzZUZtdHAgPSBmdW5jdGlvbihsaW5lKSB7XG4gIGNvbnN0IHBhcnNlZCA9IHt9O1xuICBsZXQga3Y7XG4gIGNvbnN0IHBhcnRzID0gbGluZS5zdWJzdHJpbmcobGluZS5pbmRleE9mKCcgJykgKyAxKS5zcGxpdCgnOycpO1xuICBmb3IgKGxldCBqID0gMDsgaiA8IHBhcnRzLmxlbmd0aDsgaisrKSB7XG4gICAga3YgPSBwYXJ0c1tqXS50cmltKCkuc3BsaXQoJz0nKTtcbiAgICBwYXJzZWRba3ZbMF0udHJpbSgpXSA9IGt2WzFdO1xuICB9XG4gIHJldHVybiBwYXJzZWQ7XG59O1xuXG4vLyBHZW5lcmF0ZXMgYSBmbXRwIGxpbmUgZnJvbSBSVENSdHBDb2RlY0NhcGFiaWxpdHkgb3IgUlRDUnRwQ29kZWNQYXJhbWV0ZXJzLlxuU0RQVXRpbHMud3JpdGVGbXRwID0gZnVuY3Rpb24oY29kZWMpIHtcbiAgbGV0IGxpbmUgPSAnJztcbiAgbGV0IHB0ID0gY29kZWMucGF5bG9hZFR5cGU7XG4gIGlmIChjb2RlYy5wcmVmZXJyZWRQYXlsb2FkVHlwZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcHQgPSBjb2RlYy5wcmVmZXJyZWRQYXlsb2FkVHlwZTtcbiAgfVxuICBpZiAoY29kZWMucGFyYW1ldGVycyAmJiBPYmplY3Qua2V5cyhjb2RlYy5wYXJhbWV0ZXJzKS5sZW5ndGgpIHtcbiAgICBjb25zdCBwYXJhbXMgPSBbXTtcbiAgICBPYmplY3Qua2V5cyhjb2RlYy5wYXJhbWV0ZXJzKS5mb3JFYWNoKHBhcmFtID0+IHtcbiAgICAgIGlmIChjb2RlYy5wYXJhbWV0ZXJzW3BhcmFtXSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIHBhcmFtcy5wdXNoKHBhcmFtICsgJz0nICsgY29kZWMucGFyYW1ldGVyc1twYXJhbV0pO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgcGFyYW1zLnB1c2gocGFyYW0pO1xuICAgICAgfVxuICAgIH0pO1xuICAgIGxpbmUgKz0gJ2E9Zm10cDonICsgcHQgKyAnICcgKyBwYXJhbXMuam9pbignOycpICsgJ1xcclxcbic7XG4gIH1cbiAgcmV0dXJuIGxpbmU7XG59O1xuXG4vLyBQYXJzZXMgYSBydGNwLWZiIGxpbmUsIHJldHVybnMgUlRDUFJ0Y3BGZWVkYmFjayBvYmplY3QuIFNhbXBsZSBpbnB1dDpcbi8vIGE9cnRjcC1mYjo5OCBuYWNrIHJwc2lcblNEUFV0aWxzLnBhcnNlUnRjcEZiID0gZnVuY3Rpb24obGluZSkge1xuICBjb25zdCBwYXJ0cyA9IGxpbmUuc3Vic3RyaW5nKGxpbmUuaW5kZXhPZignICcpICsgMSkuc3BsaXQoJyAnKTtcbiAgcmV0dXJuIHtcbiAgICB0eXBlOiBwYXJ0cy5zaGlmdCgpLFxuICAgIHBhcmFtZXRlcjogcGFydHMuam9pbignICcpLFxuICB9O1xufTtcblxuLy8gR2VuZXJhdGUgYT1ydGNwLWZiIGxpbmVzIGZyb20gUlRDUnRwQ29kZWNDYXBhYmlsaXR5IG9yIFJUQ1J0cENvZGVjUGFyYW1ldGVycy5cblNEUFV0aWxzLndyaXRlUnRjcEZiID0gZnVuY3Rpb24oY29kZWMpIHtcbiAgbGV0IGxpbmVzID0gJyc7XG4gIGxldCBwdCA9IGNvZGVjLnBheWxvYWRUeXBlO1xuICBpZiAoY29kZWMucHJlZmVycmVkUGF5bG9hZFR5cGUgIT09IHVuZGVmaW5lZCkge1xuICAgIHB0ID0gY29kZWMucHJlZmVycmVkUGF5bG9hZFR5cGU7XG4gIH1cbiAgaWYgKGNvZGVjLnJ0Y3BGZWVkYmFjayAmJiBjb2RlYy5ydGNwRmVlZGJhY2subGVuZ3RoKSB7XG4gICAgLy8gRklYTUU6IHNwZWNpYWwgaGFuZGxpbmcgZm9yIHRyci1pbnQ/XG4gICAgY29kZWMucnRjcEZlZWRiYWNrLmZvckVhY2goZmIgPT4ge1xuICAgICAgbGluZXMgKz0gJ2E9cnRjcC1mYjonICsgcHQgKyAnICcgKyBmYi50eXBlICtcbiAgICAgIChmYi5wYXJhbWV0ZXIgJiYgZmIucGFyYW1ldGVyLmxlbmd0aCA/ICcgJyArIGZiLnBhcmFtZXRlciA6ICcnKSArXG4gICAgICAgICAgJ1xcclxcbic7XG4gICAgfSk7XG4gIH1cbiAgcmV0dXJuIGxpbmVzO1xufTtcblxuLy8gUGFyc2VzIGEgUkZDIDU1NzYgc3NyYyBtZWRpYSBhdHRyaWJ1dGUuIFNhbXBsZSBpbnB1dDpcbi8vIGE9c3NyYzozNzM1OTI4NTU5IGNuYW1lOnNvbWV0aGluZ1xuU0RQVXRpbHMucGFyc2VTc3JjTWVkaWEgPSBmdW5jdGlvbihsaW5lKSB7XG4gIGNvbnN0IHNwID0gbGluZS5pbmRleE9mKCcgJyk7XG4gIGNvbnN0IHBhcnRzID0ge1xuICAgIHNzcmM6IHBhcnNlSW50KGxpbmUuc3Vic3RyaW5nKDcsIHNwKSwgMTApLFxuICB9O1xuICBjb25zdCBjb2xvbiA9IGxpbmUuaW5kZXhPZignOicsIHNwKTtcbiAgaWYgKGNvbG9uID4gLTEpIHtcbiAgICBwYXJ0cy5hdHRyaWJ1dGUgPSBsaW5lLnN1YnN0cmluZyhzcCArIDEsIGNvbG9uKTtcbiAgICBwYXJ0cy52YWx1ZSA9IGxpbmUuc3Vic3RyaW5nKGNvbG9uICsgMSk7XG4gIH0gZWxzZSB7XG4gICAgcGFydHMuYXR0cmlidXRlID0gbGluZS5zdWJzdHJpbmcoc3AgKyAxKTtcbiAgfVxuICByZXR1cm4gcGFydHM7XG59O1xuXG4vLyBQYXJzZSBhIHNzcmMtZ3JvdXAgbGluZSAoc2VlIFJGQyA1NTc2KS4gU2FtcGxlIGlucHV0OlxuLy8gYT1zc3JjLWdyb3VwOnNlbWFudGljcyAxMiAzNFxuU0RQVXRpbHMucGFyc2VTc3JjR3JvdXAgPSBmdW5jdGlvbihsaW5lKSB7XG4gIGNvbnN0IHBhcnRzID0gbGluZS5zdWJzdHJpbmcoMTMpLnNwbGl0KCcgJyk7XG4gIHJldHVybiB7XG4gICAgc2VtYW50aWNzOiBwYXJ0cy5zaGlmdCgpLFxuICAgIHNzcmNzOiBwYXJ0cy5tYXAoc3NyYyA9PiBwYXJzZUludChzc3JjLCAxMCkpLFxuICB9O1xufTtcblxuLy8gRXh0cmFjdHMgdGhlIE1JRCAoUkZDIDU4ODgpIGZyb20gYSBtZWRpYSBzZWN0aW9uLlxuLy8gUmV0dXJucyB0aGUgTUlEIG9yIHVuZGVmaW5lZCBpZiBubyBtaWQgbGluZSB3YXMgZm91bmQuXG5TRFBVdGlscy5nZXRNaWQgPSBmdW5jdGlvbihtZWRpYVNlY3Rpb24pIHtcbiAgY29uc3QgbWlkID0gU0RQVXRpbHMubWF0Y2hQcmVmaXgobWVkaWFTZWN0aW9uLCAnYT1taWQ6JylbMF07XG4gIGlmIChtaWQpIHtcbiAgICByZXR1cm4gbWlkLnN1YnN0cmluZyg2KTtcbiAgfVxufTtcblxuLy8gUGFyc2VzIGEgZmluZ2VycHJpbnQgbGluZSBmb3IgRFRMUy1TUlRQLlxuU0RQVXRpbHMucGFyc2VGaW5nZXJwcmludCA9IGZ1bmN0aW9uKGxpbmUpIHtcbiAgY29uc3QgcGFydHMgPSBsaW5lLnN1YnN0cmluZygxNCkuc3BsaXQoJyAnKTtcbiAgcmV0dXJuIHtcbiAgICBhbGdvcml0aG06IHBhcnRzWzBdLnRvTG93ZXJDYXNlKCksIC8vIGFsZ29yaXRobSBpcyBjYXNlLXNlbnNpdGl2ZSBpbiBFZGdlLlxuICAgIHZhbHVlOiBwYXJ0c1sxXS50b1VwcGVyQ2FzZSgpLCAvLyB0aGUgZGVmaW5pdGlvbiBpcyB1cHBlci1jYXNlIGluIFJGQyA0NTcyLlxuICB9O1xufTtcblxuLy8gRXh0cmFjdHMgRFRMUyBwYXJhbWV0ZXJzIGZyb20gU0RQIG1lZGlhIHNlY3Rpb24gb3Igc2Vzc2lvbnBhcnQuXG4vLyBGSVhNRTogZm9yIGNvbnNpc3RlbmN5IHdpdGggb3RoZXIgZnVuY3Rpb25zIHRoaXMgc2hvdWxkIG9ubHlcbi8vICAgZ2V0IHRoZSBmaW5nZXJwcmludCBsaW5lIGFzIGlucHV0LiBTZWUgYWxzbyBnZXRJY2VQYXJhbWV0ZXJzLlxuU0RQVXRpbHMuZ2V0RHRsc1BhcmFtZXRlcnMgPSBmdW5jdGlvbihtZWRpYVNlY3Rpb24sIHNlc3Npb25wYXJ0KSB7XG4gIGNvbnN0IGxpbmVzID0gU0RQVXRpbHMubWF0Y2hQcmVmaXgobWVkaWFTZWN0aW9uICsgc2Vzc2lvbnBhcnQsXG4gICAgJ2E9ZmluZ2VycHJpbnQ6Jyk7XG4gIC8vIE5vdGU6IGE9c2V0dXAgbGluZSBpcyBpZ25vcmVkIHNpbmNlIHdlIHVzZSB0aGUgJ2F1dG8nIHJvbGUgaW4gRWRnZS5cbiAgcmV0dXJuIHtcbiAgICByb2xlOiAnYXV0bycsXG4gICAgZmluZ2VycHJpbnRzOiBsaW5lcy5tYXAoU0RQVXRpbHMucGFyc2VGaW5nZXJwcmludCksXG4gIH07XG59O1xuXG4vLyBTZXJpYWxpemVzIERUTFMgcGFyYW1ldGVycyB0byBTRFAuXG5TRFBVdGlscy53cml0ZUR0bHNQYXJhbWV0ZXJzID0gZnVuY3Rpb24ocGFyYW1zLCBzZXR1cFR5cGUpIHtcbiAgbGV0IHNkcCA9ICdhPXNldHVwOicgKyBzZXR1cFR5cGUgKyAnXFxyXFxuJztcbiAgcGFyYW1zLmZpbmdlcnByaW50cy5mb3JFYWNoKGZwID0+IHtcbiAgICBzZHAgKz0gJ2E9ZmluZ2VycHJpbnQ6JyArIGZwLmFsZ29yaXRobSArICcgJyArIGZwLnZhbHVlICsgJ1xcclxcbic7XG4gIH0pO1xuICByZXR1cm4gc2RwO1xufTtcblxuLy8gUGFyc2VzIGE9Y3J5cHRvIGxpbmVzIGludG9cbi8vICAgaHR0cHM6Ly9yYXdnaXQuY29tL2Fib2JhL2VkZ2VydGMvbWFzdGVyL21zb3J0Yy1yczQuaHRtbCNkaWN0aW9uYXJ5LXJ0Y3NydHBzZGVzcGFyYW1ldGVycy1tZW1iZXJzXG5TRFBVdGlscy5wYXJzZUNyeXB0b0xpbmUgPSBmdW5jdGlvbihsaW5lKSB7XG4gIGNvbnN0IHBhcnRzID0gbGluZS5zdWJzdHJpbmcoOSkuc3BsaXQoJyAnKTtcbiAgcmV0dXJuIHtcbiAgICB0YWc6IHBhcnNlSW50KHBhcnRzWzBdLCAxMCksXG4gICAgY3J5cHRvU3VpdGU6IHBhcnRzWzFdLFxuICAgIGtleVBhcmFtczogcGFydHNbMl0sXG4gICAgc2Vzc2lvblBhcmFtczogcGFydHMuc2xpY2UoMyksXG4gIH07XG59O1xuXG5TRFBVdGlscy53cml0ZUNyeXB0b0xpbmUgPSBmdW5jdGlvbihwYXJhbWV0ZXJzKSB7XG4gIHJldHVybiAnYT1jcnlwdG86JyArIHBhcmFtZXRlcnMudGFnICsgJyAnICtcbiAgICBwYXJhbWV0ZXJzLmNyeXB0b1N1aXRlICsgJyAnICtcbiAgICAodHlwZW9mIHBhcmFtZXRlcnMua2V5UGFyYW1zID09PSAnb2JqZWN0J1xuICAgICAgPyBTRFBVdGlscy53cml0ZUNyeXB0b0tleVBhcmFtcyhwYXJhbWV0ZXJzLmtleVBhcmFtcylcbiAgICAgIDogcGFyYW1ldGVycy5rZXlQYXJhbXMpICtcbiAgICAocGFyYW1ldGVycy5zZXNzaW9uUGFyYW1zID8gJyAnICsgcGFyYW1ldGVycy5zZXNzaW9uUGFyYW1zLmpvaW4oJyAnKSA6ICcnKSArXG4gICAgJ1xcclxcbic7XG59O1xuXG4vLyBQYXJzZXMgdGhlIGNyeXB0byBrZXkgcGFyYW1ldGVycyBpbnRvXG4vLyAgIGh0dHBzOi8vcmF3Z2l0LmNvbS9hYm9iYS9lZGdlcnRjL21hc3Rlci9tc29ydGMtcnM0Lmh0bWwjcnRjc3J0cGtleXBhcmFtKlxuU0RQVXRpbHMucGFyc2VDcnlwdG9LZXlQYXJhbXMgPSBmdW5jdGlvbihrZXlQYXJhbXMpIHtcbiAgaWYgKGtleVBhcmFtcy5pbmRleE9mKCdpbmxpbmU6JykgIT09IDApIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuICBjb25zdCBwYXJ0cyA9IGtleVBhcmFtcy5zdWJzdHJpbmcoNykuc3BsaXQoJ3wnKTtcbiAgcmV0dXJuIHtcbiAgICBrZXlNZXRob2Q6ICdpbmxpbmUnLFxuICAgIGtleVNhbHQ6IHBhcnRzWzBdLFxuICAgIGxpZmVUaW1lOiBwYXJ0c1sxXSxcbiAgICBta2lWYWx1ZTogcGFydHNbMl0gPyBwYXJ0c1syXS5zcGxpdCgnOicpWzBdIDogdW5kZWZpbmVkLFxuICAgIG1raUxlbmd0aDogcGFydHNbMl0gPyBwYXJ0c1syXS5zcGxpdCgnOicpWzFdIDogdW5kZWZpbmVkLFxuICB9O1xufTtcblxuU0RQVXRpbHMud3JpdGVDcnlwdG9LZXlQYXJhbXMgPSBmdW5jdGlvbihrZXlQYXJhbXMpIHtcbiAgcmV0dXJuIGtleVBhcmFtcy5rZXlNZXRob2QgKyAnOidcbiAgICArIGtleVBhcmFtcy5rZXlTYWx0ICtcbiAgICAoa2V5UGFyYW1zLmxpZmVUaW1lID8gJ3wnICsga2V5UGFyYW1zLmxpZmVUaW1lIDogJycpICtcbiAgICAoa2V5UGFyYW1zLm1raVZhbHVlICYmIGtleVBhcmFtcy5ta2lMZW5ndGhcbiAgICAgID8gJ3wnICsga2V5UGFyYW1zLm1raVZhbHVlICsgJzonICsga2V5UGFyYW1zLm1raUxlbmd0aFxuICAgICAgOiAnJyk7XG59O1xuXG4vLyBFeHRyYWN0cyBhbGwgU0RFUyBwYXJhbWV0ZXJzLlxuU0RQVXRpbHMuZ2V0Q3J5cHRvUGFyYW1ldGVycyA9IGZ1bmN0aW9uKG1lZGlhU2VjdGlvbiwgc2Vzc2lvbnBhcnQpIHtcbiAgY29uc3QgbGluZXMgPSBTRFBVdGlscy5tYXRjaFByZWZpeChtZWRpYVNlY3Rpb24gKyBzZXNzaW9ucGFydCxcbiAgICAnYT1jcnlwdG86Jyk7XG4gIHJldHVybiBsaW5lcy5tYXAoU0RQVXRpbHMucGFyc2VDcnlwdG9MaW5lKTtcbn07XG5cbi8vIFBhcnNlcyBJQ0UgaW5mb3JtYXRpb24gZnJvbSBTRFAgbWVkaWEgc2VjdGlvbiBvciBzZXNzaW9ucGFydC5cbi8vIEZJWE1FOiBmb3IgY29uc2lzdGVuY3kgd2l0aCBvdGhlciBmdW5jdGlvbnMgdGhpcyBzaG91bGQgb25seVxuLy8gICBnZXQgdGhlIGljZS11ZnJhZyBhbmQgaWNlLXB3ZCBsaW5lcyBhcyBpbnB1dC5cblNEUFV0aWxzLmdldEljZVBhcmFtZXRlcnMgPSBmdW5jdGlvbihtZWRpYVNlY3Rpb24sIHNlc3Npb25wYXJ0KSB7XG4gIGNvbnN0IHVmcmFnID0gU0RQVXRpbHMubWF0Y2hQcmVmaXgobWVkaWFTZWN0aW9uICsgc2Vzc2lvbnBhcnQsXG4gICAgJ2E9aWNlLXVmcmFnOicpWzBdO1xuICBjb25zdCBwd2QgPSBTRFBVdGlscy5tYXRjaFByZWZpeChtZWRpYVNlY3Rpb24gKyBzZXNzaW9ucGFydCxcbiAgICAnYT1pY2UtcHdkOicpWzBdO1xuICBpZiAoISh1ZnJhZyAmJiBwd2QpKSB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbiAgcmV0dXJuIHtcbiAgICB1c2VybmFtZUZyYWdtZW50OiB1ZnJhZy5zdWJzdHJpbmcoMTIpLFxuICAgIHBhc3N3b3JkOiBwd2Quc3Vic3RyaW5nKDEwKSxcbiAgfTtcbn07XG5cbi8vIFNlcmlhbGl6ZXMgSUNFIHBhcmFtZXRlcnMgdG8gU0RQLlxuU0RQVXRpbHMud3JpdGVJY2VQYXJhbWV0ZXJzID0gZnVuY3Rpb24ocGFyYW1zKSB7XG4gIGxldCBzZHAgPSAnYT1pY2UtdWZyYWc6JyArIHBhcmFtcy51c2VybmFtZUZyYWdtZW50ICsgJ1xcclxcbicgK1xuICAgICAgJ2E9aWNlLXB3ZDonICsgcGFyYW1zLnBhc3N3b3JkICsgJ1xcclxcbic7XG4gIGlmIChwYXJhbXMuaWNlTGl0ZSkge1xuICAgIHNkcCArPSAnYT1pY2UtbGl0ZVxcclxcbic7XG4gIH1cbiAgcmV0dXJuIHNkcDtcbn07XG5cbi8vIFBhcnNlcyB0aGUgU0RQIG1lZGlhIHNlY3Rpb24gYW5kIHJldHVybnMgUlRDUnRwUGFyYW1ldGVycy5cblNEUFV0aWxzLnBhcnNlUnRwUGFyYW1ldGVycyA9IGZ1bmN0aW9uKG1lZGlhU2VjdGlvbikge1xuICBjb25zdCBkZXNjcmlwdGlvbiA9IHtcbiAgICBjb2RlY3M6IFtdLFxuICAgIGhlYWRlckV4dGVuc2lvbnM6IFtdLFxuICAgIGZlY01lY2hhbmlzbXM6IFtdLFxuICAgIHJ0Y3A6IFtdLFxuICB9O1xuICBjb25zdCBsaW5lcyA9IFNEUFV0aWxzLnNwbGl0TGluZXMobWVkaWFTZWN0aW9uKTtcbiAgY29uc3QgbWxpbmUgPSBsaW5lc1swXS5zcGxpdCgnICcpO1xuICBkZXNjcmlwdGlvbi5wcm9maWxlID0gbWxpbmVbMl07XG4gIGZvciAobGV0IGkgPSAzOyBpIDwgbWxpbmUubGVuZ3RoOyBpKyspIHsgLy8gZmluZCBhbGwgY29kZWNzIGZyb20gbWxpbmVbMy4uXVxuICAgIGNvbnN0IHB0ID0gbWxpbmVbaV07XG4gICAgY29uc3QgcnRwbWFwbGluZSA9IFNEUFV0aWxzLm1hdGNoUHJlZml4KFxuICAgICAgbWVkaWFTZWN0aW9uLCAnYT1ydHBtYXA6JyArIHB0ICsgJyAnKVswXTtcbiAgICBpZiAocnRwbWFwbGluZSkge1xuICAgICAgY29uc3QgY29kZWMgPSBTRFBVdGlscy5wYXJzZVJ0cE1hcChydHBtYXBsaW5lKTtcbiAgICAgIGNvbnN0IGZtdHBzID0gU0RQVXRpbHMubWF0Y2hQcmVmaXgoXG4gICAgICAgIG1lZGlhU2VjdGlvbiwgJ2E9Zm10cDonICsgcHQgKyAnICcpO1xuICAgICAgLy8gT25seSB0aGUgZmlyc3QgYT1mbXRwOjxwdD4gaXMgY29uc2lkZXJlZC5cbiAgICAgIGNvZGVjLnBhcmFtZXRlcnMgPSBmbXRwcy5sZW5ndGggPyBTRFBVdGlscy5wYXJzZUZtdHAoZm10cHNbMF0pIDoge307XG4gICAgICBjb2RlYy5ydGNwRmVlZGJhY2sgPSBTRFBVdGlscy5tYXRjaFByZWZpeChcbiAgICAgICAgbWVkaWFTZWN0aW9uLCAnYT1ydGNwLWZiOicgKyBwdCArICcgJylcbiAgICAgICAgLm1hcChTRFBVdGlscy5wYXJzZVJ0Y3BGYik7XG4gICAgICBkZXNjcmlwdGlvbi5jb2RlY3MucHVzaChjb2RlYyk7XG4gICAgICAvLyBwYXJzZSBGRUMgbWVjaGFuaXNtcyBmcm9tIHJ0cG1hcCBsaW5lcy5cbiAgICAgIHN3aXRjaCAoY29kZWMubmFtZS50b1VwcGVyQ2FzZSgpKSB7XG4gICAgICAgIGNhc2UgJ1JFRCc6XG4gICAgICAgIGNhc2UgJ1VMUEZFQyc6XG4gICAgICAgICAgZGVzY3JpcHRpb24uZmVjTWVjaGFuaXNtcy5wdXNoKGNvZGVjLm5hbWUudG9VcHBlckNhc2UoKSk7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIGRlZmF1bHQ6IC8vIG9ubHkgUkVEIGFuZCBVTFBGRUMgYXJlIHJlY29nbml6ZWQgYXMgRkVDIG1lY2hhbmlzbXMuXG4gICAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgfVxuICB9XG4gIFNEUFV0aWxzLm1hdGNoUHJlZml4KG1lZGlhU2VjdGlvbiwgJ2E9ZXh0bWFwOicpLmZvckVhY2gobGluZSA9PiB7XG4gICAgZGVzY3JpcHRpb24uaGVhZGVyRXh0ZW5zaW9ucy5wdXNoKFNEUFV0aWxzLnBhcnNlRXh0bWFwKGxpbmUpKTtcbiAgfSk7XG4gIGNvbnN0IHdpbGRjYXJkUnRjcEZiID0gU0RQVXRpbHMubWF0Y2hQcmVmaXgobWVkaWFTZWN0aW9uLCAnYT1ydGNwLWZiOiogJylcbiAgICAubWFwKFNEUFV0aWxzLnBhcnNlUnRjcEZiKTtcbiAgZGVzY3JpcHRpb24uY29kZWNzLmZvckVhY2goY29kZWMgPT4ge1xuICAgIHdpbGRjYXJkUnRjcEZiLmZvckVhY2goZmI9PiB7XG4gICAgICBjb25zdCBkdXBsaWNhdGUgPSBjb2RlYy5ydGNwRmVlZGJhY2suZmluZChleGlzdGluZ0ZlZWRiYWNrID0+IHtcbiAgICAgICAgcmV0dXJuIGV4aXN0aW5nRmVlZGJhY2sudHlwZSA9PT0gZmIudHlwZSAmJlxuICAgICAgICAgIGV4aXN0aW5nRmVlZGJhY2sucGFyYW1ldGVyID09PSBmYi5wYXJhbWV0ZXI7XG4gICAgICB9KTtcbiAgICAgIGlmICghZHVwbGljYXRlKSB7XG4gICAgICAgIGNvZGVjLnJ0Y3BGZWVkYmFjay5wdXNoKGZiKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfSk7XG4gIC8vIEZJWE1FOiBwYXJzZSBydGNwLlxuICByZXR1cm4gZGVzY3JpcHRpb247XG59O1xuXG4vLyBHZW5lcmF0ZXMgcGFydHMgb2YgdGhlIFNEUCBtZWRpYSBzZWN0aW9uIGRlc2NyaWJpbmcgdGhlIGNhcGFiaWxpdGllcyAvXG4vLyBwYXJhbWV0ZXJzLlxuU0RQVXRpbHMud3JpdGVSdHBEZXNjcmlwdGlvbiA9IGZ1bmN0aW9uKGtpbmQsIGNhcHMpIHtcbiAgbGV0IHNkcCA9ICcnO1xuXG4gIC8vIEJ1aWxkIHRoZSBtbGluZS5cbiAgc2RwICs9ICdtPScgKyBraW5kICsgJyAnO1xuICBzZHAgKz0gY2Fwcy5jb2RlY3MubGVuZ3RoID4gMCA/ICc5JyA6ICcwJzsgLy8gcmVqZWN0IGlmIG5vIGNvZGVjcy5cbiAgc2RwICs9ICcgJyArIChjYXBzLnByb2ZpbGUgfHwgJ1VEUC9UTFMvUlRQL1NBVlBGJykgKyAnICc7XG4gIHNkcCArPSBjYXBzLmNvZGVjcy5tYXAoY29kZWMgPT4ge1xuICAgIGlmIChjb2RlYy5wcmVmZXJyZWRQYXlsb2FkVHlwZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICByZXR1cm4gY29kZWMucHJlZmVycmVkUGF5bG9hZFR5cGU7XG4gICAgfVxuICAgIHJldHVybiBjb2RlYy5wYXlsb2FkVHlwZTtcbiAgfSkuam9pbignICcpICsgJ1xcclxcbic7XG5cbiAgc2RwICs9ICdjPUlOIElQNCAwLjAuMC4wXFxyXFxuJztcbiAgc2RwICs9ICdhPXJ0Y3A6OSBJTiBJUDQgMC4wLjAuMFxcclxcbic7XG5cbiAgLy8gQWRkIGE9cnRwbWFwIGxpbmVzIGZvciBlYWNoIGNvZGVjLiBBbHNvIGZtdHAgYW5kIHJ0Y3AtZmIuXG4gIGNhcHMuY29kZWNzLmZvckVhY2goY29kZWMgPT4ge1xuICAgIHNkcCArPSBTRFBVdGlscy53cml0ZVJ0cE1hcChjb2RlYyk7XG4gICAgc2RwICs9IFNEUFV0aWxzLndyaXRlRm10cChjb2RlYyk7XG4gICAgc2RwICs9IFNEUFV0aWxzLndyaXRlUnRjcEZiKGNvZGVjKTtcbiAgfSk7XG4gIGxldCBtYXhwdGltZSA9IDA7XG4gIGNhcHMuY29kZWNzLmZvckVhY2goY29kZWMgPT4ge1xuICAgIGlmIChjb2RlYy5tYXhwdGltZSA+IG1heHB0aW1lKSB7XG4gICAgICBtYXhwdGltZSA9IGNvZGVjLm1heHB0aW1lO1xuICAgIH1cbiAgfSk7XG4gIGlmIChtYXhwdGltZSA+IDApIHtcbiAgICBzZHAgKz0gJ2E9bWF4cHRpbWU6JyArIG1heHB0aW1lICsgJ1xcclxcbic7XG4gIH1cblxuICBpZiAoY2Fwcy5oZWFkZXJFeHRlbnNpb25zKSB7XG4gICAgY2Fwcy5oZWFkZXJFeHRlbnNpb25zLmZvckVhY2goZXh0ZW5zaW9uID0+IHtcbiAgICAgIHNkcCArPSBTRFBVdGlscy53cml0ZUV4dG1hcChleHRlbnNpb24pO1xuICAgIH0pO1xuICB9XG4gIC8vIEZJWE1FOiB3cml0ZSBmZWNNZWNoYW5pc21zLlxuICByZXR1cm4gc2RwO1xufTtcblxuLy8gUGFyc2VzIHRoZSBTRFAgbWVkaWEgc2VjdGlvbiBhbmQgcmV0dXJucyBhbiBhcnJheSBvZlxuLy8gUlRDUnRwRW5jb2RpbmdQYXJhbWV0ZXJzLlxuU0RQVXRpbHMucGFyc2VSdHBFbmNvZGluZ1BhcmFtZXRlcnMgPSBmdW5jdGlvbihtZWRpYVNlY3Rpb24pIHtcbiAgY29uc3QgZW5jb2RpbmdQYXJhbWV0ZXJzID0gW107XG4gIGNvbnN0IGRlc2NyaXB0aW9uID0gU0RQVXRpbHMucGFyc2VSdHBQYXJhbWV0ZXJzKG1lZGlhU2VjdGlvbik7XG4gIGNvbnN0IGhhc1JlZCA9IGRlc2NyaXB0aW9uLmZlY01lY2hhbmlzbXMuaW5kZXhPZignUkVEJykgIT09IC0xO1xuICBjb25zdCBoYXNVbHBmZWMgPSBkZXNjcmlwdGlvbi5mZWNNZWNoYW5pc21zLmluZGV4T2YoJ1VMUEZFQycpICE9PSAtMTtcblxuICAvLyBmaWx0ZXIgYT1zc3JjOi4uLiBjbmFtZTosIGlnbm9yZSBQbGFuQi1tc2lkXG4gIGNvbnN0IHNzcmNzID0gU0RQVXRpbHMubWF0Y2hQcmVmaXgobWVkaWFTZWN0aW9uLCAnYT1zc3JjOicpXG4gICAgLm1hcChsaW5lID0+IFNEUFV0aWxzLnBhcnNlU3NyY01lZGlhKGxpbmUpKVxuICAgIC5maWx0ZXIocGFydHMgPT4gcGFydHMuYXR0cmlidXRlID09PSAnY25hbWUnKTtcbiAgY29uc3QgcHJpbWFyeVNzcmMgPSBzc3Jjcy5sZW5ndGggPiAwICYmIHNzcmNzWzBdLnNzcmM7XG4gIGxldCBzZWNvbmRhcnlTc3JjO1xuXG4gIGNvbnN0IGZsb3dzID0gU0RQVXRpbHMubWF0Y2hQcmVmaXgobWVkaWFTZWN0aW9uLCAnYT1zc3JjLWdyb3VwOkZJRCcpXG4gICAgLm1hcChsaW5lID0+IHtcbiAgICAgIGNvbnN0IHBhcnRzID0gbGluZS5zdWJzdHJpbmcoMTcpLnNwbGl0KCcgJyk7XG4gICAgICByZXR1cm4gcGFydHMubWFwKHBhcnQgPT4gcGFyc2VJbnQocGFydCwgMTApKTtcbiAgICB9KTtcbiAgaWYgKGZsb3dzLmxlbmd0aCA+IDAgJiYgZmxvd3NbMF0ubGVuZ3RoID4gMSAmJiBmbG93c1swXVswXSA9PT0gcHJpbWFyeVNzcmMpIHtcbiAgICBzZWNvbmRhcnlTc3JjID0gZmxvd3NbMF1bMV07XG4gIH1cblxuICBkZXNjcmlwdGlvbi5jb2RlY3MuZm9yRWFjaChjb2RlYyA9PiB7XG4gICAgaWYgKGNvZGVjLm5hbWUudG9VcHBlckNhc2UoKSA9PT0gJ1JUWCcgJiYgY29kZWMucGFyYW1ldGVycy5hcHQpIHtcbiAgICAgIGxldCBlbmNQYXJhbSA9IHtcbiAgICAgICAgc3NyYzogcHJpbWFyeVNzcmMsXG4gICAgICAgIGNvZGVjUGF5bG9hZFR5cGU6IHBhcnNlSW50KGNvZGVjLnBhcmFtZXRlcnMuYXB0LCAxMCksXG4gICAgICB9O1xuICAgICAgaWYgKHByaW1hcnlTc3JjICYmIHNlY29uZGFyeVNzcmMpIHtcbiAgICAgICAgZW5jUGFyYW0ucnR4ID0ge3NzcmM6IHNlY29uZGFyeVNzcmN9O1xuICAgICAgfVxuICAgICAgZW5jb2RpbmdQYXJhbWV0ZXJzLnB1c2goZW5jUGFyYW0pO1xuICAgICAgaWYgKGhhc1JlZCkge1xuICAgICAgICBlbmNQYXJhbSA9IEpTT04ucGFyc2UoSlNPTi5zdHJpbmdpZnkoZW5jUGFyYW0pKTtcbiAgICAgICAgZW5jUGFyYW0uZmVjID0ge1xuICAgICAgICAgIHNzcmM6IHByaW1hcnlTc3JjLFxuICAgICAgICAgIG1lY2hhbmlzbTogaGFzVWxwZmVjID8gJ3JlZCt1bHBmZWMnIDogJ3JlZCcsXG4gICAgICAgIH07XG4gICAgICAgIGVuY29kaW5nUGFyYW1ldGVycy5wdXNoKGVuY1BhcmFtKTtcbiAgICAgIH1cbiAgICB9XG4gIH0pO1xuICBpZiAoZW5jb2RpbmdQYXJhbWV0ZXJzLmxlbmd0aCA9PT0gMCAmJiBwcmltYXJ5U3NyYykge1xuICAgIGVuY29kaW5nUGFyYW1ldGVycy5wdXNoKHtcbiAgICAgIHNzcmM6IHByaW1hcnlTc3JjLFxuICAgIH0pO1xuICB9XG5cbiAgLy8gd2Ugc3VwcG9ydCBib3RoIGI9QVMgYW5kIGI9VElBUyBidXQgaW50ZXJwcmV0IEFTIGFzIFRJQVMuXG4gIGxldCBiYW5kd2lkdGggPSBTRFBVdGlscy5tYXRjaFByZWZpeChtZWRpYVNlY3Rpb24sICdiPScpO1xuICBpZiAoYmFuZHdpZHRoLmxlbmd0aCkge1xuICAgIGlmIChiYW5kd2lkdGhbMF0uaW5kZXhPZignYj1USUFTOicpID09PSAwKSB7XG4gICAgICBiYW5kd2lkdGggPSBwYXJzZUludChiYW5kd2lkdGhbMF0uc3Vic3RyaW5nKDcpLCAxMCk7XG4gICAgfSBlbHNlIGlmIChiYW5kd2lkdGhbMF0uaW5kZXhPZignYj1BUzonKSA9PT0gMCkge1xuICAgICAgLy8gdXNlIGZvcm11bGEgZnJvbSBKU0VQIHRvIGNvbnZlcnQgYj1BUyB0byBUSUFTIHZhbHVlLlxuICAgICAgYmFuZHdpZHRoID0gcGFyc2VJbnQoYmFuZHdpZHRoWzBdLnN1YnN0cmluZyg1KSwgMTApICogMTAwMCAqIDAuOTVcbiAgICAgICAgICAtICg1MCAqIDQwICogOCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGJhbmR3aWR0aCA9IHVuZGVmaW5lZDtcbiAgICB9XG4gICAgZW5jb2RpbmdQYXJhbWV0ZXJzLmZvckVhY2gocGFyYW1zID0+IHtcbiAgICAgIHBhcmFtcy5tYXhCaXRyYXRlID0gYmFuZHdpZHRoO1xuICAgIH0pO1xuICB9XG4gIHJldHVybiBlbmNvZGluZ1BhcmFtZXRlcnM7XG59O1xuXG4vLyBwYXJzZXMgaHR0cDovL2RyYWZ0Lm9ydGMub3JnLyNydGNydGNwcGFyYW1ldGVycypcblNEUFV0aWxzLnBhcnNlUnRjcFBhcmFtZXRlcnMgPSBmdW5jdGlvbihtZWRpYVNlY3Rpb24pIHtcbiAgY29uc3QgcnRjcFBhcmFtZXRlcnMgPSB7fTtcblxuICAvLyBHZXRzIHRoZSBmaXJzdCBTU1JDLiBOb3RlIHRoYXQgd2l0aCBSVFggdGhlcmUgbWlnaHQgYmUgbXVsdGlwbGVcbiAgLy8gU1NSQ3MuXG4gIGNvbnN0IHJlbW90ZVNzcmMgPSBTRFBVdGlscy5tYXRjaFByZWZpeChtZWRpYVNlY3Rpb24sICdhPXNzcmM6JylcbiAgICAubWFwKGxpbmUgPT4gU0RQVXRpbHMucGFyc2VTc3JjTWVkaWEobGluZSkpXG4gICAgLmZpbHRlcihvYmogPT4gb2JqLmF0dHJpYnV0ZSA9PT0gJ2NuYW1lJylbMF07XG4gIGlmIChyZW1vdGVTc3JjKSB7XG4gICAgcnRjcFBhcmFtZXRlcnMuY25hbWUgPSByZW1vdGVTc3JjLnZhbHVlO1xuICAgIHJ0Y3BQYXJhbWV0ZXJzLnNzcmMgPSByZW1vdGVTc3JjLnNzcmM7XG4gIH1cblxuICAvLyBFZGdlIHVzZXMgdGhlIGNvbXBvdW5kIGF0dHJpYnV0ZSBpbnN0ZWFkIG9mIHJlZHVjZWRTaXplXG4gIC8vIGNvbXBvdW5kIGlzICFyZWR1Y2VkU2l6ZVxuICBjb25zdCByc2l6ZSA9IFNEUFV0aWxzLm1hdGNoUHJlZml4KG1lZGlhU2VjdGlvbiwgJ2E9cnRjcC1yc2l6ZScpO1xuICBydGNwUGFyYW1ldGVycy5yZWR1Y2VkU2l6ZSA9IHJzaXplLmxlbmd0aCA+IDA7XG4gIHJ0Y3BQYXJhbWV0ZXJzLmNvbXBvdW5kID0gcnNpemUubGVuZ3RoID09PSAwO1xuXG4gIC8vIHBhcnNlcyB0aGUgcnRjcC1tdXggYXR0ctGWYnV0ZS5cbiAgLy8gTm90ZSB0aGF0IEVkZ2UgZG9lcyBub3Qgc3VwcG9ydCB1bm11eGVkIFJUQ1AuXG4gIGNvbnN0IG11eCA9IFNEUFV0aWxzLm1hdGNoUHJlZml4KG1lZGlhU2VjdGlvbiwgJ2E9cnRjcC1tdXgnKTtcbiAgcnRjcFBhcmFtZXRlcnMubXV4ID0gbXV4Lmxlbmd0aCA+IDA7XG5cbiAgcmV0dXJuIHJ0Y3BQYXJhbWV0ZXJzO1xufTtcblxuU0RQVXRpbHMud3JpdGVSdGNwUGFyYW1ldGVycyA9IGZ1bmN0aW9uKHJ0Y3BQYXJhbWV0ZXJzKSB7XG4gIGxldCBzZHAgPSAnJztcbiAgaWYgKHJ0Y3BQYXJhbWV0ZXJzLnJlZHVjZWRTaXplKSB7XG4gICAgc2RwICs9ICdhPXJ0Y3AtcnNpemVcXHJcXG4nO1xuICB9XG4gIGlmIChydGNwUGFyYW1ldGVycy5tdXgpIHtcbiAgICBzZHAgKz0gJ2E9cnRjcC1tdXhcXHJcXG4nO1xuICB9XG4gIGlmIChydGNwUGFyYW1ldGVycy5zc3JjICE9PSB1bmRlZmluZWQgJiYgcnRjcFBhcmFtZXRlcnMuY25hbWUpIHtcbiAgICBzZHAgKz0gJ2E9c3NyYzonICsgcnRjcFBhcmFtZXRlcnMuc3NyYyArXG4gICAgICAnIGNuYW1lOicgKyBydGNwUGFyYW1ldGVycy5jbmFtZSArICdcXHJcXG4nO1xuICB9XG4gIHJldHVybiBzZHA7XG59O1xuXG5cbi8vIHBhcnNlcyBlaXRoZXIgYT1tc2lkOiBvciBhPXNzcmM6Li4uIG1zaWQgbGluZXMgYW5kIHJldHVybnNcbi8vIHRoZSBpZCBvZiB0aGUgTWVkaWFTdHJlYW0gYW5kIE1lZGlhU3RyZWFtVHJhY2suXG5TRFBVdGlscy5wYXJzZU1zaWQgPSBmdW5jdGlvbihtZWRpYVNlY3Rpb24pIHtcbiAgbGV0IHBhcnRzO1xuICBjb25zdCBzcGVjID0gU0RQVXRpbHMubWF0Y2hQcmVmaXgobWVkaWFTZWN0aW9uLCAnYT1tc2lkOicpO1xuICBpZiAoc3BlYy5sZW5ndGggPT09IDEpIHtcbiAgICBwYXJ0cyA9IHNwZWNbMF0uc3Vic3RyaW5nKDcpLnNwbGl0KCcgJyk7XG4gICAgcmV0dXJuIHtzdHJlYW06IHBhcnRzWzBdLCB0cmFjazogcGFydHNbMV19O1xuICB9XG4gIGNvbnN0IHBsYW5CID0gU0RQVXRpbHMubWF0Y2hQcmVmaXgobWVkaWFTZWN0aW9uLCAnYT1zc3JjOicpXG4gICAgLm1hcChsaW5lID0+IFNEUFV0aWxzLnBhcnNlU3NyY01lZGlhKGxpbmUpKVxuICAgIC5maWx0ZXIobXNpZFBhcnRzID0+IG1zaWRQYXJ0cy5hdHRyaWJ1dGUgPT09ICdtc2lkJyk7XG4gIGlmIChwbGFuQi5sZW5ndGggPiAwKSB7XG4gICAgcGFydHMgPSBwbGFuQlswXS52YWx1ZS5zcGxpdCgnICcpO1xuICAgIHJldHVybiB7c3RyZWFtOiBwYXJ0c1swXSwgdHJhY2s6IHBhcnRzWzFdfTtcbiAgfVxufTtcblxuLy8gU0NUUFxuLy8gcGFyc2VzIGRyYWZ0LWlldGYtbW11c2ljLXNjdHAtc2RwLTI2IGZpcnN0IGFuZCBmYWxscyBiYWNrXG4vLyB0byBkcmFmdC1pZXRmLW1tdXNpYy1zY3RwLXNkcC0wNVxuU0RQVXRpbHMucGFyc2VTY3RwRGVzY3JpcHRpb24gPSBmdW5jdGlvbihtZWRpYVNlY3Rpb24pIHtcbiAgY29uc3QgbWxpbmUgPSBTRFBVdGlscy5wYXJzZU1MaW5lKG1lZGlhU2VjdGlvbik7XG4gIGNvbnN0IG1heFNpemVMaW5lID0gU0RQVXRpbHMubWF0Y2hQcmVmaXgobWVkaWFTZWN0aW9uLCAnYT1tYXgtbWVzc2FnZS1zaXplOicpO1xuICBsZXQgbWF4TWVzc2FnZVNpemU7XG4gIGlmIChtYXhTaXplTGluZS5sZW5ndGggPiAwKSB7XG4gICAgbWF4TWVzc2FnZVNpemUgPSBwYXJzZUludChtYXhTaXplTGluZVswXS5zdWJzdHJpbmcoMTkpLCAxMCk7XG4gIH1cbiAgaWYgKGlzTmFOKG1heE1lc3NhZ2VTaXplKSkge1xuICAgIG1heE1lc3NhZ2VTaXplID0gNjU1MzY7XG4gIH1cbiAgY29uc3Qgc2N0cFBvcnQgPSBTRFBVdGlscy5tYXRjaFByZWZpeChtZWRpYVNlY3Rpb24sICdhPXNjdHAtcG9ydDonKTtcbiAgaWYgKHNjdHBQb3J0Lmxlbmd0aCA+IDApIHtcbiAgICByZXR1cm4ge1xuICAgICAgcG9ydDogcGFyc2VJbnQoc2N0cFBvcnRbMF0uc3Vic3RyaW5nKDEyKSwgMTApLFxuICAgICAgcHJvdG9jb2w6IG1saW5lLmZtdCxcbiAgICAgIG1heE1lc3NhZ2VTaXplLFxuICAgIH07XG4gIH1cbiAgY29uc3Qgc2N0cE1hcExpbmVzID0gU0RQVXRpbHMubWF0Y2hQcmVmaXgobWVkaWFTZWN0aW9uLCAnYT1zY3RwbWFwOicpO1xuICBpZiAoc2N0cE1hcExpbmVzLmxlbmd0aCA+IDApIHtcbiAgICBjb25zdCBwYXJ0cyA9IHNjdHBNYXBMaW5lc1swXVxuICAgICAgLnN1YnN0cmluZygxMClcbiAgICAgIC5zcGxpdCgnICcpO1xuICAgIHJldHVybiB7XG4gICAgICBwb3J0OiBwYXJzZUludChwYXJ0c1swXSwgMTApLFxuICAgICAgcHJvdG9jb2w6IHBhcnRzWzFdLFxuICAgICAgbWF4TWVzc2FnZVNpemUsXG4gICAgfTtcbiAgfVxufTtcblxuLy8gU0NUUFxuLy8gb3V0cHV0cyB0aGUgZHJhZnQtaWV0Zi1tbXVzaWMtc2N0cC1zZHAtMjYgdmVyc2lvbiB0aGF0IGFsbCBicm93c2Vyc1xuLy8gc3VwcG9ydCBieSBub3cgcmVjZWl2aW5nIGluIHRoaXMgZm9ybWF0LCB1bmxlc3Mgd2Ugb3JpZ2luYWxseSBwYXJzZWRcbi8vIGFzIHRoZSBkcmFmdC1pZXRmLW1tdXNpYy1zY3RwLXNkcC0wNSBmb3JtYXQgKGluZGljYXRlZCBieSB0aGUgbS1saW5lXG4vLyBwcm90b2NvbCBvZiBEVExTL1NDVFAgLS0gd2l0aG91dCBVRFAvIG9yIFRDUC8pXG5TRFBVdGlscy53cml0ZVNjdHBEZXNjcmlwdGlvbiA9IGZ1bmN0aW9uKG1lZGlhLCBzY3RwKSB7XG4gIGxldCBvdXRwdXQgPSBbXTtcbiAgaWYgKG1lZGlhLnByb3RvY29sICE9PSAnRFRMUy9TQ1RQJykge1xuICAgIG91dHB1dCA9IFtcbiAgICAgICdtPScgKyBtZWRpYS5raW5kICsgJyA5ICcgKyBtZWRpYS5wcm90b2NvbCArICcgJyArIHNjdHAucHJvdG9jb2wgKyAnXFxyXFxuJyxcbiAgICAgICdjPUlOIElQNCAwLjAuMC4wXFxyXFxuJyxcbiAgICAgICdhPXNjdHAtcG9ydDonICsgc2N0cC5wb3J0ICsgJ1xcclxcbicsXG4gICAgXTtcbiAgfSBlbHNlIHtcbiAgICBvdXRwdXQgPSBbXG4gICAgICAnbT0nICsgbWVkaWEua2luZCArICcgOSAnICsgbWVkaWEucHJvdG9jb2wgKyAnICcgKyBzY3RwLnBvcnQgKyAnXFxyXFxuJyxcbiAgICAgICdjPUlOIElQNCAwLjAuMC4wXFxyXFxuJyxcbiAgICAgICdhPXNjdHBtYXA6JyArIHNjdHAucG9ydCArICcgJyArIHNjdHAucHJvdG9jb2wgKyAnIDY1NTM1XFxyXFxuJyxcbiAgICBdO1xuICB9XG4gIGlmIChzY3RwLm1heE1lc3NhZ2VTaXplICE9PSB1bmRlZmluZWQpIHtcbiAgICBvdXRwdXQucHVzaCgnYT1tYXgtbWVzc2FnZS1zaXplOicgKyBzY3RwLm1heE1lc3NhZ2VTaXplICsgJ1xcclxcbicpO1xuICB9XG4gIHJldHVybiBvdXRwdXQuam9pbignJyk7XG59O1xuXG4vLyBHZW5lcmF0ZSBhIHNlc3Npb24gSUQgZm9yIFNEUC5cbi8vIGh0dHBzOi8vdG9vbHMuaWV0Zi5vcmcvaHRtbC9kcmFmdC1pZXRmLXJ0Y3dlYi1qc2VwLTIwI3NlY3Rpb24tNS4yLjFcbi8vIHJlY29tbWVuZHMgdXNpbmcgYSBjcnlwdG9ncmFwaGljYWxseSByYW5kb20gK3ZlIDY0LWJpdCB2YWx1ZVxuLy8gYnV0IHJpZ2h0IG5vdyB0aGlzIHNob3VsZCBiZSBhY2NlcHRhYmxlIGFuZCB3aXRoaW4gdGhlIHJpZ2h0IHJhbmdlXG5TRFBVdGlscy5nZW5lcmF0ZVNlc3Npb25JZCA9IGZ1bmN0aW9uKCkge1xuICByZXR1cm4gTWF0aC5yYW5kb20oKS50b1N0cmluZygpLnN1YnN0cigyLCAyMik7XG59O1xuXG4vLyBXcml0ZSBib2lsZXIgcGxhdGUgZm9yIHN0YXJ0IG9mIFNEUFxuLy8gc2Vzc0lkIGFyZ3VtZW50IGlzIG9wdGlvbmFsIC0gaWYgbm90IHN1cHBsaWVkIGl0IHdpbGxcbi8vIGJlIGdlbmVyYXRlZCByYW5kb21seVxuLy8gc2Vzc1ZlcnNpb24gaXMgb3B0aW9uYWwgYW5kIGRlZmF1bHRzIHRvIDJcbi8vIHNlc3NVc2VyIGlzIG9wdGlvbmFsIGFuZCBkZWZhdWx0cyB0byAndGhpc2lzYWRhcHRlcm9ydGMnXG5TRFBVdGlscy53cml0ZVNlc3Npb25Cb2lsZXJwbGF0ZSA9IGZ1bmN0aW9uKHNlc3NJZCwgc2Vzc1Zlciwgc2Vzc1VzZXIpIHtcbiAgbGV0IHNlc3Npb25JZDtcbiAgY29uc3QgdmVyc2lvbiA9IHNlc3NWZXIgIT09IHVuZGVmaW5lZCA/IHNlc3NWZXIgOiAyO1xuICBpZiAoc2Vzc0lkKSB7XG4gICAgc2Vzc2lvbklkID0gc2Vzc0lkO1xuICB9IGVsc2Uge1xuICAgIHNlc3Npb25JZCA9IFNEUFV0aWxzLmdlbmVyYXRlU2Vzc2lvbklkKCk7XG4gIH1cbiAgY29uc3QgdXNlciA9IHNlc3NVc2VyIHx8ICd0aGlzaXNhZGFwdGVyb3J0Yyc7XG4gIC8vIEZJWE1FOiBzZXNzLWlkIHNob3VsZCBiZSBhbiBOVFAgdGltZXN0YW1wLlxuICByZXR1cm4gJ3Y9MFxcclxcbicgK1xuICAgICAgJ289JyArIHVzZXIgKyAnICcgKyBzZXNzaW9uSWQgKyAnICcgKyB2ZXJzaW9uICtcbiAgICAgICAgJyBJTiBJUDQgMTI3LjAuMC4xXFxyXFxuJyArXG4gICAgICAncz0tXFxyXFxuJyArXG4gICAgICAndD0wIDBcXHJcXG4nO1xufTtcblxuLy8gR2V0cyB0aGUgZGlyZWN0aW9uIGZyb20gdGhlIG1lZGlhU2VjdGlvbiBvciB0aGUgc2Vzc2lvbnBhcnQuXG5TRFBVdGlscy5nZXREaXJlY3Rpb24gPSBmdW5jdGlvbihtZWRpYVNlY3Rpb24sIHNlc3Npb25wYXJ0KSB7XG4gIC8vIExvb2sgZm9yIHNlbmRyZWN2LCBzZW5kb25seSwgcmVjdm9ubHksIGluYWN0aXZlLCBkZWZhdWx0IHRvIHNlbmRyZWN2LlxuICBjb25zdCBsaW5lcyA9IFNEUFV0aWxzLnNwbGl0TGluZXMobWVkaWFTZWN0aW9uKTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBsaW5lcy5sZW5ndGg7IGkrKykge1xuICAgIHN3aXRjaCAobGluZXNbaV0pIHtcbiAgICAgIGNhc2UgJ2E9c2VuZHJlY3YnOlxuICAgICAgY2FzZSAnYT1zZW5kb25seSc6XG4gICAgICBjYXNlICdhPXJlY3Zvbmx5JzpcbiAgICAgIGNhc2UgJ2E9aW5hY3RpdmUnOlxuICAgICAgICByZXR1cm4gbGluZXNbaV0uc3Vic3RyaW5nKDIpO1xuICAgICAgZGVmYXVsdDpcbiAgICAgICAgLy8gRklYTUU6IFdoYXQgc2hvdWxkIGhhcHBlbiBoZXJlP1xuICAgIH1cbiAgfVxuICBpZiAoc2Vzc2lvbnBhcnQpIHtcbiAgICByZXR1cm4gU0RQVXRpbHMuZ2V0RGlyZWN0aW9uKHNlc3Npb25wYXJ0KTtcbiAgfVxuICByZXR1cm4gJ3NlbmRyZWN2Jztcbn07XG5cblNEUFV0aWxzLmdldEtpbmQgPSBmdW5jdGlvbihtZWRpYVNlY3Rpb24pIHtcbiAgY29uc3QgbGluZXMgPSBTRFBVdGlscy5zcGxpdExpbmVzKG1lZGlhU2VjdGlvbik7XG4gIGNvbnN0IG1saW5lID0gbGluZXNbMF0uc3BsaXQoJyAnKTtcbiAgcmV0dXJuIG1saW5lWzBdLnN1YnN0cmluZygyKTtcbn07XG5cblNEUFV0aWxzLmlzUmVqZWN0ZWQgPSBmdW5jdGlvbihtZWRpYVNlY3Rpb24pIHtcbiAgcmV0dXJuIG1lZGlhU2VjdGlvbi5zcGxpdCgnICcsIDIpWzFdID09PSAnMCc7XG59O1xuXG5TRFBVdGlscy5wYXJzZU1MaW5lID0gZnVuY3Rpb24obWVkaWFTZWN0aW9uKSB7XG4gIGNvbnN0IGxpbmVzID0gU0RQVXRpbHMuc3BsaXRMaW5lcyhtZWRpYVNlY3Rpb24pO1xuICBjb25zdCBwYXJ0cyA9IGxpbmVzWzBdLnN1YnN0cmluZygyKS5zcGxpdCgnICcpO1xuICByZXR1cm4ge1xuICAgIGtpbmQ6IHBhcnRzWzBdLFxuICAgIHBvcnQ6IHBhcnNlSW50KHBhcnRzWzFdLCAxMCksXG4gICAgcHJvdG9jb2w6IHBhcnRzWzJdLFxuICAgIGZtdDogcGFydHMuc2xpY2UoMykuam9pbignICcpLFxuICB9O1xufTtcblxuU0RQVXRpbHMucGFyc2VPTGluZSA9IGZ1bmN0aW9uKG1lZGlhU2VjdGlvbikge1xuICBjb25zdCBsaW5lID0gU0RQVXRpbHMubWF0Y2hQcmVmaXgobWVkaWFTZWN0aW9uLCAnbz0nKVswXTtcbiAgY29uc3QgcGFydHMgPSBsaW5lLnN1YnN0cmluZygyKS5zcGxpdCgnICcpO1xuICByZXR1cm4ge1xuICAgIHVzZXJuYW1lOiBwYXJ0c1swXSxcbiAgICBzZXNzaW9uSWQ6IHBhcnRzWzFdLFxuICAgIHNlc3Npb25WZXJzaW9uOiBwYXJzZUludChwYXJ0c1syXSwgMTApLFxuICAgIG5ldFR5cGU6IHBhcnRzWzNdLFxuICAgIGFkZHJlc3NUeXBlOiBwYXJ0c1s0XSxcbiAgICBhZGRyZXNzOiBwYXJ0c1s1XSxcbiAgfTtcbn07XG5cbi8vIGEgdmVyeSBuYWl2ZSBpbnRlcnByZXRhdGlvbiBvZiBhIHZhbGlkIFNEUC5cblNEUFV0aWxzLmlzVmFsaWRTRFAgPSBmdW5jdGlvbihibG9iKSB7XG4gIGlmICh0eXBlb2YgYmxvYiAhPT0gJ3N0cmluZycgfHwgYmxvYi5sZW5ndGggPT09IDApIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbiAgY29uc3QgbGluZXMgPSBTRFBVdGlscy5zcGxpdExpbmVzKGJsb2IpO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IGxpbmVzLmxlbmd0aDsgaSsrKSB7XG4gICAgaWYgKGxpbmVzW2ldLmxlbmd0aCA8IDIgfHwgbGluZXNbaV0uY2hhckF0KDEpICE9PSAnPScpIHtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gICAgLy8gVE9ETzogY2hlY2sgdGhlIG1vZGlmaWVyIGEgYml0IG1vcmUuXG4gIH1cbiAgcmV0dXJuIHRydWU7XG59O1xuXG4vLyBFeHBvc2UgcHVibGljIG1ldGhvZHMuXG5pZiAodHlwZW9mIG1vZHVsZSA9PT0gJ29iamVjdCcpIHtcbiAgbW9kdWxlLmV4cG9ydHMgPSBTRFBVdGlscztcbn1cbiIsIi8vIFRoZSBtb2R1bGUgY2FjaGVcbnZhciBfX3dlYnBhY2tfbW9kdWxlX2NhY2hlX18gPSB7fTtcblxuLy8gVGhlIHJlcXVpcmUgZnVuY3Rpb25cbmZ1bmN0aW9uIF9fd2VicGFja19yZXF1aXJlX18obW9kdWxlSWQpIHtcblx0Ly8gQ2hlY2sgaWYgbW9kdWxlIGlzIGluIGNhY2hlXG5cdHZhciBjYWNoZWRNb2R1bGUgPSBfX3dlYnBhY2tfbW9kdWxlX2NhY2hlX19bbW9kdWxlSWRdO1xuXHRpZiAoY2FjaGVkTW9kdWxlICE9PSB1bmRlZmluZWQpIHtcblx0XHRyZXR1cm4gY2FjaGVkTW9kdWxlLmV4cG9ydHM7XG5cdH1cblx0Ly8gQ3JlYXRlIGEgbmV3IG1vZHVsZSAoYW5kIHB1dCBpdCBpbnRvIHRoZSBjYWNoZSlcblx0dmFyIG1vZHVsZSA9IF9fd2VicGFja19tb2R1bGVfY2FjaGVfX1ttb2R1bGVJZF0gPSB7XG5cdFx0Ly8gbm8gbW9kdWxlLmlkIG5lZWRlZFxuXHRcdC8vIG5vIG1vZHVsZS5sb2FkZWQgbmVlZGVkXG5cdFx0ZXhwb3J0czoge31cblx0fTtcblxuXHQvLyBFeGVjdXRlIHRoZSBtb2R1bGUgZnVuY3Rpb25cblx0X193ZWJwYWNrX21vZHVsZXNfX1ttb2R1bGVJZF0obW9kdWxlLCBtb2R1bGUuZXhwb3J0cywgX193ZWJwYWNrX3JlcXVpcmVfXyk7XG5cblx0Ly8gUmV0dXJuIHRoZSBleHBvcnRzIG9mIHRoZSBtb2R1bGVcblx0cmV0dXJuIG1vZHVsZS5leHBvcnRzO1xufVxuXG4iLCIiLCIvLyBzdGFydHVwXG4vLyBMb2FkIGVudHJ5IG1vZHVsZSBhbmQgcmV0dXJuIGV4cG9ydHNcbi8vIFRoaXMgZW50cnkgbW9kdWxlIGlzIHJlZmVyZW5jZWQgYnkgb3RoZXIgbW9kdWxlcyBzbyBpdCBjYW4ndCBiZSBpbmxpbmVkXG52YXIgX193ZWJwYWNrX2V4cG9ydHNfXyA9IF9fd2VicGFja19yZXF1aXJlX18oXCIuL3NyYy9pbmRleC5qc1wiKTtcbiIsIiJdLCJuYW1lcyI6WyJtaiIsInJlcXVpcmUiLCJKYW51c1Nlc3Npb24iLCJwcm90b3R5cGUiLCJzZW5kT3JpZ2luYWwiLCJzZW5kIiwidHlwZSIsInNpZ25hbCIsImNhdGNoIiwiZSIsIm1lc3NhZ2UiLCJpbmRleE9mIiwiY29uc29sZSIsImVycm9yIiwiTkFGIiwiY29ubmVjdGlvbiIsImFkYXB0ZXIiLCJyZWNvbm5lY3QiLCJzZHBVdGlscyIsImRlYnVnIiwibG9nIiwid2FybiIsImlzU2FmYXJpIiwidGVzdCIsIm5hdmlnYXRvciIsInVzZXJBZ2VudCIsImRlYm91bmNlIiwiZm4iLCJjdXJyIiwiUHJvbWlzZSIsInJlc29sdmUiLCJhcmdzIiwiQXJyYXkiLCJzbGljZSIsImNhbGwiLCJhcmd1bWVudHMiLCJ0aGVuIiwiXyIsImFwcGx5IiwicmFuZG9tVWludCIsIk1hdGgiLCJmbG9vciIsInJhbmRvbSIsIk51bWJlciIsIk1BWF9TQUZFX0lOVEVHRVIiLCJ1bnRpbERhdGFDaGFubmVsT3BlbiIsImRhdGFDaGFubmVsIiwicmVqZWN0IiwicmVhZHlTdGF0ZSIsInJlc29sdmVyIiwicmVqZWN0b3IiLCJjbGVhciIsInJlbW92ZUV2ZW50TGlzdGVuZXIiLCJhZGRFdmVudExpc3RlbmVyIiwiaXNIMjY0VmlkZW9TdXBwb3J0ZWQiLCJ2aWRlbyIsImRvY3VtZW50IiwiY3JlYXRlRWxlbWVudCIsImNhblBsYXlUeXBlIiwiT1BVU19QQVJBTUVURVJTIiwidXNlZHR4Iiwic3RlcmVvIiwiREVGQVVMVF9QRUVSX0NPTk5FQ1RJT05fQ09ORklHIiwiaWNlU2VydmVycyIsInVybHMiLCJXU19OT1JNQUxfQ0xPU1VSRSIsIkphbnVzQWRhcHRlciIsImNvbnN0cnVjdG9yIiwicm9vbSIsImNsaWVudElkIiwiam9pblRva2VuIiwic2VydmVyVXJsIiwid2ViUnRjT3B0aW9ucyIsInBlZXJDb25uZWN0aW9uQ29uZmlnIiwid3MiLCJzZXNzaW9uIiwicmVsaWFibGVUcmFuc3BvcnQiLCJ1bnJlbGlhYmxlVHJhbnNwb3J0IiwiaW5pdGlhbFJlY29ubmVjdGlvbkRlbGF5IiwicmVjb25uZWN0aW9uRGVsYXkiLCJyZWNvbm5lY3Rpb25UaW1lb3V0IiwibWF4UmVjb25uZWN0aW9uQXR0ZW1wdHMiLCJyZWNvbm5lY3Rpb25BdHRlbXB0cyIsInB1Ymxpc2hlciIsIm9jY3VwYW50cyIsImxlZnRPY2N1cGFudHMiLCJTZXQiLCJtZWRpYVN0cmVhbXMiLCJsb2NhbE1lZGlhU3RyZWFtIiwicGVuZGluZ01lZGlhUmVxdWVzdHMiLCJNYXAiLCJibG9ja2VkQ2xpZW50cyIsImZyb3plblVwZGF0ZXMiLCJ0aW1lT2Zmc2V0cyIsInNlcnZlclRpbWVSZXF1ZXN0cyIsImF2Z1RpbWVPZmZzZXQiLCJvbldlYnNvY2tldE9wZW4iLCJiaW5kIiwib25XZWJzb2NrZXRDbG9zZSIsIm9uV2Vic29ja2V0TWVzc2FnZSIsIm9uRGF0YUNoYW5uZWxNZXNzYWdlIiwib25EYXRhIiwic2V0U2VydmVyVXJsIiwidXJsIiwic2V0QXBwIiwiYXBwIiwic2V0Um9vbSIsInJvb21OYW1lIiwic2V0Sm9pblRva2VuIiwic2V0Q2xpZW50SWQiLCJzZXRXZWJSdGNPcHRpb25zIiwib3B0aW9ucyIsInNldFBlZXJDb25uZWN0aW9uQ29uZmlnIiwic2V0U2VydmVyQ29ubmVjdExpc3RlbmVycyIsInN1Y2Nlc3NMaXN0ZW5lciIsImZhaWx1cmVMaXN0ZW5lciIsImNvbm5lY3RTdWNjZXNzIiwiY29ubmVjdEZhaWx1cmUiLCJzZXRSb29tT2NjdXBhbnRMaXN0ZW5lciIsIm9jY3VwYW50TGlzdGVuZXIiLCJvbk9jY3VwYW50c0NoYW5nZWQiLCJwdXNoIiwic2V0RGF0YUNoYW5uZWxMaXN0ZW5lcnMiLCJvcGVuTGlzdGVuZXIiLCJjbG9zZWRMaXN0ZW5lciIsIm1lc3NhZ2VMaXN0ZW5lciIsIm9uT2NjdXBhbnRDb25uZWN0ZWQiLCJvbk9jY3VwYW50RGlzY29ubmVjdGVkIiwib25PY2N1cGFudE1lc3NhZ2UiLCJzZXRSZWNvbm5lY3Rpb25MaXN0ZW5lcnMiLCJyZWNvbm5lY3RpbmdMaXN0ZW5lciIsInJlY29ubmVjdGVkTGlzdGVuZXIiLCJyZWNvbm5lY3Rpb25FcnJvckxpc3RlbmVyIiwib25SZWNvbm5lY3RpbmciLCJvblJlY29ubmVjdGVkIiwib25SZWNvbm5lY3Rpb25FcnJvciIsInNldEV2ZW50TG9vcHMiLCJsb29wcyIsImNvbm5lY3QiLCJ3ZWJzb2NrZXRDb25uZWN0aW9uIiwiV2ViU29ja2V0IiwidGltZW91dE1zIiwid3NPbk9wZW4iLCJhbGwiLCJ1cGRhdGVUaW1lT2Zmc2V0IiwiZGlzY29ubmVjdCIsImNsZWFyVGltZW91dCIsInJlbW92ZUFsbE9jY3VwYW50cyIsImNvbm4iLCJjbG9zZSIsImRpc3Bvc2UiLCJkZWxheWVkUmVjb25uZWN0VGltZW91dCIsImlzRGlzY29ubmVjdGVkIiwiY3JlYXRlIiwiY3JlYXRlUHVibGlzaGVyIiwiaSIsImluaXRpYWxPY2N1cGFudHMiLCJsZW5ndGgiLCJvY2N1cGFudElkIiwiYWRkT2NjdXBhbnQiLCJldmVudCIsImNvZGUiLCJzZXRUaW1lb3V0IiwiRXJyb3IiLCJwZXJmb3JtRGVsYXllZFJlY29ubmVjdCIsInJlY2VpdmUiLCJKU09OIiwicGFyc2UiLCJkYXRhIiwicmVtb3ZlT2NjdXBhbnQiLCJkZWxldGUiLCJzdWJzY3JpYmVyIiwiY3JlYXRlU3Vic2NyaWJlciIsInNldE1lZGlhU3RyZWFtIiwibWVkaWFTdHJlYW0iLCJmb3JFYWNoIiwibGlzdGVuZXIiLCJPYmplY3QiLCJnZXRPd25Qcm9wZXJ0eU5hbWVzIiwiYWRkIiwiaGFzIiwibXNnIiwiZ2V0IiwiYXVkaW8iLCJhc3NvY2lhdGUiLCJoYW5kbGUiLCJldiIsInNlbmRUcmlja2xlIiwiY2FuZGlkYXRlIiwiaWNlQ29ubmVjdGlvblN0YXRlIiwib2ZmZXIiLCJjcmVhdGVPZmZlciIsImNvbmZpZ3VyZVB1Ymxpc2hlclNkcCIsImZpeFNhZmFyaUljZVVGcmFnIiwibG9jYWwiLCJvIiwic2V0TG9jYWxEZXNjcmlwdGlvbiIsInJlbW90ZSIsImoiLCJzZW5kSnNlcCIsInIiLCJzZXRSZW1vdGVEZXNjcmlwdGlvbiIsImpzZXAiLCJvbiIsImFuc3dlciIsImNvbmZpZ3VyZVN1YnNjcmliZXJTZHAiLCJjcmVhdGVBbnN3ZXIiLCJhIiwiSmFudXNQbHVnaW5IYW5kbGUiLCJSVENQZWVyQ29ubmVjdGlvbiIsImF0dGFjaCIsInBhcnNlSW50IiwidW5kZWZpbmVkIiwid2VicnRjdXAiLCJyZWxpYWJsZUNoYW5uZWwiLCJjcmVhdGVEYXRhQ2hhbm5lbCIsIm9yZGVyZWQiLCJ1bnJlbGlhYmxlQ2hhbm5lbCIsIm1heFJldHJhbnNtaXRzIiwiZ2V0VHJhY2tzIiwidHJhY2siLCJhZGRUcmFjayIsInBsdWdpbmRhdGEiLCJyb29tX2lkIiwidXNlcl9pZCIsImJvZHkiLCJkaXNwYXRjaEV2ZW50IiwiQ3VzdG9tRXZlbnQiLCJkZXRhaWwiLCJieSIsInNlbmRKb2luIiwibm90aWZpY2F0aW9ucyIsInN1Y2Nlc3MiLCJlcnIiLCJyZXNwb25zZSIsInVzZXJzIiwiaW5jbHVkZXMiLCJzZHAiLCJyZXBsYWNlIiwibGluZSIsInB0IiwicGFyYW1ldGVycyIsImFzc2lnbiIsInBhcnNlRm10cCIsIndyaXRlRm10cCIsInBheWxvYWRUeXBlIiwibWF4UmV0cmllcyIsIm1lZGlhIiwiaW50ZXJ2YWwiLCJzZXRJbnRlcnZhbCIsImNsZWFySW50ZXJ2YWwiLCJfaU9TSGFja0RlbGF5ZWRJbml0aWFsUGVlciIsIk1lZGlhU3RyZWFtIiwicmVjZWl2ZXJzIiwiZ2V0UmVjZWl2ZXJzIiwicmVjZWl2ZXIiLCJzdWJzY3JpYmUiLCJzZW5kTWVzc2FnZSIsImtpbmQiLCJ0b2tlbiIsInRvZ2dsZUZyZWV6ZSIsImZyb3plbiIsInVuZnJlZXplIiwiZnJlZXplIiwiZmx1c2hQZW5kaW5nVXBkYXRlcyIsImRhdGFGb3JVcGRhdGVNdWx0aU1lc3NhZ2UiLCJuZXR3b3JrSWQiLCJsIiwiZCIsImdldFBlbmRpbmdEYXRhIiwiZGF0YVR5cGUiLCJvd25lciIsImdldFBlbmRpbmdEYXRhRm9yTmV0d29ya0lkIiwic291cmNlIiwic3RvcmVNZXNzYWdlIiwic3RvcmVTaW5nbGVNZXNzYWdlIiwiaW5kZXgiLCJzZXQiLCJzdG9yZWRNZXNzYWdlIiwic3RvcmVkRGF0YSIsImlzT3V0ZGF0ZWRNZXNzYWdlIiwibGFzdE93bmVyVGltZSIsImlzQ29udGVtcG9yYW5lb3VzTWVzc2FnZSIsImNyZWF0ZWRXaGlsZUZyb3plbiIsImlzRmlyc3RTeW5jIiwiY29tcG9uZW50cyIsImVuYWJsZWQiLCJzaG91bGRTdGFydENvbm5lY3Rpb25UbyIsImNsaWVudCIsInN0YXJ0U3RyZWFtQ29ubmVjdGlvbiIsImNsb3NlU3RyZWFtQ29ubmVjdGlvbiIsImdldENvbm5lY3RTdGF0dXMiLCJhZGFwdGVycyIsIklTX0NPTk5FQ1RFRCIsIk5PVF9DT05ORUNURUQiLCJjbGllbnRTZW50VGltZSIsIkRhdGUiLCJub3ciLCJyZXMiLCJmZXRjaCIsImxvY2F0aW9uIiwiaHJlZiIsIm1ldGhvZCIsImNhY2hlIiwicHJlY2lzaW9uIiwic2VydmVyUmVjZWl2ZWRUaW1lIiwiaGVhZGVycyIsImdldFRpbWUiLCJjbGllbnRSZWNlaXZlZFRpbWUiLCJzZXJ2ZXJUaW1lIiwidGltZU9mZnNldCIsInJlZHVjZSIsImFjYyIsIm9mZnNldCIsImdldFNlcnZlclRpbWUiLCJnZXRNZWRpYVN0cmVhbSIsImF1ZGlvUHJvbWlzZSIsInZpZGVvUHJvbWlzZSIsInByb21pc2UiLCJzdHJlYW0iLCJhdWRpb1N0cmVhbSIsImdldEF1ZGlvVHJhY2tzIiwidmlkZW9TdHJlYW0iLCJnZXRWaWRlb1RyYWNrcyIsImdldExvY2FsTWVkaWFTdHJlYW0iLCJzZXRMb2NhbE1lZGlhU3RyZWFtIiwiZXhpc3RpbmdTZW5kZXJzIiwiZ2V0U2VuZGVycyIsIm5ld1NlbmRlcnMiLCJ0cmFja3MiLCJ0Iiwic2VuZGVyIiwiZmluZCIsInMiLCJyZXBsYWNlVHJhY2siLCJyZW1vdmVUcmFjayIsImVuYWJsZU1pY3JvcGhvbmUiLCJzZW5kRGF0YSIsInN0cmluZ2lmeSIsIndob20iLCJzZW5kRGF0YUd1YXJhbnRlZWQiLCJicm9hZGNhc3REYXRhIiwiYnJvYWRjYXN0RGF0YUd1YXJhbnRlZWQiLCJraWNrIiwicGVybXNUb2tlbiIsImJsb2NrIiwidW5ibG9jayIsInJlZ2lzdGVyIiwibW9kdWxlIiwiZXhwb3J0cyJdLCJzb3VyY2VSb290IjoiIn0=