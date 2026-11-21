import { createPortal } from 'react-dom';
import { LivingNftFrame } from 'src/features/wallet/nft/euint/LivingNftFrame';
import { jobKey, posterQueue } from 'src/features/wallet/nft/euint/posterQueue';
import { usePosterCapture } from 'src/features/wallet/nft/gallery/usePosterCapture';

const FRAME_PX = 320;

/**
 * The frame stays inside the viewport at full
 * size (an off-viewport or zero-size cross-origin frame stops drawing) but fully transparent and
 * out of reach of pointer and keyboard.
 */
export function PosterCaptureHost({ paused = false }: { paused?: boolean }) {
  const jobs = usePosterCapture(paused);
  if (jobs.length === 0) return null;
  return createPortal(
    jobs.map((job) => (
      <div
        key={jobKey(job)}
        aria-hidden="true"
        {...({ inert: '' } as Record<string, string>)}
        style={{
          position: 'fixed',
          left: 0,
          top: 0,
          width: `${FRAME_PX}px`,
          height: `${FRAME_PX}px`,
          opacity: 0,
          pointerEvents: 'none',
          overflow: 'hidden',
        }}
      >
        <LivingNftFrame
          uri={job.uri}
          networkId={job.networkId}
          inputs={{ token: job.tokenId, contract: job.contract }}
          onSnapshot={(dataUrl) => posterQueue.complete(job, dataUrl)}
          onError={() => posterQueue.fail(job)}
          className="w-full! h-full! border-0!"
        />
      </div>
    )),
    document.body
  );
}
