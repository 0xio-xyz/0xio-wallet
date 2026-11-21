// The host answers ONLY read methods (see bridge.ts). The prelude gives the NFT program a tiny
// `window.OctraCircle.request(method, params)` so it can read chain state without touching the
// network itself - strictly read-only, never signing or key access.

export const LIVING_MSG = 'octra-living' as const;

export interface ReadyMessage {
  source: typeof LIVING_MSG;
  type: 'ready';
}

export interface RenderMessage {
  source: typeof LIVING_MSG;
  type: 'render';
  payload: {
    html: string;
    inputs: Record<string, unknown>;
    connect?: string | null;
    bridgeRpc?: string | null;
  };
}

export interface BridgeRequest {
  source: typeof LIVING_MSG;
  type: 'bridge-request';
  id: number;
  method: string;
  params: unknown[];
}

export interface BridgeResponse {
  source: typeof LIVING_MSG;
  type: 'bridge-response';
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface AudioMessage {
  source: typeof LIVING_MSG;
  type: 'audio';
  enabled: boolean;
}

export interface AudioProbeMessage {
  source: typeof LIVING_MSG;
  type: 'audio-probe';
  event: string;
  state?: string;
}

export interface SnapshotMessage {
  source: typeof LIVING_MSG;
  type: 'snapshot';
  dataUrl: string;
}

export interface ProgramBootMessage {
  source: typeof LIVING_MSG;
  type: 'program-boot';
}

export type LivingMessage =
  | ReadyMessage
  | RenderMessage
  | BridgeRequest
  | BridgeResponse
  | AudioMessage
  | AudioProbeMessage
  | SnapshotMessage
  | ProgramBootMessage;

export function isLiving(d: unknown): d is LivingMessage {
  return !!d && typeof d === 'object' && (d as { source?: unknown }).source === LIVING_MSG;
}

// Injected ahead of the NFT's own HTML (inside the nested iframe). Plain ES5 string - it runs in
// the untrusted document, so it must not reference any bundler/TS constructs.
export const OCTRA_CIRCLE_PRELUDE = `
(function () {
  // Liveness ping: tells the host this inline prelude actually executed. On Firefox a strict page
  // CSP blocks inline <script>, so this never fires and the host falls back to the static image.
  try { parent.postMessage({ source: '${LIVING_MSG}', type: 'program-boot' }, '*'); } catch (e) {}
  var pending = {}, seq = 0, audioCb = null, audioCtxs = [];
  // Force willReadFrequently on the program's 2d canvases - silences Chrome's "Canvas2D ...
  // getImageData ... willReadFrequently" warning and speeds the per-frame pixel readbacks
  // (grain/feedback effects), which also trims the rAF-handler violations. Only set when the
  // program didn't specify, so an explicit choice is respected.
  try {
    var _getCtx = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, attrs) {
      if (type === '2d') {
        attrs = attrs || {};
        if (attrs.willReadFrequently === undefined) attrs.willReadFrequently = true;
      }
      // Without preserveDrawingBuffer a WebGL canvas reads back blank outside its own draw
      // frame, so the poster capture below produced empty thumbnails for GL programs
      // (Geodesics). Only set when the program didn't specify, same as 2d above.
      if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') {
        attrs = attrs || {};
        if (attrs.preserveDrawingBuffer === undefined) attrs.preserveDrawingBuffer = true;
      }
      return _getCtx.call(this, type, attrs);
    };
  } catch (e) {}
  // Audio loudness - many pieces output at a low level. Route everything that would hit the
  // destination through a shared master gain + limiter so the wallet's speaker toggle is actually
  // audible without harsh clipping. AUDIO_BOOST is the master gain.
  var AUDIO_BOOST = 3.2;
  try {
    var AN = window.AudioNode;
    if (AN && AN.prototype && AN.prototype.connect) {
      var _connect = AN.prototype.connect;
      AN.prototype.connect = function (target) {
        try {
          var ctx = this.context;
          if (ctx && target && target === ctx.destination) {
            var master = ctx.__octraMaster;
            if (!master) {
              master = ctx.createGain();
              master.gain.value = AUDIO_BOOST;
              var limiter = ctx.createDynamicsCompressor();
              try {
                limiter.threshold.value = -3; limiter.knee.value = 0;
                limiter.ratio.value = 20; limiter.attack.value = 0.003; limiter.release.value = 0.25;
              } catch (e2) {}
              _connect.call(master, limiter);
              _connect.call(limiter, ctx.destination);
              ctx.__octraMaster = master;
            }
            var args = Array.prototype.slice.call(arguments);
            args[0] = master;
            return _connect.apply(this, args);
          }
        } catch (e1) {}
        return _connect.apply(this, arguments);
      };
    }
  } catch (e) {}
  // Audio diagnostic - wrap AudioContext so the host can SEE (in its logs) whether the program ever
  // creates one and whether it resumes. Empty = the renderer has no audio for this piece; 'created'
  // + state='suspended' that never reaches 'running' = a real autoplay/gesture block. No reaching
  // into the sandbox needed - the program reports out via postMessage. Also track each context so the
  // wallet's speaker toggle can resume/suspend it directly (programs that ignore onAudio()).
  try {
    var _AC = window.AudioContext || window.webkitAudioContext;
    if (_AC) {
      var _report = function (ev, st) {
        try { parent.postMessage({ source: '${LIVING_MSG}', type: 'audio-probe', event: ev, state: st }, '*'); } catch (e) {}
      };
      var _Wrapped = function () {
        var ctx = arguments.length ? new _AC(arguments[0]) : new _AC();
        try { audioCtxs.push(ctx); } catch (e) {}
        _report('created', ctx.state);
        var _res = ctx.resume.bind(ctx);
        ctx.resume = function () { _report('resume-called', ctx.state); return _res(); };
        try { ctx.addEventListener('statechange', function () { _report('statechange', ctx.state); }); } catch (e) {}
        return ctx;
      };
      _Wrapped.prototype = _AC.prototype;
      window.AudioContext = _Wrapped;
      window.webkitAudioContext = _Wrapped;
    }
  } catch (e) {}
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.source !== '${LIVING_MSG}') return;
    // Host -> program audio toggle (speaker icon next to ● LIVE). Muted by default.
    if (d.type === 'audio') {
      var on = !!d.enabled;
      window.OctraCircle.audioEnabled = on;
      // Drive the program's AudioContext(s) directly - works even if it never registers onAudio().
      try {
        for (var i = 0; i < audioCtxs.length; i++) {
          var c = audioCtxs[i];
          if (on) { if (c && c.resume) c.resume(); }
          else { if (c && c.suspend) c.suspend(); }
        }
      } catch (err) {}
      if (audioCb) { try { audioCb(on); } catch (err) {} }
      return;
    }
    if (d.type !== 'bridge-response') return;
    var p = pending[d.id]; if (!p) return; delete pending[d.id];
    if (d.ok) p.resolve(d.result); else p.reject(new Error(d.error || 'bridge error'));
  });
  window.OctraCircle = {
    inputs: (window.__OCTRA_INPUTS__ || {}),
    // Audio: muted until the user taps the wallet's speaker icon. Read audioEnabled, or register
    // onAudio(cb) to start/stop your AudioContext (allow=autoplay lets it start without an in-frame
    // gesture). The wallet can't touch your AudioContext directly - this is the only control.
    audioEnabled: false,
    onAudio: function (cb) { audioCb = cb; if (this.audioEnabled) { try { cb(true); } catch (err) {} } },
    request: function (method, params) {
      return new Promise(function (resolve, reject) {
        var id = ++seq;
        pending[id] = { resolve: resolve, reject: reject };
        parent.postMessage(
          { source: '${LIVING_MSG}', type: 'bridge-request', id: id, method: method, params: params || [] },
          '*'
        );
        setTimeout(function () {
          if (pending[id]) { delete pending[id]; reject(new Error('bridge timeout')); }
        }, 20000);
      });
    }
  };
  // Poster capture - once the art has settled, snapshot the canvas (center-cropped square, scaled
  // to 256px) and hand it to the host, which caches it as a static grid thumbnail so it doesn't
  // have to run the program in the gallery. Best-effort: tainted/absent canvas just yields nothing.
  // A blank readback (canvas not drawn yet, or a GL program that ignored the attrs patch above)
  // is detected by pixel-sampling and retried instead of caching an empty tile.
  var _posterTries = 0;
  function _capturePoster() {
    _posterTries++;
    try {
      var cs = document.querySelectorAll('canvas'), best = null, area = 0;
      for (var i = 0; i < cs.length; i++) {
        var a = cs[i].width * cs[i].height;
        if (a > area) { area = a; best = cs[i]; }
      }
      if (!best || !best.width || !best.height) throw 0;
      var S = 256, side = Math.min(best.width, best.height);
      var sx = (best.width - side) / 2, sy = (best.height - side) / 2;
      var oc = document.createElement('canvas'); oc.width = S; oc.height = S;
      var ctx = oc.getContext('2d');
      ctx.drawImage(best, sx, sy, side, side, 0, 0, S, S);
      var px = ctx.getImageData(0, 0, S, S).data, lit = 0;
      for (var p = 0; p < px.length; p += 512) {
        if (px[p + 3] > 8 && (px[p] > 12 || px[p + 1] > 12 || px[p + 2] > 12)) lit++;
      }
      if (lit < 4) throw 0;
      var url = oc.toDataURL('image/webp', 0.75);
      if (url && url.length > 64) {
        parent.postMessage({ source: '${LIVING_MSG}', type: 'snapshot', dataUrl: url }, '*');
        return;
      }
      throw 0;
    } catch (e) {}
    if (_posterTries < 4) setTimeout(_capturePoster, 2500);
  }
  setTimeout(_capturePoster, 3000);
})();
`;
