import {
  OCTRA_CIRCLE_PRELUDE,
  isLiving,
  type BridgeRequest,
  type BridgeResponse,
  type RenderMessage,
} from 'src/features/wallet/nft/euint/protocol';
import { bridgeFetchShim } from 'src/features/wallet/nft/euint/chainState';
import { logger } from 'src/utils/logger';

// The popup already validated these; checked again because they land inside a policy attribute.
const SAFE_ENDPOINT = /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._~/-]*)?$/;
const endpointOrNull = (v: unknown): string | null =>
  typeof v === 'string' && SAFE_ENDPOINT.test(v) ? v : null;

const HOST = window.parent;
let geode: HTMLIFrameElement | null = null;

function mountGeode(msg: RenderMessage): void {
  geode?.remove();
  const frame = document.createElement('iframe');
  frame.id = 'geode';
  // allow-scripts ONLY (opaque origin - no access to this shell's globals/storage or the popup).
  frame.setAttribute('sandbox', 'allow-scripts');
  // Allow the program's AudioContext to produce sound. Wildcard allowlist (`autoplay *`), not bare
  // `autoplay`: this frame is sandboxed without allow-same-origin -> opaque origin, which the
  // default `'src'` allowlist doesn't match (audio would stay muted). `*` grants it regardless.
  frame.setAttribute('allow', 'autoplay *');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  const inputs = msg.payload.inputs ?? {};
  const inputsScript = `<script>window.__OCTRA_INPUTS__ = ${JSON.stringify(inputs).replace(/</g, '\\u003c')};</script>`;
  // srcdoc has no URL, so location.search is empty and history.replaceState throws in this opaque
  // origin - override location.search + URLSearchParams to return the real query.
  const search = (inputs as Record<string, unknown>)._search;
  const searchShim =
    typeof search === 'string' && search
      ? `<script>(function(){try{var s=${JSON.stringify(search).replace(/</g, '\\u003c')};` +
        `try{Object.defineProperty(Object.getPrototypeOf(location),'search',{configurable:true,get:function(){return s;}});}catch(e){}` +
        `var N=window.URLSearchParams;if(N){window.URLSearchParams=function(i){if(i===''||i==null)i=s;return new N(i);};window.URLSearchParams.prototype=N.prototype;}` +
        `try{history.replaceState(null,'',s);}catch(e){}}catch(e){}})();</script>`
      : '';
  const preludeScript = `<script>${OCTRA_CIRCLE_PRELUDE}</script>`;
  // First in the document, so it governs every script after it: on top of this page's policy the
  // program may reach its own network's RPC endpoint and nothing else.
  const connect = endpointOrNull(msg.payload.connect);
  const policy = `<meta http-equiv="Content-Security-Policy" content="connect-src ${connect ?? "'none'"}">`;
  const bridgeRpc = endpointOrNull(msg.payload.bridgeRpc);
  const fetchShim = bridgeRpc ? `<script>${bridgeFetchShim(bridgeRpc)}</script>` : '';
  frame.srcdoc = policy + inputsScript + searchShim + preludeScript + fetchShim + msg.payload.html;
  document.body.appendChild(frame);
  geode = frame;
  logger.debug(
    `[LivingNFT shell] geode mounted | html=${msg.payload.html.length}c inputs=[${Object.keys(inputs).join(',')}] search=${search ? 'yes' : 'no'} connect=${connect ?? 'none'}${bridgeRpc ? ' via bridge' : ''}`
  );
}

window.addEventListener('message', (e: MessageEvent) => {
  const d = e.data;
  if (!isLiving(d)) return;

  if (e.source === HOST) {
    if (d.type === 'render') {
      logger.debug('[LivingNFT shell] render payload received from host');
      mountGeode(d);
    } else if (d.type === 'bridge-response' && geode?.contentWindow) {
      geode.contentWindow.postMessage(d as BridgeResponse, '*');
    } else if (d.type === 'audio' && geode?.contentWindow) {
      logger.debug(
        `[LivingNFT shell] audio relay -> geode enabled=${(d as { enabled?: boolean }).enabled}`
      );
      geode.contentWindow.postMessage(d, '*');
    }
    return;
  }

  if (geode && e.source === geode.contentWindow && d.type === 'bridge-request') {
    logger.debug(`[LivingNFT shell] bridge-request ${d.method} -> host`);
    HOST.postMessage(d as BridgeRequest, '*');
  }
  if (geode && e.source === geode.contentWindow && d.type === 'audio-probe') {
    HOST.postMessage(d, '*');
  }
  if (geode && e.source === geode.contentWindow && d.type === 'snapshot') {
    HOST.postMessage(d, '*');
  }
  if (geode && e.source === geode.contentWindow && d.type === 'program-boot') {
    HOST.postMessage(d, '*');
  }
});

logger.debug('[LivingNFT shell] loaded -> posting ready to host');
HOST.postMessage({ source: 'octra-living', type: 'ready' }, '*');
