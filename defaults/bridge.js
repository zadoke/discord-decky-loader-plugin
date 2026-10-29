// Injected into the hidden Discord web client tab before Discord's own scripts run.
// It reads Discord's internal stores, dispatches voice actions, relays the
// microphone from the Steam UI, and reports state back to the plugin backend
// through the `discordDeckEmit` DevTools binding. No third-party client mod is used.
(() => {
  if (window.top !== window || window.__discordDeck) return;

  if (!Object.hasOwn) {
    Object.hasOwn = (obj, prop) => Object.prototype.hasOwnProperty.call(obj, prop);
  }

  const emit = (msg) => {
    try {
      window.discordDeckEmit(JSON.stringify(msg));
    } catch (e) {
      console.warn("[discord-deck] emit failed", e);
    }
  };

  // --- Webpack module access -------------------------------------------------

  // Discord runs several webpack runtimes on the same chunk array and each one
  // calls our callback, so keep the one with the most loaded modules (the app).
  // Not cached: early on only the small login runtime exists.
  let currentWreq;
  const getWreq = () => {
    const chunk = window.webpackChunkdiscord_app;
    if (!chunk || typeof chunk.push !== "function") return undefined;
    let best;
    chunk.push([[Symbol("discord-deck")], {}, (r) => {
      if (r?.c && (!best || Object.keys(r.c).length > Object.keys(best.c).length)) best = r;
    }]);
    chunk.pop();
    if (best && best !== currentWreq) {
      // A bigger runtime appeared (e.g. after signing in): drop lookups made
      // against the old one so stores and the dispatcher come from the app.
      currentWreq = best;
      resetLookups();
    }
    return best;
  };

  function* allExports() {
    const cache = getWreq()?.c;
    if (!cache) return;
    for (const id in cache) {
      const exp = cache[id]?.exports;
      if (!exp || exp === window) continue;
      yield exp;
      if (typeof exp !== "object") continue;
      for (const key in exp) {
        let value;
        try { value = exp[key]; } catch { continue; }
        if (value && value !== window) yield value;
      }
    }
  }

  // Discord's translation modules are Proxies that return a function for any
  // property name, so they'd match every "has these functions" filter.
  // Cached, since each probe of such a Proxy logs a missing-translation warning.
  const catchAllChecked = new WeakMap();
  const isCatchAll = (e) => {
    if (typeof e !== "object" && typeof e !== "function") return false;
    let result = catchAllChecked.get(e);
    if (result === undefined) {
      try { result = e["__discordDeckProbe__"] !== undefined; } catch { result = true; }
      catchAllChecked.set(e, result);
    }
    return result;
  };

  const find = (filter) => {
    for (const exp of allExports()) {
      try { if (!isCatchAll(exp) && filter(exp)) return exp; } catch { /* ignore odd modules */ }
    }
    return undefined;
  };

  let stores = {};
  const store = (name) =>
    (stores[name] ??= find((e) => typeof e === "object" &&
      (e.getName?.() === name || e.constructor?.displayName === name)));

  let flux;
  const getFlux = () =>
    (flux ??= find((e) => typeof e === "object" &&
      typeof e.dispatch === "function" &&
      typeof e.subscribe === "function" &&
      typeof e.unsubscribe === "function" &&
      typeof e.register === "function" &&
      typeof e._actionHandlers === "object"));

  // Discord's own channel action creators. Dispatching VOICE_CHANNEL_SELECT
  // alone only updates the UI; selectVoiceChannel also tells the gateway to join.
  let channelActions;
  const getChannelActions = () =>
    (channelActions ??= find((e) => typeof e === "object" &&
      typeof e.selectVoiceChannel === "function" &&
      typeof e.selectChannel === "function" &&
      typeof e.disconnect === "function"));

  function resetLookups() {
    stores = {};
    flux = undefined;
    channelActions = undefined;
    subscribed = false;
  }

  const dispatch = (action) => {
    const f = getFlux();
    if (!f) throw new Error("Discord is not ready yet");
    return f.dispatch(action);
  };

  // --- Sign-in QR code -------------------------------------------------------
  // The login page's QR code encodes https://discord.com/ra/<fingerprint>. We
  // read that link out of React's component tree (props and hook state) so the
  // panel can draw the QR itself bc on Windows the view never shows on screen.

  const REMOTE_AUTH_URL = /https:\/\/discord\.com\/ra\/[\w-]+/;

  const findLink = (value, depth = 0) => {
    if (typeof value === "string") return value.match(REMOTE_AUTH_URL)?.[0] ?? null;
    if (depth > 2 || !value || typeof value !== "object" || value.$$typeof || value instanceof Node) {
      return null;
    }
    for (const key in value) {
      if (key === "children" || key === "_owner" || key === "return") continue;
      let child;
      try { child = value[key]; } catch { continue; }
      const found = findLink(child, depth + 1);
      if (found) return found;
    }
    return null;
  };

  const reactRoot = () => {
    const mount = document.getElementById("app-mount");
    if (!mount) return null;
    const containerKey = Object.keys(mount).find((k) => k.startsWith("__reactContainer$"));
    if (containerKey) return mount[containerKey];
    // Older React: climb from any rendered element's fiber to the root.
    const el = mount.querySelector("*");
    const fiberKey = el && Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
    let fiber = fiberKey ? el[fiberKey] : null;
    while (fiber?.return) fiber = fiber.return;
    return fiber;
  };

  const findRemoteAuthUrl = () => {
    const root = reactRoot();
    if (!root) return null;
    const stack = [root];
    for (let visited = 0; stack.length && visited < 30000; visited++) {
      const fiber = stack.pop();
      let found = findLink(fiber.memoizedProps);
      // Hooks keep their state in a linked list; class components in a plain object.
      for (let hook = fiber.memoizedState, i = 0; !found && hook && typeof hook === "object" && i < 50; i++) {
        found = Object.hasOwn(hook, "next") ? findLink(hook.memoizedState) : findLink(hook);
        hook = hook.next;
      }
      if (found) return found;
      if (fiber.sibling) stack.push(fiber.sibling);
      if (fiber.child) stack.push(fiber.child);
    }
    return null;
  };

  const qrSnapshot = () => {
    let url = null;
    try { url = findRemoteAuthUrl(); } catch (e) { console.warn("[discord-deck] QR lookup failed", e); }
    // After a scan Discord swaps the QR for "Check your phone!".
    const scanned = /check your phone/i.test(document.body?.textContent ?? "");
    return { url, scanned };
  };

  // --- State snapshot --------------------------------------------------------

  const displayName = (u, fallback) => u?.globalName ?? u?.global_name ?? u?.username ?? fallback;

  const snapshot = () => {
    const users = store("UserStore");
    const me = users?.getCurrentUser?.();
    if (!me) {
      // The login/QR page only loads a small bundle without UserStore, so treat it as ready.
      const onAuthPage = /^\/(login|register)\b/.test(location.pathname);
      return {
        ready: onAuthPage || !!users,
        loggedIn: false,
        qr: onAuthPage ? qrSnapshot() : null,
      };
    }

    const selected = store("SelectedChannelStore");
    const channels = store("ChannelStore");
    const guilds = store("GuildStore");
    const voiceStates = store("VoiceStateStore");
    const media = store("MediaEngineStore");

    const voiceChannelId = selected?.getVoiceChannelId?.() ?? null;
    let voice = null;
    if (voiceChannelId) {
      const channel = channels?.getChannel?.(voiceChannelId);
      const guild = channel?.guild_id ? guilds?.getGuild?.(channel.guild_id) : null;
      const states = voiceStates?.getVoiceStatesForChannel?.(voiceChannelId) ?? {};
      voice = {
        channelId: voiceChannelId,
        channelName: channel?.name || "Call",
        guildName: guild?.name ?? null,
        members: Object.values(states).map((s) => ({
          id: s.userId,
          name: displayName(users.getUser?.(s.userId), s.userId),
          muted: !!(s.selfMute || s.mute),
          deafened: !!(s.selfDeaf || s.deaf),
        })),
      };
    }

    return {
      ready: true,
      loggedIn: true,
      user: { id: me.id, name: displayName(me, me.id), avatar: me.avatar ?? null },
      muted: !!media?.isSelfMute?.(),
      deafened: !!media?.isSelfDeaf?.(),
      voice,
      // Discord's voice connection status, e.g. RTC_CONNECTING or RTC_CONNECTED.
      rtc: store("RTCConnectionStore")?.getState?.() ?? null,
      streaming: isStreaming(),
      mic: micStatus,
      joinError,
      screen: { width: window.screen.width, height: window.screen.height },
    };
  };

  let lastSent = "";
  const pushState = () => {
    let state;
    try { state = snapshot(); } catch (e) { state = { ready: false, loggedIn: false, error: String(e) }; }
    const json = JSON.stringify(state);
    if (json === lastSent) return;
    lastSent = json;
    emit({ type: "state", state });
  };

  let pushTimer;
  const schedulePush = () => {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(pushState, 150);
  };

  const WATCHED_EVENTS = [
    "CONNECTION_OPEN",
    "LOGOUT",
    "VOICE_STATE_UPDATES",
    "VOICE_CHANNEL_SELECT",
    "AUDIO_TOGGLE_SELF_MUTE",
    "AUDIO_TOGGLE_SELF_DEAF",
    "RTC_CONNECTION_STATE",
  ];

  let subscribed = false;
  const trySubscribe = () => {
    if (subscribed) return;
    const f = getFlux();
    if (!f) return;
    for (const type of WATCHED_EVENTS) f.subscribe(type, schedulePush);
    subscribed = true;
  };

  // Event subscriptions keep the panel live; the interval is a cheap safety net
  // (pushState only emits when something actually changed).
  setInterval(() => {
    trySubscribe();
    pushState();
  }, 3000);

  // --- Microphone relay ------------------------------------------------------
  // Steam's embedded browser views can't open the mic themselves, so the Steam UI
  // (which can) captures it and streams it here over a local WebRTC connection.

  const originalGetUserMedia = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
  let micStream = null;
  let micPending = null;
  let resolveMicAnswer = null;
  let rejectMicAnswer = null;
  // Shown in the panel while joining voice: idle, requesting, ok or failed.
  let micStatus = { status: "idle" };
  const setMicStatus = (next) => {
    micStatus = next;
    pushState();
  };

  const waitForIce = (pc) => new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") return resolve();
    pc.addEventListener("icegatheringstatechange", () => {
      if (pc.iceGatheringState === "complete") resolve();
    });
    setTimeout(resolve, 2000);
  });

  const relayedMic = () => {
    if (micStream && micStream.getAudioTracks().some((t) => t.readyState === "live")) {
      return Promise.resolve(micStream);
    }
    if (micPending) return micPending;

    setMicStatus({ status: "requesting" });
    micPending = (async () => {
      const pc = new RTCPeerConnection();
      pc.addTransceiver("audio", { direction: "recvonly" });
      const gotStream = new Promise((resolve) => {
        pc.ontrack = (e) => resolve(e.streams[0] ?? new MediaStream([e.track]));
      });
      const answer = new Promise((resolve, reject) => {
        resolveMicAnswer = resolve;
        rejectMicAnswer = reject;
        setTimeout(() => reject(new Error("Microphone relay timed out")), 15000);
      });

      await pc.setLocalDescription(await pc.createOffer());
      await waitForIce(pc);
      emit({ type: "micOffer", sdp: pc.localDescription.toJSON() });
      await pc.setRemoteDescription(await answer);

      const stream = await gotStream;
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed" || pc.connectionState === "closed") micStream = null;
      };
      micStream = stream;
      setMicStatus({ status: "ok" });
      return stream;
    })().catch((e) => {
      setMicStatus({ status: "failed", error: String(e?.message ?? e) });
      throw e;
    }).finally(() => {
      micPending = null;
      resolveMicAnswer = null;
      rejectMicAnswer = null;
    });
    return micPending;
  };

  if (navigator.mediaDevices) {
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      if (constraints?.audio && !constraints?.video) {
        const stream = await relayedMic();
        // Hand out clones so Discord stopping a track doesn't kill the relay.
        return new MediaStream(stream.getAudioTracks().map((t) => t.clone()));
      }
      return originalGetUserMedia(constraints);
    };
  }

  // --- Screen share relay (Windows) -------------------------------------------
  // The backend captures the screen with ffmpeg and sends us H.264 frames. We
  // decode them with WebCodecs into a generated video track and hand that to
  // Discord when it asks for the screen (getDisplayMedia), which this hidden
  // page can't do itself.

  let share = null;

  const newDecoder = (s, codec) => {
    const decoder = new VideoDecoder({
      output: (frame) => {
        // Drop frames rather than queue them if the track is falling behind.
        if (s.closed || s.pendingWrites > 2) return frame.close();
        s.pendingWrites++;
        s.writer.write(frame)
          .then(() => { s.decoded++; })
          .catch(() => {})
          .finally(() => { s.pendingWrites--; });
      },
      error: (e) => {
        s.error = String(e?.message ?? e);
        s.decoder = null;
      },
    });
    // "no-preference" still uses the GPU decoder when there is one, and works without.
    decoder.configure({ codec, hardwareAcceleration: "no-preference", optimizeForLatency: true });
    s.codec = codec;
    s.needKey = true;
    return decoder;
  };

  const prepareShare = () => {
    stopShareTrack();
    if (typeof MediaStreamTrackGenerator !== "function" || typeof VideoDecoder !== "function") {
      throw new Error("This browser can't relay video (no WebCodecs)");
    }
    const generator = new MediaStreamTrackGenerator({ kind: "video" });
    share = {
      generator,
      writer: generator.writable.getWriter(),
      decoder: null,
      codec: null,
      needKey: true,
      pendingWrites: 0,
      received: 0,
      decoded: 0,
      error: null,
      closed: false,
    };
  };

  const stopShareTrack = () => {
    const s = share;
    share = null;
    if (!s) return;
    s.closed = true;
    try { s.decoder?.close(); } catch { /* already closed */ }
    // Closing the writer ends the source, so every clone Discord holds ends too.
    s.writer.close().catch(() => {});
    try { s.generator.stop(); } catch { /* already stopped */ }
  };

  const onFrame = (b64, key, ts, codec) => {
    const s = share;
    if (!s || s.closed) return;
    s.received++;
    if (!s.decoder || s.codec !== codec) {
      try { s.decoder?.close(); } catch { /* ignore */ }
      s.decoder = newDecoder(s, codec);
    }
    if (s.needKey && !key) return;
    // Too far behind: skip ahead to the next keyframe.
    if (!key && s.decoder.decodeQueueSize > 8) {
      s.needKey = true;
      return;
    }
    s.needKey = false;
    const bin = atob(b64);
    const data = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
    s.decoder.decode(new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp: ts, data }));
  };

  const originalGetDisplayMedia = navigator.mediaDevices?.getDisplayMedia?.bind(navigator.mediaDevices);
  if (navigator.mediaDevices) {
    navigator.mediaDevices.getDisplayMedia = async (constraints) => {
      if (share && !share.closed) return new MediaStream([share.generator.clone()]);
      if (originalGetDisplayMedia) return originalGetDisplayMedia(constraints);
      throw new DOMException("Permission denied", "NotAllowedError");
    };
  }

  const isStreaming = () => !!store("ApplicationStreamingStore")?.getCurrentUserActiveStream?.();

  // Finds a function in Discord's bundle by a snippet of its source, like
  // Vencord's findByCode.
  const codeLookups = {};
  const findByCode = (code) => {
    if (codeLookups[code]) return codeLookups[code];
    const toString = Function.prototype.toString;
    const found = find((e) => typeof e === "function" && toString.call(e).includes(code));
    if (found) codeLookups[code] = found;
    return found;
  };

  // the media engine acquires a desktop source (which calls getDisplayMedia, answered above), then
  // STREAM_START publishes it.
  let shareSourceId = null;

  const streamKey = (s) => s.guildId
    ? `guild:${s.guildId}:${s.channelId}:${s.ownerId}`
    : `call:${s.channelId}:${s.ownerId}`;

  // Clicks through React's handlers
  const reactClick = (el) => {
    const key = Object.keys(el).find((k) => k.startsWith("__reactProps"));
    const onClick = key && el[key]?.onClick;
    if (typeof onClick === "function") {
      onClick({ preventDefault() {}, stopPropagation() {}, currentTarget: el, target: el, type: "click" });
    } else {
      el.click();
    }
  };

  // --- On-screen keyboard ----------------------------------------------------

  document.addEventListener("focusin", (e) => {
    const el = e.target;
    if (!(el instanceof HTMLElement)) return;
    if (el.matches("input, textarea, [contenteditable=true], [role=textbox]")) {
      emit({ type: "keyboard" });
    }
  }, true);

  // --- Commands from the plugin ------------------------------------------------

  const currentVoiceChannelId = () => store("SelectedChannelStore")?.getVoiceChannelId?.() ?? null;

  const selectVoiceChannel = (guildId, channelId) => {
    const actions = getChannelActions();
    if (actions) return actions.selectVoiceChannel(channelId);
    return dispatch({
      type: "VOICE_CHANNEL_SELECT",
      guildId,
      channelId,
      currentVoiceChannelId: currentVoiceChannelId(),
      video: false,
      stream: false,
    });
  };

  let joinError = null;

  const commands = {
    state: () => snapshot(),

    toggleMute: () => dispatch({ type: "AUDIO_TOGGLE_SELF_MUTE", context: "default", syncRemote: true }),

    toggleDeafen: () => dispatch({ type: "AUDIO_TOGGLE_SELF_DEAF", context: "default", syncRemote: true }),

    // These return right away; the panel polls state to confirm the change,
    // because timers in this hidden page are heavily throttled by Chromium.
    disconnect: () => {
      joinError = null;
      selectVoiceChannel(null, null);
    },

    join: ({ channelId }) => {
      const channel = store("ChannelStore")?.getChannel?.(channelId);
      if (!channel) throw new Error("Unknown channel");
      joinError = null;
      // Not awaited: it can wait on the microphone, which outlasts a command.
      Promise.resolve(selectVoiceChannel(channel.guild_id ?? null, channel.id)).catch((e) => {
        joinError = String(e?.message ?? e);
        pushState();
      });
    },

    guilds: () => {
      const all = store("GuildStore")?.getGuilds?.() ?? {};
      return Object.values(all)
        .map((g) => ({ id: g.id, name: g.name }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },

    voiceChannels: ({ guildId }) => {
      const grouped = store("GuildChannelStore")?.getChannels?.(guildId);
      const voiceStates = store("VoiceStateStore");
      return (grouped?.VOCAL ?? [])
        .map((entry) => entry.channel ?? entry)
        .filter((c) => c?.id)
        .map((c) => ({
          id: c.id,
          name: c.name,
          memberCount: Object.keys(voiceStates?.getVoiceStatesForChannel?.(c.id) ?? {}).length,
        }));
    },

    setPushToTalk: ({ enabled }) => {
      const media = store("MediaEngineStore");
      dispatch({
        type: "AUDIO_SET_MODE",
        context: "default",
        mode: enabled ? "PUSH_TO_TALK" : "VOICE_ACTIVITY",
        options: media?.getSettings?.()?.modeOptions ?? {},
      });
    },

    pushToTalk: ({ pressed }) => {
      const connections = store("MediaEngineStore")?.getMediaEngine?.()?.connections;
      if (!connections) return;
      for (const conn of connections.values ? connections.values() : connections) {
        conn?.setForceAudioInput?.(!!pressed);
      }
    },

    prepareShare: ({ width, height } = {}) => {
      prepareShare();
      share.quality = { width: width ?? 1920, height: height ?? 1080 };
    },

    shareInfo: () => share && { received: share.received, decoded: share.decoded, error: share.error },

    goLive: async () => {
      if (!share) throw new Error("Screen capture is not running");
      const channelId = currentVoiceChannelId();
      if (!channelId) throw new Error("Join a voice channel first");
      if (isStreaming()) return "already streaming";
      const startStream = findByCode('"STREAM_START",streamType');
      if (!startStream) throw new Error("Couldn't find Discord's Go Live action");
      const guildId = store("ChannelStore")?.getChannel?.(channelId)?.guild_id ?? null;
      const engine = store("MediaEngineStore")?.getMediaEngine?.();
      if (engine?.getDesktopSource) {
        const q = share.quality ?? { width: 1920, height: 1080 };
        shareSourceId = await engine.getDesktopSource({ width: q.width, height: q.height }, true);
        startStream(guildId, channelId, { pid: null, sourceId: shareSourceId, sourceName: null });
        return `desktop source ${shareSourceId}`;
      }
      // Older bundles started capture from STREAM_START alone.
      startStream(guildId, channelId, {});
      return "legacy STREAM_START";
    },

    // Confirms a Go Live dialog if Discord shows one, and reports progress.
    goLiveConfirm: () => {
      if (isStreaming()) return { streaming: true };
      const confirm = [...document.querySelectorAll("[role=dialog] button")]
        .find((b) => !b.disabled && /^go live$/i.test(b.textContent?.trim() ?? ""));
      if (confirm) reactClick(confirm);
      return { streaming: isStreaming(), clicked: !!confirm };
    },

    stopShare: () => {
      const active = store("ApplicationStreamingStore")?.getCurrentUserActiveStream?.();
      const stopStream = findByCode('"STREAM_STOP"');
      if (active && stopStream) {
        try { stopStream(streamKey(active)); } catch (e) { console.warn("[discord-deck] STREAM_STOP failed", e); }
      }
      if (shareSourceId != null) {
        try {
          store("MediaEngineStore")?.getMediaEngine?.()?.desktopInputPool?.get?.(shareSourceId)?.destroy?.();
        } catch { /* already gone */ }
        shareSourceId = null;
      }
      stopShareTrack();
    },

    // Reloads the page, e.g. for a fresh QR code or to clear a stuck captcha.
    reload: () => {
      setTimeout(() => location.reload(), 0);
    },

    micAnswer: ({ sdp, error }) => {
      if (error) rejectMicAnswer?.(new Error(error));
      else resolveMicAnswer?.(sdp);
    },
  };

  window.__discordDeck = {
    // Called by the backend for every video frame of a screen share.
    frame: (b64, key, ts, codec) => {
      try { onFrame(b64, !!key, ts, codec); } catch (e) { if (share) share.error = String(e?.message ?? e); }
    },
    run: async (name, args) => {
      const command = commands[name];
      if (!command) throw new Error(`Unknown command: ${name}`);
      const result = await command(args ?? {});
      schedulePush();
      return result ?? null;
    },
  };
})();
