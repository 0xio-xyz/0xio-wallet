import { useEffect, useRef, useState } from 'react';
import { logger } from 'src/utils/logger';
import { rpcUrlFor } from 'src/services/network/txScope';
import { parseOctUri } from 'src/features/wallet/nft/xpectrum/circle';
import { handleBridgeRequest } from './bridge';
import { livingQuery, livingRpcEndpoint, readsChainState, STATIC_RPCS } from './chainState';
import { loadProgram } from './program';
import { isLiving, LIVING_MSG } from './protocol';

export const MAX_POSTER_B = 300_000;
export const isSafePosterDataUrl = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.length <= MAX_POSTER_B &&
  /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(v);

interface Props {
  uri: string;
  networkId: string;
  inputs?: Record<string, unknown>;
  className?: string;
  onError?: () => void;
  audioEnabled?: boolean;
  onSnapshot?: (dataUrl: string) => void;
}

export function LivingNftFrame({
  uri,
  networkId,
  inputs,
  className,
  onError,
  audioEnabled,
  onSnapshot,
}: Props) {
  const ref = useRef<HTMLIFrameElement>(null);
  const inputsRef = useRef(inputs);
  inputsRef.current = inputs;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onSnapshotRef = useRef(onSnapshot);
  onSnapshotRef.current = onSnapshot;
  const [failed, setFailed] = useState(false);

  // effect:audited - forward the speaker toggle to the sandbox shell (which relays it to the
  // program). Keyed to audioEnabled; the program self-gates audio on it (muted by default).
  useEffect(() => {
    logger.debug(
      `[LivingNFT] speaker toggle -> audio enabled=${!!audioEnabled} (program must register OctraCircle.onAudio to react)`
    );
    ref.current?.contentWindow?.postMessage(
      { source: LIVING_MSG, type: 'audio', enabled: !!audioEnabled },
      '*'
    );
  }, [audioEnabled]);

  // effect:audited - cross-context postMessage bridge + one-shot render handshake. This is an
  // external subscription with setup/teardown keyed to the NFT uri, not derivable state.
  useEffect(() => {
    const iframe = ref.current;
    if (!iframe) return;
    let alive = true;
    let readyReceived = false;
    let liveWatchdog: ReturnType<typeof setTimeout> | null = null;
    let programLive = false;
    setFailed(false);

    const markLive = () => {
      programLive = true;
      if (liveWatchdog) {
        clearTimeout(liveWatchdog);
        liveWatchdog = null;
      }
    };
    logger.debug(`[LivingNFT] mount frame -> ${chrome.runtime.getURL('renderer.html')} for ${uri}`);

    const fail = (why: string) => {
      logger.warn(`[LivingNFT] ${why}`);
      if (alive) {
        setFailed(true);
        onErrorRef.current?.();
      }
    };

    const readyWatchdog = setTimeout(() => {
      if (alive && !readyReceived) {
        logger.warn(
          `[LivingNFT] no 'ready' from renderer.html after 5s - sandbox page may have failed to load (check CSP/COEP/sandbox). uri=${uri}`
        );
      }
    }, 5000);

    const onMessage = async (e: MessageEvent) => {
      if (e.source !== iframe.contentWindow || !isLiving(e.data)) return;
      const d = e.data;

      if (d.type === 'program-boot') {
        markLive();
        return;
      }

      if (d.type === 'audio-probe') {
        logger.debug(`[LivingNFT] audio-probe: ${d.event}${d.state ? ` (state=${d.state})` : ''}`);
        return;
      }

      if (d.type === 'snapshot') {
        // The program runs in the same realm as the capture prelude, so the payload is untrusted:
        // only a bounded raster data URL crosses into the popup.
        if (!isSafePosterDataUrl(d.dataUrl)) {
          logger.debug('[LivingNFT] poster rejected (not a bounded image data URL)');
          return;
        }
        markLive();
        logger.debug(`[LivingNFT] poster captured (${d.dataUrl.length}b)`);
        onSnapshotRef.current?.(d.dataUrl);
        return;
      }

      if (d.type === 'ready') {
        readyReceived = true;
        logger.debug(`[LivingNFT] renderer ready -> resolving program ${uri}`);
        const parsed = parseOctUri(uri);
        if (!parsed) return fail(`bad uri: ${uri}`);
        try {
          const endpoint = readsChainState(uri)
            ? livingRpcEndpoint(await rpcUrlFor(networkId))
            : null;
          const direct = endpoint && STATIC_RPCS.includes(endpoint) ? endpoint : null;
          const bridgeRpc = endpoint && !direct ? endpoint : null;
          const search = livingQuery(uri, endpoint);
          let html: string | null = null;
          for (let attempt = 0; attempt < 4 && alive && !html; attempt++) {
            if (attempt > 0) await new Promise((r) => setTimeout(r, 1500));
            html = await loadProgram(networkId, parsed.circleId, parsed.path);
            logger.debug(
              `[LivingNFT] fetch circle ${parsed.circleId.slice(0, 10)}…/${parsed.path} attempt ${attempt + 1}/4 -> ${html ? `${html.length}c` : 'empty'}`
            );
          }
          if (!alive) return;
          if (!html) return fail(`program asset unavailable, node slow or down (${uri})`);
          const lc = html.toLowerCase();
          const audioMarkers = [
            'audiocontext',
            'webkitaudiocontext',
            'createoscillator',
            'oscillatornode',
            'createbuffersource',
            'creategain',
            'gainnode',
            'new audio(',
            '<audio',
          ].filter((m) => lc.includes(m));
          logger.debug(
            `[LivingNFT] program audio code: ${audioMarkers.length ? audioMarkers.join(', ') : 'NONE - this renderer ships no audio'}`
          );
          logger.debug(
            `[LivingNFT] posting render -> ${html.length} chars HTML, search="${search}"`
          );
          iframe.contentWindow?.postMessage(
            {
              source: LIVING_MSG,
              type: 'render',
              payload: {
                html,
                inputs: { ...inputsRef.current, _search: search },
                connect: direct,
                bridgeRpc,
              },
            },
            '*'
          );
          liveWatchdog = setTimeout(() => {
            if (alive && !programLive) {
              fail('program never booted (inline scripts may be CSP-blocked) - using static image');
            }
          }, 8000);
        } catch (err) {
          fail(`load failed: ${err}`);
        }
      } else if (d.type === 'bridge-request') {
        markLive();
        logger.debug(`[LivingNFT] bridge-request ${d.method}`);
        try {
          const result = await handleBridgeRequest(networkId, d.method, d.params);
          iframe.contentWindow?.postMessage(
            { source: LIVING_MSG, type: 'bridge-response', id: d.id, ok: true, result },
            '*'
          );
        } catch (err) {
          iframe.contentWindow?.postMessage(
            {
              source: LIVING_MSG,
              type: 'bridge-response',
              id: d.id,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            },
            '*'
          );
        }
      }
    };

    window.addEventListener('message', onMessage);
    return () => {
      alive = false;
      clearTimeout(readyWatchdog);
      if (liveWatchdog) clearTimeout(liveWatchdog);
      window.removeEventListener('message', onMessage);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uri, networkId]);

  if (failed) return null;

  return (
    <iframe
      ref={ref}
      src={chrome.runtime.getURL('renderer.html')}
      title="Living NFT"
      onLoad={() => logger.debug('[LivingNFT] renderer.html iframe load event fired')}
      // allow-scripts ONLY - no allow-same-origin, so the program runs in an opaque origin and
      // can't reach the parent DOM, extension storage, cookies, chrome.*, or the keystore. No
      // popups/top-nav/modals/forms either. Pointer/touch events pass through by default.
      sandbox="allow-scripts"
      // MUST be the wildcard allowlist (`autoplay *`), not bare `autoplay`: this frame is sandboxed
      // without allow-same-origin, so it runs in an OPAQUE origin. Bare `autoplay` defaults to the
      // `'src'` allowlist (the URL origin), which the opaque runtime origin doesn't match -> the
      // permission is silently denied and audio stays muted even with the speaker on.
      allow="autoplay *"
      referrerPolicy="no-referrer"
      // COEP on the extension is require-corp (for PVAC); credentialless lets the sandboxed
      // frame embed cleanly. Set as an untyped attribute (not yet in the iframe DOM typings).
      {...({ credentialless: '' } as Record<string, string>)}
      className={className}
    />
  );
}
