import { logger } from '../../utils/logger';
import { rpcFetch } from 'src/services/network/rpcExchange';
import { sendEventToConnected } from './dappConnections';
import { txQueue } from './txQueue';
import { getActiveWallet } from './wallet';

export async function refreshAndBroadcastBalance(address: string) {
  try {
    const networkUrl = await txQueue.getNetworkUrl();
    const resp = await rpcFetch(
      `${networkUrl}/rpc`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'octra_balance',
          params: [address],
          id: Date.now(),
        }),
        cache: 'no-store',
      },
      { lane: 'poll' }
    );
    if (!resp.ok) return;
    const rpc = await resp.json();
    if (rpc.error) return;

    const newBalance = {
      public: parseFloat(rpc.result?.balance || '0'),
      private: 0,
      total: parseFloat(rpc.result?.balance || '0'),
      currency: 'OCT',
    };

    try {
      const walletInfo = await getActiveWallet();
      if (walletInfo?.address === address) {
        const priv = walletInfo.privateBalance || walletInfo.balance?.private || 0;
        newBalance.private = priv;
        newBalance.total = newBalance.public + priv;
      }
    } catch {}

    await sendEventToConnected(
      {
        type: 'balanceChanged',
        data: {
          balance: newBalance,
          publicBalance: newBalance.public,
          privateBalance: newBalance.private,
        },
      },
      address
    );

    logger.debug(
      `[Background] Balance broadcast: ${newBalance.public} OCT to dApps for ${address.slice(0, 12)}...`
    );
  } catch (e) {
    logger.warn('[Background] Balance refresh failed:', e);
  }
}
