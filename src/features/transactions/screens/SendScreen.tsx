import React, { useState, useEffect, useRef } from 'react';
import { useRecipientContacts } from 'src/hooks/wallet/useRecipientContacts';
import useMountEffect from 'src/hooks/ui/useMountEffect';
import { useLocation, useNavigate } from 'src/lib/router';
import { useMigrateBalance } from 'src/features/privacy/hooks/useMigrateBalance';
import MigrateBalanceModal from 'src/features/privacy/components/MigrateBalanceModal';
import PrivacyOpsCta, {
  resolvePrivacyOpsState,
} from 'src/features/privacy/components/PrivacyOpsCta';
import { useTranslation } from 'src/i18n/react';
import { useTokenPrice } from 'src/hooks/wallet/useTokenPrice';
import { TextTab, FieldLabel, quietField, Sheet, PrimaryButton } from 'src/shared/ui/primitives';
import { X, ChevronDown, ArrowUpDown } from 'src/shared/ui/icons';
import Header from 'src/shared/ui/Header';
import WalletAvatar from 'src/shared/ui/WalletAvatar';
import SendResult from 'src/features/transactions/components/SendResult';
import {
  ReviewAmount,
  ReviewCard,
  ReviewFooter,
  ReviewNote,
  ReviewRow,
} from 'src/features/transactions/components/ReviewParts';
import {
  amountUnits,
  assetForMode,
  bulkIssues,
  bulkPollStage,
  bulkStage,
  bulkTotalUnits,
  displayAmount,
  feeOpType,
  feePresets as feeTiers,
  isResultStage,
  isSelfSend,
  maxSendable,
  octraTxUrl,
  pollTxOutcome,
  resolveSendOu,
  sendIssues,
  stageAfterError,
  tokenBalanceFromRaw,
  tokenDecimals,
  trimAmount,
  type PollOutcome,
  type SendStage,
} from 'src/features/transactions/sendStage';
import { middleCut } from 'src/features/wallet/add/format';
import FeeSheet from 'src/features/transactions/components/FeeSheet';
import { NameRow, NameToCard } from 'src/features/transactions/components/NameRecipient';
import {
  assertNamedSend,
  checkNamedRecipient,
  isNameEntry,
  nameLabel,
  nameReasonText,
  type NameCheck,
} from 'src/features/transactions/onsRecipient';
import { useNameLookup } from 'src/hooks/wallet/useNameLookup';
import { useLiveFee } from 'src/hooks/wallet/useLiveFee';
import FeeValue from 'src/shared/ui/FeeValue';
import Button from 'src/shared/ui/Button';

import { useWallet } from 'src/contexts/WalletContext';
import { networkService, privacyNetworkService } from 'src/services/network/NetworkService';
import { cryptoManager } from 'src/services/crypto/CryptoManager';
import { type NetworkId } from 'src/utils/config';
import { logger } from 'src/utils/logger';
import { plainError, PlainError } from 'src/utils/plainError';
import { networkCapabilities, getNetworkConfig } from 'src/utils/network';
import { passwordManager } from 'src/services/crypto/PasswordManager';
import { pvacManager } from 'src/services/pvac/PvacManager';
import {
  assertTxScope,
  captureTxScope,
  resolveNetworkPin,
  type NetworkPin,
  type TxScope,
} from 'src/services/network/txScope';
import type { SignedTransaction } from 'src/types/transaction';
import { mayHaveBroadcast } from 'src/services/network/txOutcome';
import { cleanAmountInput, fromUnits, isValidAmount, toUnits } from 'src/utils/amount';
import { isOctAddress, normalizeAddress, OCT_ADDRESS_LENGTH } from 'src/utils/octra/address';
import { clampMemo, memoBytes, MEMO_INPUT_MAX_BYTES } from 'src/utils/octra/memo';
import { proofPolicyFor, requireProofPolicy } from 'src/services/pvac/proofPolicy';
import {
  generateEphemeralKeypair,
  ecdhSharedSecret,
  computePrivateTag,
  computeClaimSecret,
  computeClaimPub,
  encryptPrivateAmount,
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
} from 'src/services/crypto/PrivateCrypto';

const PROOF_STEPS = [
  { id: 'setup', label: 'Key exchange + balance check', short: 'Setup' },
  { id: 'encrypt', label: 'HFHE encrypt', short: 'Encrypt' },
  { id: 'proofs', label: 'Range proofs (parallel)', short: 'Proofs' },
  { id: 'submit', label: 'Building + submitting tx', short: 'Submit' },
];

interface SendOutcome {
  kind: 'public' | 'private' | 'bulk';
  amount: string;
  symbol: string;
  to: string;
  networkId: NetworkId;
  hash: string | null;
  reason: string | null;
  count: number;
  sent: number;
}

const cdnTokenListCache = new Map<
  string,
  Array<{ symbol: string; name: string; address: string; decimals: number; logoURI?: string }>
>();

const parseAmountInput = (display: string) => display.replace(/,/g, '');
const cleanRecipientInput = (value: string) => {
  const compact = normalizeAddress(value);
  return /^oct[1-9A-HJ-NP-Za-km-z]{30,}$/.test(compact)
    ? compact.slice(0, OCT_ADDRESS_LENGTH)
    : value.slice(0, 64);
};
const formatAmountDisplay = (raw: string) => {
  if (!raw) return '';
  const [int, dec] = raw.split('.');
  const intFmt = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return raw.includes('.') ? `${intFmt}.${dec ?? ''}` : intFmt;
};
const caretAfterDigits = (formatted: string, n: number) => {
  if (n <= 0) return 0;
  let seen = 0;
  for (let i = 0; i < formatted.length; i++) {
    if (/[0-9.]/.test(formatted[i])) {
      seen += 1;
      if (seen === n) return i + 1;
    }
  }
  return formatted.length;
};
const amountFontSize = (display: string) => {
  const len = display.length || 4;
  return len <= 9 ? 26 : len <= 12 ? 22 : len <= 16 ? 18 : 15;
};
const toFixedTrim = (n: number, digits: number) => String(parseFloat(n.toFixed(digits)) || '');

const SendScreen = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const tokenPrices = useTokenPrice();
  const {
    balance,
    privateBalance,
    activeWallet,
    showMessage,
    refreshBalance,
    networkId,
    pvacLegacy,
  } = useWallet();

  const isWatchOnly = activeWallet?.type === 'watch';

  const entry = useLocation().state as { token?: string | null; private?: boolean } | null;
  const entryTokenRef = useRef(entry?.token ?? null);

  const [mode, setMode] = useState('single');
  const [isFHE, setIsFHE] = useState(
    () => !!entry?.private && networkCapabilities(networkId).privacy
  );
  const privacyHere = networkCapabilities(networkId).privacy;
  const [isSending, setIsSending] = useState(false);
  const sendInFlightRef = useRef(false);
  const [showMemoModal, setShowMemoModal] = useState(false);
  const memoRef = useRef<HTMLTextAreaElement>(null);
  const [showOUModal, setShowOUModal] = useState(false);
  const [checkingCompact, setCheckingCompact] = useState(false);
  const [privateSendGate, setPrivateSendGate] = useState<
    'unknown' | 'ready' | 'migrate' | 'held' | 'legacy'
  >('unknown');
  const [gateRevision, setGateRevision] = useState(0);
  const migrate = useMigrateBalance({
    activeWallet: activeWallet ?? null,
    networkId,
    publicBalance: balance ?? null,
    privateBalance: privateBalance ?? null,
    showMessage,
    onMigrated: () => {
      setPrivateSendGate('ready');
      setGateRevision((v) => v + 1);
      refreshBalance();
    },
  });
  const [customOU, setCustomOU] = useState('');

  const [proofStep, setProofStep] = useState(-1);
  const [proofElapsed, setProofElapsed] = useState(0);
  const proofTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startProofTimer = () => {
    const start = Date.now();
    setProofElapsed(0);
    if (proofTimerRef.current) clearInterval(proofTimerRef.current);
    proofTimerRef.current = setInterval(() => {
      setProofElapsed(Math.floor((Date.now() - start) / 1000));
    }, 1000);
  };

  const stopProofTimer = () => {
    if (proofTimerRef.current) {
      clearInterval(proofTimerRef.current);
      proofTimerRef.current = null;
    }
    setProofStep(-1);
  };

  const [sendStage, setSendStage] = useState<SendStage>('form');
  const [outcome, setOutcome] = useState<SendOutcome | null>(null);
  const pollCancelledRef = useRef(false);

  useMountEffect(() => {
    pollCancelledRef.current = false;
    return () => {
      pollCancelledRef.current = true;
      if (proofTimerRef.current) clearInterval(proofTimerRef.current);
    };
  });

  const backToForm = (error: unknown) => {
    showMessage(plainError(error, t('toast.sendFailed')), 'error');
    setSendStage('form');
  };

  const undelivered = (error: unknown) =>
    /Receiving end does not exist|Could not establish connection/i.test(String(error));

  /** Once a signed tx may have reached the node the result stays up; History settles it. */
  const afterSendError = (error: unknown, broadcast: boolean) => {
    if (!broadcast) {
      backToForm(error);
      return;
    }
    setSendStage((s) => stageAfterError(true, s));
    refreshBalance();
  };

  const trackBroadcast = (hash: string, pin: NetworkPin) => {
    setOutcome((o) => (o ? { ...o, hash, networkId: pin.networkId } : o));
    setSendStage('pending');
    void pollTxOutcome(hash, (h) => networkService.getTransactionStatus(h, pin), {
      cancelled: () => pollCancelledRef.current,
    }).then((res) => {
      if (pollCancelledRef.current || res.outcome === 'pending') return;
      setOutcome((o) => (o ? { ...o, reason: res.reason ?? null } : o));
      setSendStage(res.outcome);
      refreshBalance();
    });
  };

  const [singleAddress, setSingleAddress] = useState('');
  const [recipientName, setRecipientName] = useState<string | null>(null);
  const [nameCheck, setNameCheck] = useState<Exclude<NameCheck, { kind: 'same' }> | null>(null);
  const [nameChecking, setNameChecking] = useState(false);
  const confirmedToRef = useRef<string | null>(null);
  const setRecipient = (address: string, name: string | null = null) => {
    setSingleAddress(address);
    setRecipientName(name);
    setNameCheck(null);
    confirmedToRef.current = null;
  };
  const addressInvalid = singleAddress.length >= OCT_ADDRESS_LENGTH && !isOctAddress(singleAddress);
  const [singleAmount, setSingleAmount] = useState('');
  const [amountInUsd, setAmountInUsd] = useState(false);
  const [usdInput, setUsdInput] = useState('');
  const amountInputRef = useRef<HTMLInputElement>(null);
  const [memo, setMemo] = useState('');
  const [recipients, setRecipients] = useState([{ address: '', amount: '' }]);

  interface TokenOption {
    symbol: string;
    name: string;
    contractAddress: string | null;
    decimals: number;
    balance: string;
    logoURI?: string;
  }
  const OCT_LOGO =
    'https://cdn.jsdelivr.net/gh/0xio-xyz/Token-lists@main/logos/Octra/Oct_Public.svg';
  const octOption = (): TokenOption => ({
    symbol: 'OCT',
    name: 'Octra',
    contractAddress: null,
    decimals: 6,
    balance: balance || '0',
    logoURI: OCT_LOGO,
  });
  const [selectedToken, setSelectedToken] = useState<TokenOption>(octOption);
  const [availableTokens, setAvailableTokens] = useState<TokenOption[]>(() => [octOption()]);
  const [showTokenPicker, setShowTokenPicker] = useState(false);
  const isCustomToken = selectedToken.contractAddress !== null;
  const amountDecimals = isCustomToken ? selectedToken.decimals : 6;

  const switchMode = (next: 'single' | 'bulk') => {
    setMode(next);
    const asset = assetForMode(next, selectedToken, octOption());
    if (asset !== selectedToken) {
      setSelectedToken(asset);
      setSingleAmount('');
      setUsdInput('');
    }
  };

  // effect:audited - resets FHE mode when custom token selected; resets token when FHE enabled
  useEffect(() => {
    if (isCustomToken && isFHE) {
      setSelectedToken(octOption());
      setSingleAmount('');
    }
  }, [isFHE]);

  // effect:audited - loads available tokens when address/network changes
  useEffect(() => {
    let cancelled = false;
    const loadTokens = async () => {
      if (!activeWallet?.address || !networkId) return;
      const tokens: TokenOption[] = [octOption()];
      const seenAddrs = new Set<string>();
      const targetNetwork = networkCapabilities(networkId).tokenListTag;

      const onChainTokens = await networkService.getTokensByAddress(activeWallet.address);
      const balanceMap = new Map(onChainTokens.map((t) => [t.contractAddress, t]));

      let listedTokens = targetNetwork ? cdnTokenListCache.get(targetNetwork) : [];
      if (!listedTokens && targetNetwork) {
        try {
          const resp = await fetch(
            'https://cdn.jsdelivr.net/gh/0xio-xyz/Token-lists@main/octra.tokenlist.json'
          );
          if (resp.ok) {
            const data = await resp.json();
            listedTokens = (data.tokens || []).filter(
              (t: { network?: string; address?: string; symbol?: string }) =>
                t.network === targetNetwork && t.address && t.symbol !== 'OCT'
            );
            cdnTokenListCache.set(targetNetwork, listedTokens!);
          }
        } catch {}
      }
      for (const lt of listedTokens ?? []) {
        const addr = lt.address;
        if (seenAddrs.has(addr)) continue;
        seenAddrs.add(addr);
        const onChain = balanceMap.get(addr);
        const dec = tokenDecimals(lt.decimals);
        tokens.push({
          symbol: lt.symbol,
          name: lt.name,
          contractAddress: addr,
          decimals: dec,
          balance: tokenBalanceFromRaw(onChain?.balance, dec),
          logoURI: lt.logoURI,
        });
      }

      try {
        const key = `imported_tokens_${networkId}`;
        const result = await chrome.storage.local.get(key);
        const addrs: string[] = result[key] || [];
        for (const addr of addrs) {
          if (seenAddrs.has(addr)) continue;
          seenAddrs.add(addr);
          const onChain = balanceMap.get(addr);
          if (onChain) {
            const dec = tokenDecimals(onChain.decimals);
            tokens.push({
              symbol: onChain.symbol,
              name: onChain.name || onChain.symbol,
              contractAddress: addr,
              decimals: dec,
              balance: tokenBalanceFromRaw(onChain.balance, dec),
            });
          } else {
            try {
              const symbol = await networkService.getContractStorage(addr, 'symbol');
              if (!symbol) continue;
              const name = await networkService.getContractStorage(addr, 'name');
              tokens.push({
                symbol,
                name: name || symbol,
                contractAddress: addr,
                decimals: 6,
                balance: '0',
              });
            } catch {}
          }
        }
      } catch {}

      if (cancelled) return;
      logger.debug(
        `[Send] Loaded ${tokens.length} tokens (${tokens.map((t) => t.symbol).join(', ')})`
      );
      setAvailableTokens(tokens);
      const wanted = entryTokenRef.current;
      if (wanted) {
        entryTokenRef.current = null;
        const hit = tokens.find((tok) => tok.contractAddress === wanted);
        if (hit) setSelectedToken(hit);
      }
    };
    loadTokens();
    return () => {
      cancelled = true;
    };
  }, [activeWallet?.address, networkId]);

  // effect:audited - syncs OCT balance in token list when balance polls, without re-fetching the full list
  useEffect(() => {
    setAvailableTokens((prev) =>
      prev.map((t) => (t.contractAddress === null ? { ...t, balance: balance || '0' } : t))
    );
    setSelectedToken((prev) =>
      prev.contractAddress === null ? { ...prev, balance: balance || '0' } : prev
    );
  }, [balance]);

  const [showAddressDropdown, setShowAddressDropdown] = useState(false);
  const { contacts } = useRecipientContacts(showAddressDropdown, activeWallet?.address);
  const recipientText = recipientName ? nameLabel(recipientName) : singleAddress;
  const nameUnpicked = !recipientName && isNameEntry(singleAddress, networkId);
  const { lookup: nameLookup, retry: retryName } = useNameLookup(
    recipientText,
    networkId,
    showAddressDropdown,
    (name, address) => {
      if (!nameUnpicked) return;
      setRecipient(address, name);
      setShowAddressDropdown(false);
    }
  );
  const dropdownRef = useRef(null);
  const inputRef = useRef(null);
  const tokenPickerRef = useRef(null);

  useMountEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target) &&
        inputRef.current &&
        !inputRef.current.contains(event.target)
      ) {
        setShowAddressDropdown(false);
      }
      if (tokenPickerRef.current && !tokenPickerRef.current.contains(event.target)) {
        setShowTokenPicker(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  });

  const feeOp = feeOpType(isFHE, isCustomToken);
  const feeKey = `${networkId}:${feeOp}`;
  const [pickedFeeKey, setPickedFeeKey] = useState(feeKey);
  if (pickedFeeKey !== feeKey) {
    setPickedFeeKey(feeKey);
    setCustomOU('');
  }
  const sendFee = useLiveFee(feeOp, networkId, sendStage === 'review');
  const liveFee = sendFee.state === 'loading' ? undefined : sendFee.quote;
  const sendOu = resolveSendOu(customOU, liveFee?.recommended);
  const feeReadFailed = !sendOu && liveFee === null && sendFee.state !== 'unsupported';
  const feePresets = feeTiers(liveFee);
  const retryFee = sendFee.retry;
  const feeIsCustom = !!sendOu && sendOu === customOU;

  const sendKind = isFHE ? 'private' : isCustomToken ? 'token' : 'public';
  const singleSpendable = isCustomToken ? selectedToken.balance : isFHE ? privateBalance : balance;
  const singleIssues = sendIssues({
    kind: sendKind,
    to: singleAddress,
    own: activeWallet?.address,
    amount: singleAmount,
    decimals: amountDecimals,
    spendable: singleSpendable,
    publicOct: balance,
    ou: sendOu,
  });
  const bulkCheck = bulkIssues({
    rows: recipients,
    own: activeWallet?.address,
    publicOct: balance,
    ou: sendOu,
  });

  const handleSelectContact = (contact: { address: string; name: string; id: string }) => {
    setRecipient(contact.address);
    setShowAddressDropdown(false);
  };

  const addRecipient = () => {
    if (recipients.length < 5) setRecipients([...recipients, { address: '', amount: '' }]);
  };

  const updateRecipient = (index: number, field: 'address' | 'amount', value: string) => {
    const newRecipients = [...recipients];
    newRecipients[index][field] = value;
    setRecipients(newRecipients);
  };

  const removeRecipient = (index: number) => {
    if (recipients.length > 1) {
      setRecipients(recipients.filter((_, i) => i !== index));
    }
  };

  const validateSingle = () => {
    if (!isOctAddress(singleAddress)) {
      showMessage(t('toast.addressInvalid'), 'error');
      return false;
    }
    if (singleIssues.self) {
      showMessage(t('send.selfSend'), 'error');
      return false;
    }
    if (isFHE && privateBalance === null) {
      showMessage(t('toast.privateLoading'), 'error');
      return false;
    }
    if (!isValidAmount(singleAmount, amountDecimals)) {
      showMessage(t('toast.amountInvalid'), 'error');
      return false;
    }
    if (singleIssues.noFee) {
      showMessage(t('send.feeUnavailable'), 'error');
      if (feeReadFailed) retryFee();
      return false;
    }
    if (singleSpendable === null || singleIssues.overBalance) {
      showMessage(t('toast.err.balance'), 'error');
      return false;
    }
    if (sendKind !== 'public' && (balance === null || singleIssues.feeShort)) {
      showMessage(t('send.feeShort'), 'error');
      return false;
    }
    return true;
  };

  const validateBulk = () => {
    const validRecipients = recipients.filter((r) => r.address && r.amount);
    if (isCustomToken) return false;
    if (validRecipients.length === 0) {
      showMessage(t('send.addRecipient'), 'error');
      return false;
    }
    if (validRecipients.length !== recipients.filter((r) => r.address || r.amount).length) {
      showMessage(
        t('send.bulkIncompleteRow', { defaultValue: 'Each row needs an address and an amount' }),
        'error'
      );
      return false;
    }
    if (validRecipients.some((r) => !isOctAddress(r.address))) {
      showMessage(t('toast.addressInvalid'), 'error');
      return false;
    }
    if (bulkCheck.self) {
      showMessage(t('send.selfSend'), 'error');
      return false;
    }
    if (validRecipients.some((r) => !isValidAmount(r.amount, 6))) {
      showMessage(t('toast.amountInvalid'), 'error');
      return false;
    }
    if (bulkCheck.noFee) {
      showMessage(t('send.feeUnavailable'), 'error');
      if (feeReadFailed) retryFee();
      return false;
    }
    if (balance === null || bulkCheck.overBalance) {
      showMessage(t('toast.err.balance'), 'error');
      return false;
    }
    return true;
  };

  const handleNormalSend = async () => {
    if (!validateSingle()) {
      sendInFlightRef.current = false;
      setSendStage('form');
      return;
    }
    const ou = sendOu!;
    setIsSending(true);
    setSendStage('sending');

    if (isCustomToken) {
      logger.debug('[Send] Starting token transfer:', {
        token: selectedToken.symbol,
        contract: selectedToken.contractAddress,
        to: singleAddress,
        amount: singleAmount,
        decimals: selectedToken.decimals,
        ou,
      });
      try {
        if (recipientName) assertNamedSend(singleAddress, confirmedToRef.current);
        // The network and wallet the review showed. A switch since then refuses the send.
        const scope = await captureTxScope(activeWallet.address, networkId);
        const rawAmount = toUnits(singleAmount, selectedToken.decimals);
        const txHash = await networkService.contractCall(
          selectedToken.contractAddress!,
          'transfer',
          [singleAddress, String(rawAmount)],
          activeWallet.address,
          activeWallet.privateKey,
          ou,
          scope
        );
        logger.debug('[Send] Token transfer success:', txHash);
        trackBroadcast(txHash, scope);
      } catch (error: unknown) {
        logger.error('[Send] Token transfer error:', error);
        afterSendError(error, mayHaveBroadcast(error));
      } finally {
        sendInFlightRef.current = false;
        setIsSending(false);
      }
      return;
    }

    logger.debug('[Send] Starting single send:', {
      to: singleAddress,
      amount: singleAmount,
      memo: !!memo,
      ou,
    });
    try {
      if (recipientName) assertNamedSend(singleAddress, confirmedToRef.current);
      const scope = await captureTxScope(activeWallet.address, networkId);
      const result = await networkService.sendTransaction({
        from: activeWallet.address,
        to: singleAddress,
        amount: singleAmount,
        privateKey: activeWallet.privateKey,
        publicKey: activeWallet.publicKey,
        message: memo,
        ou,
        scope,
      });
      logger.debug('[Send] Single send result:', {
        success: result.success,
        txHash: result.txHash,
        outcomeUnknown: !!result.outcomeUnknown,
      });
      if (result.success && result.txHash) trackBroadcast(result.txHash, scope);
      else if (result.success || result.outcomeUnknown) afterSendError('', true);
      else afterSendError(result.error, false);
    } catch (error: unknown) {
      logger.error('[Send] Single send error:', error);
      backToForm(error);
    } finally {
      sendInFlightRef.current = false;
      setIsSending(false);
    }
  };

  const handlePrivateSend = async () => {
    // Read the network here rather than trusting the toggle: it can be older than a switch.
    if (!networkCapabilities(networkId).privacy) {
      backToForm(
        new PlainError(t('toast.noPrivacyHere', { network: getNetworkConfig(networkId).name }))
      );
      sendInFlightRef.current = false;
      return;
    }
    if (!validateSingle()) {
      sendInFlightRef.current = false;
      setSendStage('form');
      return;
    }
    const ou = sendOu!;
    setIsSending(true);
    setSendStage('sending');
    setProofStep(0);
    startProofTimer();
    await passwordManager.suppressAutoLock();
    logger.debug(
      `[PrivateSend] Starting: to=${singleAddress}, amount=${singleAmount} OCT, from=${activeWallet.address}`
    );

    let handedOff = false;
    let refused = false;
    try {
      if (recipientName) assertNamedSend(singleAddress, confirmedToRef.current);
      const scope = await captureTxScope(activeWallet.address, networkId);
      await assertTxScope(scope);
      const sendT0 = Date.now();
      setProofStep(0);
      const amountRaw = Number(toUnits(singleAmount, 6));
      logger.debug(`[PrivateSend] amountRaw=${amountRaw}`);

      logger.debug('[PrivateSend] starting PVAC init + network fetch in parallel...');
      const pvacReady = pvacManager.initialize(activeWallet.privateKey);

      let pubKey = activeWallet.publicKey;
      if (!pubKey) {
        cryptoManager.setPrivateKey(activeWallet.privateKey);
        pubKey = cryptoManager.getPublicKey();
      }

      const netT0 = Date.now();
      const [viewPubB64, ebal, publicBal] = await Promise.all([
        privacyNetworkService.getViewPubkey(singleAddress),
        privacyNetworkService.getEncryptedBalanceDevnet(
          activeWallet.address,
          activeWallet.privateKey,
          pubKey
        ),
        networkService.getBalance(activeWallet.address, false, scope),
      ]);
      logger.debug(
        `[PrivateSend] network fetch done in ${Date.now() - netT0}ms (viewPub=${!!viewPubB64}, balance=${ebal.encryptedRaw})`
      );

      const publicUnits = amountUnits(publicBal.balance, 6);
      if (publicUnits === null || BigInt(ou) > publicUnits) {
        throw new PlainError(
          t('send.feeShortDetail', {
            fee: fromUnits(ou, 6),
            have: fromUnits(publicUnits ?? 0n, 6),
            defaultValue:
              'Insufficient public OCT for network fee. Required {{fee}} OCT, available {{have}} OCT.',
          })
        );
      }

      if (!viewPubB64) {
        throw new PlainError(t('toast.recipientNoPrivate'));
      }
      if (!ebal.success) {
        throw new Error(ebal.error || 'Failed to fetch encrypted balance');
      }
      if (!ebal.cipher) throw new PlainError(t('toast.noPrivateBalance'));
      if (ebal.encryptedRaw < amountRaw) {
        throw new PlainError(t('toast.privateShort'));
      }

      const { ephSk, ephPub } = generateEphemeralKeypair();
      const recipientViewPub = base64ToBytes(viewPubB64);
      const shared = await ecdhSharedSecret(ephSk, recipientViewPub);
      const [tag, claimSecret] = await Promise.all([
        computePrivateTag(shared),
        computeClaimSecret(shared),
      ]);
      const tagHex = bytesToHex(tag);
      const claimPubHex = bytesToHex(await computeClaimPub(claimSecret, singleAddress));
      logger.debug('[PrivateSend] setup done: eph =', bytesToBase64(ephPub).slice(0, 24) + '..');

      setProofStep(1);
      await pvacReady;

      await pvacManager.verifyRegistration(
        activeWallet.address,
        activeWallet.privateKey,
        activeWallet.publicKey,
        privacyNetworkService,
        false,
        scope.networkId
      );

      const policy = await proofPolicyFor(activeWallet.address, scope);
      const rBlind = crypto.getRandomValues(new Uint8Array(32));
      const encAmount = await encryptPrivateAmount(shared, amountRaw, rBlind);
      const { cipherBytes: ctDelta, commitmentBytes } =
        await pvacManager.encryptRawAsync(amountRaw);
      const deltaCipherStr = pvacManager.encodeCipher(ctDelta);
      const commitmentB64 = bytesToBase64(commitmentBytes);

      const currentCtBytes = pvacManager.getCipherBytes(ebal.cipher);

      if (currentCtBytes.length > 500_000) {
        logger.warn(
          `[PrivateSend] Balance cipher bloated (${(currentCtBytes.length / 1024).toFixed(0)}KB, ${ebal.cipher.length} chars) - using as-is (server must match)`
        );
      }

      const newBalanceCtBytes = await pvacManager.ctSubRawAsync(currentCtBytes, ctDelta);
      const newBalanceVal = ebal.encryptedRaw - amountRaw;
      logger.debug(
        `[PrivateSend] encrypted: ctDelta=${ctDelta.length}B, currentBal=${currentCtBytes.length}B, newBal=${newBalanceCtBytes.length}B, amount=${amountRaw}, newBalVal=${newBalanceVal}`
      );
      logger.debug(`[PrivateSend] balance cipher from RPC: ${ebal.cipher.slice(0, 40)}...`);

      try {
        const [diagRpcBal, diagDeltaEnc, diagNewBal] = await Promise.all([
          pvacManager.diagnoseCipher(currentCtBytes).catch(() => '<unavailable>'),
          pvacManager.diagnoseCipher(ctDelta).catch(() => '<unavailable>'),
          pvacManager.diagnoseCipher(newBalanceCtBytes).catch(() => '<unavailable>'),
        ]);
        logger.debug(`[PrivateSend] DIAG rpc_balance: ${diagRpcBal}`);
        logger.debug(`[PrivateSend] DIAG delta_enc: ${diagDeltaEnc}`);
        logger.debug(`[PrivateSend] DIAG new_balance (ct_sub result): ${diagNewBal}`);
        logger.debug(
          `[PrivateSend] Wire format versions: rpc_bal=0x${currentCtBytes[4]?.toString(16)}, delta=0x${ctDelta[4]?.toString(16)}, newBal=0x${newBalanceCtBytes[4]?.toString(16)}`
        );
      } catch (diagErr) {
        logger.warn('[PrivateSend] Diagnostic failed (non-fatal):', diagErr);
      }

      const rpT0 = Date.now();
      logger.debug(
        `[PrivateSend] starting parallel range proofs (delta=${amountRaw}, balance=${newBalanceVal})...`
      );

      setProofStep(2);
      // Bound range proofs (webcli make_bound_range_proof) - the amount stays hidden in a
      // self-carried commitment, and each proof is ~60KB vs the 2.8MB per-bit range proof.
      const [rpDeltaStr, rpBalanceStr, sendZeroProof] = await Promise.all([
        pvacManager.makeBoundRangeProof(ctDelta, amountRaw, policy),
        pvacManager.makeBoundRangeProof(newBalanceCtBytes, newBalanceVal, policy),
        // Bound zero proof for stealth send (consensus requires this)
        pvacManager.makeBoundProof(ctDelta, amountRaw, rBlind, policy),
      ]);

      logger.debug(
        `[PrivateSend] proofs done in ${((Date.now() - rpT0) / 1000).toFixed(1)}s - delta=${rpDeltaStr.length} chars, balance=${rpBalanceStr.length} chars`
      );
      setProofStep(3);

      logger.debug('[PrivateSend] computing Pedersen commitment...');
      const amountCommitmentB64 = await pvacManager.pedersenCommitAsync(amountRaw, rBlind);
      logger.debug(
        `[PrivateSend] Pedersen commitment done: ${amountCommitmentB64.slice(0, 20)}...`
      );

      logger.debug(`[PrivateSend] send_zero_proof done: ${sendZeroProof.slice(0, 20)}...`);

      const privateTransferData = JSON.stringify({
        version: 5,
        delta_cipher: deltaCipherStr,
        commitment: commitmentB64,
        range_proof_delta: rpDeltaStr,
        range_proof_balance: rpBalanceStr,
        eph_pub: bytesToBase64(ephPub),
        stealth_tag: tagHex,
        enc_amount: encAmount,
        claim_pub: claimPubHex,
        amount_commitment: amountCommitmentB64,
        send_zero_proof: sendZeroProof,
      });
      logger.debug(
        `[PrivateSend] privateTransferData built: ${privateTransferData.length} chars (v5)`
      );

      logger.debug('[PrivateSend] fetching nonce and building transaction...');
      // Minutes of proof work later: still the network and wallet this send was built for?
      await assertTxScope(scope);
      await requireProofPolicy(policy, activeWallet.address, scope);
      const nonce = await networkService.getNextNonce(activeWallet.address, scope);
      logger.debug(`[PrivateSend] nonce=${nonce}, signing transaction...`);
      const signedTx = await privacyNetworkService.buildPrivateTransaction({
        from: activeWallet.address,
        nonce,
        privateKey: activeWallet.privateKey,
        publicKey: activeWallet.publicKey,
        privateTransferData,
        ou,
      });
      logger.debug(`[PrivateSend] transaction signed, queuing...`);

      const txId = crypto.randomUUID();
      logger.debug(`[PrivateSend] Queuing private transaction: txId=${txId}`);
      handedOff = true;
      const response = await chrome.runtime.sendMessage({
        type: 'QUEUE_TRANSACTION',
        transaction: {
          txId,
          opType: 'stealth',
          type: 'broadcast_only',
          signedTransaction: signedTx,
          from: activeWallet.address,
          to: singleAddress,
          amount: parseFloat(singleAmount),
          scope,
        },
      });
      logger.debug('[PrivateSend] Queue response:', response);

      if (response?.success) {
        logger.debug(
          `[PrivateSend] SUCCESS - total elapsed: ${((Date.now() - sendT0) / 1000).toFixed(1)}s`
        );
        setSendStage('done');
        privacyNetworkService.clearDecryptCache();
        setTimeout(() => refreshBalance(undefined, undefined, true), 8000);
      } else {
        logger.error('[PrivateSend] Queue failed:', response?.error);
        if (response?.errorType) {
          refused = true;
          networkService.releaseNonce(activeWallet.address, nonce, scope.networkId);
        } else {
          privacyNetworkService.clearDecryptCache();
        }
        throw new Error(response?.error || 'Private transfer failed');
      }
    } catch (error) {
      logger.error('[PrivateSend] Error:', error);
      afterSendError(error, handedOff && !refused && !undelivered(error));
    } finally {
      stopProofTimer();
      sendInFlightRef.current = false;
      setIsSending(false);
      passwordManager.resumeAutoLock();
    }
  };

  const storeBulkPending = (tx: SignedTransaction, hash: string | null, scope: TxScope) =>
    networkService.storePendingTransaction({
      from: tx.from,
      to: tx.to_,
      amount: Number(fromUnits(tx.amount, 6)),
      nonce: tx.nonce,
      hash: hash ?? undefined,
      message: tx.message || '',
      timestamp: Date.now(),
      type: 'outgoing',
      opType: 'transfer',
      confirmed: false,
      pending: true,
      network: scope.networkId,
    });

  const handleBulkSubmit = async () => {
    if (!validateBulk()) {
      sendInFlightRef.current = false;
      setSendStage('form');
      return;
    }
    const ou = sendOu!;
    setIsSending(true);
    setSendStage('sending');
    const rows = recipients.filter((r) => r.address && r.amount);
    const total = rows.length;
    logger.debug('[BulkSend] Starting bulk send:', { count: total, ou });

    let reserved: { first: number; scope: TxScope } | null = null;
    let handedOff = false;
    try {
      const scope = await captureTxScope(activeWallet.address, networkId);
      await assertTxScope(scope);
      // One reservation for the whole batch, so no other send takes a nonce inside it.
      const first = await networkService.reserveNonceRange(scope, total);
      reserved = { first, scope };
      logger.debug('[BulkSend] Nonces:', first, 'to', first + total - 1);

      const signed: SignedTransaction[] = [];
      for (const [i, r] of rows.entries()) {
        signed.push(
          await networkService.buildAndSignTransaction({
            from: activeWallet.address,
            to: r.address,
            amount: toUnits(r.amount, 6).toString(),
            nonce: first + i,
            ou,
            publicKey: activeWallet.publicKey,
            privateKey: activeWallet.privateKey,
            message: memo,
          })
        );
      }

      handedOff = true;
      const batch = await networkService.broadcastBatchTransaction(signed, scope);
      logger.debug('[BulkSend] Batch result:', {
        success: batch.success,
        outcomeUnknown: !!batch.outcomeUnknown,
        accepted: batch.accepted,
        rejected: batch.rejected,
        results: batch.results,
      });
      if (batch.outcomeUnknown) {
        await Promise.all(signed.map((tx) => storeBulkPending(tx, null, scope)));
        setOutcome((o) => (o ? { ...o, count: total, sent: 0 } : o));
        setSendStage('pending');
        refreshBalance();
        return;
      }
      if (!batch.success || bulkStage(batch.accepted, total) === null) {
        handedOff = false;
        const reasons = batch.results
          .filter((r) => r.status === 'rejected')
          .map((r) => r.error?.reason || 'unknown')
          .join('; ');
        throw new Error(batch.error || `Batch failed: ${reasons}`);
      }

      const accepted = batch.results.filter((r) => r.status === 'accepted');
      const hashes: string[] = [];
      let lastAccepted = -1;
      for (const res of accepted) {
        const hash = res.tx_hash || res.hash || null;
        const tx = signed.find((s) => s.nonce === res.nonce);
        if (tx) await storeBulkPending(tx, hash, scope);
        if (hash) hashes.push(hash);
        if (typeof res.nonce === 'number') lastAccepted = Math.max(lastAccepted, res.nonce);
      }
      const last = first + total - 1;
      if (lastAccepted >= first && lastAccepted < last) {
        networkService.releaseNonceRange(
          activeWallet.address,
          lastAccepted + 1,
          last - lastAccepted,
          scope.networkId
        );
      }

      setOutcome((o) => (o ? { ...o, count: total, sent: 0 } : o));
      setSendStage('pending');
      refreshBalance();
      const unhashed: PollOutcome[] = Array(Math.max(0, batch.accepted - hashes.length)).fill(
        'pending'
      );
      void Promise.all(
        hashes.map((h) =>
          pollTxOutcome(h, (x) => networkService.getTransactionStatus(x, scope), {
            cancelled: () => pollCancelledRef.current,
          })
        )
      ).then((polled) => {
        if (pollCancelledRef.current) return;
        const settled = bulkPollStage([...polled.map((p) => p.outcome), ...unhashed], total);
        setOutcome((o) => (o ? { ...o, sent: settled.sent } : o));
        if (settled.stage === 'pending') return;
        setSendStage(settled.stage);
        refreshBalance();
      });
    } catch (error) {
      logger.error('[BulkSend] Error:', error);
      if (!handedOff && reserved) {
        networkService.releaseNonceRange(
          activeWallet.address,
          reserved.first,
          total,
          reserved.scope.networkId
        );
      }
      afterSendError(error, handedOff);
    } finally {
      sendInFlightRef.current = false;
      setIsSending(false);
    }
  };

  const handleMainAction = () => {
    if (isSending || sendInFlightRef.current) return;
    sendInFlightRef.current = true;

    if (isFHE) {
      if (mode === 'single') handlePrivateSend();
      else sendInFlightRef.current = false;
      return;
    }

    if (mode === 'single') handleNormalSend();
    else handleBulkSubmit();
  };

  // A review belongs to the network and wallet it was opened on: a switch closes it.
  const reviewScope = `${networkId}:${activeWallet?.address ?? ''}`;
  const [shownScope, setShownScope] = useState(reviewScope);
  if (shownScope !== reviewScope) {
    setShownScope(reviewScope);
    if (sendStage === 'review') setSendStage('form');
  }

  // effect:audited - resolve the private-send gate when Private mode is selected, so the button
  // reads "Migrate balance" up front instead of only discovering the state at review
  // click. Re-resolves on balance changes; handleReview's fresh check stays the authority.
  useEffect(() => {
    if (!isFHE || !activeWallet?.privateKey) {
      setPrivateSendGate('unknown');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        if (pvacLegacy) {
          if (!cancelled) setPrivateSendGate('legacy');
          return;
        }
        const { held, canMigrate } = await privateSpendHeld();
        if (held) {
          if (!cancelled) setPrivateSendGate(canMigrate ? 'migrate' : 'held');
          return;
        }
        const needs = await privateSpendNeedsCompact();
        if (!cancelled) setPrivateSendGate(needs ? 'migrate' : 'ready');
      } catch {
        if (!cancelled) setPrivateSendGate('ready');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isFHE, privateBalance, activeWallet?.address, pvacLegacy, gateRevision]);

  if (isWatchOnly) {
    return (
      <div className="w-full! h-full! flex! flex-col! bg-(--bg)!">
        <Header title={t('send.title')} showBack showSettings={false} />
        <div
          className="flex-1! flex! flex-col! items-center! justify-center! text-center!"
          style={{ padding: '32px', gap: '6px' }}
        >
          <h2 style={{ fontSize: '15px', fontWeight: 600, color: 'var(--fg)' }}>
            {t('send.watchOnly')}
          </h2>
          <Button onClick={() => navigate('/walletlist')} variant="secondary" className="mt-3!">
            {t('send.switchWallet')}
          </Button>
        </div>
      </div>
    );
  }

  const privateSpendNeedsCompact = async (): Promise<boolean> => {
    try {
      if (!activeWallet?.privateKey) return false;
      const pin = await resolveNetworkPin(networkId);
      await pvacManager.initialize(activeWallet.privateKey);
      const cipher = await privacyNetworkService.fetchCipherOnly(
        activeWallet.address,
        activeWallet.privateKey,
        activeWallet.publicKey || '',
        pin
      );
      if (!cipher) return false;
      const bytes = pvacManager.getCipherBytes(cipher);
      const check = await pvacManager.checkBoundProvable(bytes);
      const layers = check ? check.baseLayers : await pvacManager.baseLayerCount(bytes);
      return layers >= 4;
    } catch {
      return false;
    }
  };

  const privateSpendHeld = async (): Promise<{ held: boolean; canMigrate: boolean }> => {
    try {
      if (!activeWallet?.privateKey) return { held: false, canMigrate: false };
      const pin = await resolveNetworkPin(networkId);
      const mig = await networkService.getPvacMigrationStatus(activeWallet.address, pin);
      const isV3 = mig?.cipher_class === 'v3' || mig?.cipher_class === 'key_bound';
      if (!isV3 || mig?.can_key_switch !== false) return { held: false, canMigrate: false };
      const cipher = await privacyNetworkService.fetchCipherOnly(
        activeWallet.address,
        activeWallet.privateKey,
        activeWallet.publicKey || '',
        pin
      );
      if (!cipher) return { held: false, canMigrate: false };
      const bytes = pvacManager.getCipherBytes(cipher);
      const check = await pvacManager.checkBoundProvable(bytes);
      const layers = check ? check.baseLayers : await pvacManager.baseLayerCount(bytes);
      const stuck = layers >= 4;
      return { held: stuck, canMigrate: stuck && mig?.can_v3_migrate === true };
    } catch {
      return { held: false, canMigrate: false };
    }
  };

  const opsState =
    !isFHE || mode !== 'single'
      ? 'ready'
      : resolvePrivacyOpsState({
          upgrading: migrate.upgrading,
          migrating: migrate.verifying,
          legacy: privateSendGate === 'legacy',
          heldNoMigration: privateSendGate === 'held',
          needsMigrate: privateSendGate === 'migrate',
          checking: checkingCompact || privateSendGate === 'unknown',
        });

  const handleReview = async () => {
    if (!feeIsCustom && sendOu && !(await sendFee.fresh())) {
      showMessage(t('send.feeUnavailable'), 'error');
      return;
    }
    if (mode === 'single' && !validateSingle()) return;
    if (mode === 'bulk' && !validateBulk()) return;
    if (mode === 'single' && recipientName) {
      const check = await checkNamedRecipient(
        { name: recipientName, address: singleAddress },
        { at: await resolveNetworkPin(networkId), fresh: false }
      );
      if (check.kind === 'stopped') {
        showMessage(nameReasonText(t, check.reason), 'error');
        return;
      }
      setNameCheck(check.kind === 'changed' ? check : null);
    }
    if (isFHE && mode === 'single') {
      if (pvacLegacy) {
        showMessage(t('toast.legacyPaused'), 'error');
        return;
      }
      setCheckingCompact(true);
      const holdState = await privateSpendHeld();
      if (holdState.held) {
        setCheckingCompact(false);
        setPrivateSendGate(holdState.canMigrate ? 'migrate' : 'held');
        showMessage(
          holdState.canMigrate ? t('toast.migrateFirst') : t('toast.awaitingMigration'),
          'error'
        );
        return;
      }
      const needs = await privateSpendNeedsCompact();
      if (needs) {
        setCheckingCompact(false);
        showMessage(t('toast.migrateFirst'), 'error');
        setPrivateSendGate('migrate');
        return;
      }
      setCheckingCompact(false);
    }
    setSendStage('review');
  };

  const recheckName = async (): Promise<string | null> => {
    if (!recipientName) return null;
    setNameChecking(true);
    let check: NameCheck;
    try {
      check = await checkNamedRecipient(
        { name: recipientName, address: singleAddress },
        { at: await resolveNetworkPin(networkId), fresh: true }
      );
    } catch {
      check = { kind: 'stopped', reason: 'unavailable' };
    } finally {
      setNameChecking(false);
    }
    if (check.kind === 'same') {
      setNameCheck(null);
      return check.address;
    }
    setNameCheck(check);
    return null;
  };

  const acceptNewAddress = () => {
    if (nameCheck?.kind !== 'changed') return;
    setSingleAddress(nameCheck.now);
    setNameCheck(null);
    confirmedToRef.current = null;
  };

  const handleConfirmFromReview = async () => {
    if (isSending || sendInFlightRef.current || nameCheck) return;
    sendInFlightRef.current = true;
    const feeOk = feeIsCustom || !!(await sendFee.fresh());
    if (!feeOk) {
      sendInFlightRef.current = false;
      showMessage(t('send.feeUnavailable'), 'error');
      return;
    }
    confirmedToRef.current = null;
    if (mode === 'single' && recipientName) {
      const named = await recheckName();
      if (named !== singleAddress) {
        sendInFlightRef.current = false;
        return;
      }
      confirmedToRef.current = named;
    }
    sendInFlightRef.current = false;
    setOutcome({
      kind: mode === 'bulk' ? 'bulk' : isFHE ? 'private' : 'public',
      amount: mode === 'bulk' ? bulkTotal : singleAmount,
      symbol: isFHE ? 'OCT' : symbol,
      to: singleAddress,
      networkId,
      hash: null,
      reason: null,
      count: validRecipients.length,
      sent: 0,
    });
    handleMainAction();
  };

  const validRecipients = recipients.filter((r) => r.address && r.amount);
  const bulkTotal = fromUnits(bulkTotalUnits(validRecipients), 6);
  const feeOct = sendOu ? fromUnits(sendOu, 6) : null;
  const canSwitchToken = !isFHE && availableTokens.length > 1;
  const symbol = isFHE ? 'pOCT' : isCustomToken ? selectedToken.symbol : 'OCT';
  const amountUsd = isCustomToken
    ? null
    : tokenPrices.getUsdValue('OCT', parseFloat(singleAmount) || 0);
  const availableText =
    singleSpendable !== null ? displayAmount(singleSpendable, amountDecimals) : '---';

  const octPrice = isCustomToken ? 0 : tokenPrices.getPrice('OCT') || 0;
  const canToggleUsd = octPrice > 0;
  const amountDisplay = formatAmountDisplay(amountInUsd ? usdInput : singleAmount);
  const amountFont = amountFontSize(amountDisplay);
  const amountExceeds = singleIssues.overBalance;
  const bulkExceeds = bulkCheck.overBalance;
  const sendBlocked =
    isSending ||
    !sendOu ||
    (mode === 'single' && nameUnpicked) ||
    (mode === 'bulk'
      ? bulkExceeds || bulkCheck.self
      : amountExceeds || singleIssues.feeShort || singleIssues.self);

  const setAmountFrom = (raw: string) => {
    if (amountInUsd) {
      setUsdInput(raw);
      setSingleAmount(raw && octPrice > 0 ? toFixedTrim(parseFloat(raw) / octPrice, 6) : '');
    } else {
      setSingleAmount(raw);
    }
  };

  const handleAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const el = e.target;
    let value = el.value;
    let caret = el.selectionStart ?? value.length;
    // The field's own commas group thousands; a comma the person types is their decimal point.
    if ((e.nativeEvent as InputEvent).data === ',' && value[caret - 1] === ',') {
      value = `${value.slice(0, caret - 1)}.${value.slice(caret)}`;
    }
    const raw = cleanAmountInput(parseAmountInput(value), amountInUsd ? 2 : amountDecimals);
    if (raw === null) return;
    caret = Math.min(caret, value.length);
    const before = parseAmountInput(value.slice(0, caret)).replace(/^0+(?=\d)/, '').length;
    setAmountFrom(raw);
    const pos = caretAfterDigits(formatAmountDisplay(raw), before);
    requestAnimationFrame(() => el.setSelectionRange(pos, pos));
  };

  const handleAmountPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const raw = cleanAmountInput(e.clipboardData.getData('text'), amountInUsd ? 2 : amountDecimals);
    if (raw === null) {
      showMessage(t('toast.amountInvalid'), 'error');
      return;
    }
    setAmountFrom(raw);
  };

  const maxAmount = maxSendable(sendKind, singleSpendable, amountDecimals, sendOu);
  const handleMax = () => {
    const oct = maxAmount;
    if (oct === null) return;
    setSingleAmount(oct);
    if (amountInUsd) setUsdInput(octPrice > 0 ? toFixedTrim(parseFloat(oct) * octPrice, 2) : '');
  };

  const toggleAmountUnit = () => {
    if (!canToggleUsd) return;
    if (amountInUsd) {
      setAmountInUsd(false);
    } else {
      setUsdInput(singleAmount ? toFixedTrim(parseFloat(singleAmount) * octPrice, 2) : '');
      setAmountInUsd(true);
    }
    requestAnimationFrame(() => amountInputRef.current?.focus());
  };

  if (
    outcome &&
    (isResultStage(sendStage) || (sendStage === 'sending' && outcome.kind === 'private'))
  ) {
    const toShort = t('evmSend.toShort', { defaultValue: 'to' });
    const amountLine = `${trimAmount(outcome.amount)} ${outcome.symbol} ${toShort} ${
      outcome.kind === 'private'
        ? t('sendReview.stealth', { defaultValue: 'Stealth address' })
        : middleCut(outcome.to, 6, 4)
    }`;
    const proofLabel = PROOF_STEPS[Math.max(0, proofStep)].label;
    const elapsed = `${Math.floor(proofElapsed / 60)}:${String(proofElapsed % 60).padStart(2, '0')}`;
    const privateSending = outcome.kind === 'private' && sendStage === 'sending';
    const title = privateSending
      ? t('sendResult.sendingPrivately', { defaultValue: 'Sending privately' })
      : outcome.kind === 'private'
        ? t('sendResult.queued', { defaultValue: 'Queued' })
        : sendStage === 'pending'
          ? t('evmSend.pending', { defaultValue: 'Sending' })
          : sendStage === 'done'
            ? t('evmSend.sent', { defaultValue: 'Sent' })
            : outcome.kind === 'bulk'
              ? t('sendResult.someFailed', { defaultValue: 'Some transfers failed' })
              : t('evmSend.failed', { defaultValue: 'Failed' });
    const line = privateSending
      ? `${proofLabel} (${elapsed})`
      : outcome.kind === 'bulk'
        ? sendStage !== 'failed'
          ? t('sendResult.transfers', {
              count: outcome.count,
              defaultValue: '{{count}} transfers',
            })
          : t('sendResult.transfersPartial', {
              sent: outcome.sent,
              count: outcome.count,
              defaultValue: '{{sent}} of {{count}} transfers sent',
            })
        : sendStage === 'failed' && outcome.reason
          ? outcome.reason
          : amountLine;
    return (
      <SendResult
        mood={privateSending ? 'encrypt' : sendStage === 'pending' ? 'loading' : 'awake'}
        title={title}
        line={line}
        note={
          privateSending
            ? pvacManager.hasDesktopApp && proofStep === 2
              ? 'Generating range proofs via 0xio Desktop. Keep this window open.'
              : t('sendResult.keepOpen', { defaultValue: 'Keep this window open.' })
            : null
        }
        link={
          outcome.kind === 'public' && outcome.hash
            ? octraTxUrl(outcome.networkId, outcome.hash)
            : null
        }
        onDone={() => navigate('/', { replace: true })}
        doneDisabled={privateSending}
      />
    );
  }

  const isBulkReview = mode === 'bulk';
  const reviewAmount = trimAmount(isBulkReview ? bulkTotal : singleAmount || '0');
  const reviewUsd = isCustomToken
    ? null
    : tokenPrices.getUsdValue('OCT', parseFloat(isBulkReview ? bulkTotal : singleAmount) || 0);
  const reviewTxCount = BigInt(isBulkReview ? Math.max(1, validRecipients.length) : 1);
  const reviewFeeUnits = sendOu ? BigInt(sendOu) * reviewTxCount : 0n;
  const reviewFee = fromUnits(reviewFeeUnits, 6);
  const reviewAmountUnits = amountUnits(isBulkReview ? bulkTotal : singleAmount, 6) ?? 0n;
  const reviewTotal =
    isCustomToken || isFHE
      ? `${reviewAmount} ${symbol} + ${reviewFee} OCT`
      : `${fromUnits(reviewAmountUnits + reviewFeeUnits, 6)} OCT`;
  const reviewMemo = (!isCustomToken && !isFHE && memo) || '';
  const networkLabel =
    networkId === 'devnet'
      ? 'Octra Devnet'
      : networkId.startsWith('custom')
        ? 'Custom'
        : 'Octra Mainnet';

  return (
    <div className="w-full! h-full! flex! flex-col! bg-(--bg)! relative! overflow-hidden!">
      <Header title={t('send.title')} showBack showSettings={false} />

      <div
        className="shrink-0! flex! items-center! justify-between!"
        style={{ padding: '0 var(--gutter) 6px' }}
      >
        <div className="flex! items-center!" style={{ gap: '14px' }}>
          <TextTab active={!isFHE} onClick={() => setIsFHE(false)}>
            Normal
          </TextTab>
          <TextTab
            active={isFHE}
            onClick={() => {
              if (!privacyHere) {
                showMessage(
                  t('toast.noPrivacyHere', { network: getNetworkConfig(networkId).name }),
                  'error'
                );
                return;
              }
              setIsFHE(true);
            }}
          >
            Private
          </TextTab>
        </div>
        <div className="flex! items-center!" style={{ gap: '12px' }}>
          <TextTab small active={mode === 'single'} onClick={() => switchMode('single')}>
            {t('send.single')}
          </TextTab>
          <TextTab small active={mode === 'bulk'} onClick={() => switchMode('bulk')}>
            {t('send.bulk')}
          </TextTab>
        </div>
      </div>

      <Sheet
        open={sendStage === 'review' || (sendStage === 'sending' && outcome?.kind !== 'private')}
        onClose={() => setSendStage('form')}
        dismissible={sendStage === 'review'}
        title={
          isBulkReview
            ? t('sendReview.titleBulk', { defaultValue: 'Review bulk send' })
            : isFHE
              ? t('sendReview.titlePrivate', { defaultValue: 'Review private send' })
              : t('evmSend.reviewTitle', { defaultValue: 'Review send' })
        }
        footer={
          <ReviewFooter
            onBack={() => setSendStage('form')}
            onSend={handleConfirmFromReview}
            sending={sendStage === 'sending' || nameChecking}
            disabled={!!nameCheck}
          />
        }
      >
        <ReviewAmount amount={reviewAmount} symbol={symbol} usd={reviewUsd} />
        {!isBulkReview && recipientName && (
          <NameToCard
            name={recipientName}
            address={singleAddress}
            check={nameCheck}
            onUseNew={acceptNewAddress}
            onRetry={() => void recheckName()}
          />
        )}
        <ReviewCard>
          {isBulkReview ? (
            <>
              <ReviewRow
                label={t('sendReview.recipients', {
                  count: validRecipients.length,
                  defaultValue: '{{count}} recipients',
                })}
                value={`${reviewAmount} ${symbol}`}
              />
              {validRecipients.map((r, i) => (
                <ReviewRow
                  key={i}
                  caps={false}
                  label={middleCut(r.address, 8, 6)}
                  value={`${trimAmount(r.amount)} ${symbol}`}
                />
              ))}
            </>
          ) : (
            <>
              {!recipientName && (
                <ReviewRow
                  label={t('evmSend.to', { defaultValue: 'To' })}
                  value={
                    isFHE
                      ? t('sendReview.stealth', { defaultValue: 'Stealth address' })
                      : middleCut(singleAddress)
                  }
                />
              )}
              <ReviewRow
                label={t('sendReview.from', { defaultValue: 'From' })}
                value={
                  <span className="inline-flex! items-center!" style={{ gap: '6px' }}>
                    {activeWallet?.address && (
                      <WalletAvatar address={activeWallet.address} size={16} />
                    )}
                    {middleCut(activeWallet?.address ?? '')}
                  </span>
                }
              />
            </>
          )}
          <ReviewRow
            label={t('evmSend.network', { defaultValue: 'Network' })}
            value={networkLabel}
          />
          <ReviewRow label={t('send.networkFee')} value={`${reviewFee} OCT`} />
          {isFHE && (
            <ReviewRow
              label={t('sendReview.privacy', { defaultValue: 'Privacy' })}
              value={t('sendReview.privacyValue', { defaultValue: 'FHE stealth' })}
            />
          )}
          {isBulkReview && (
            <ReviewRow
              label={t('sendReview.transactions', { defaultValue: 'Transactions' })}
              value={t('sendReview.sequential', {
                count: validRecipients.length,
                defaultValue: '{{count}} sequential',
              })}
            />
          )}
          <ReviewRow label={t('sendReview.total', { defaultValue: 'Total' })} value={reviewTotal} />
          {reviewMemo && (
            <ReviewRow
              label={t('sendReview.message', { defaultValue: 'Message' })}
              value={reviewMemo}
            />
          )}
        </ReviewCard>
        <ReviewNote>
          {isFHE
            ? t('sendReview.notePrivate', {
                defaultValue:
                  'Recipient and amount stay hidden on chain. Proofs run before sending and can take a few minutes.',
              })
            : t('sendReview.notePublic', {
                defaultValue: 'Public transfers are visible on chain and irreversible.',
              })}
        </ReviewNote>
      </Sheet>

      <div
        className="flex-1! overflow-y-auto! scrollbar-hide! flex! flex-col!"
        style={{ padding: '4px var(--gutter) 24px' }}
      >
        {isFHE && mode === 'bulk' ? (
          <div
            className="flex-1! flex! flex-col! items-center! justify-center! text-center!"
            style={{ padding: '16px 0', gap: '6px' }}
          >
            <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--fg)' }}>
              Bulk private send requires 0xio Desktop
            </div>
            <button
              onClick={() => window.open('https://0xio.xyz/install', '_blank', 'noopener')}
              style={{
                marginTop: '8px',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                fontSize: '12px',
                fontWeight: 600,
                color: 'var(--accent)',
              }}
            >
              Get 0xio Desktop
            </button>
          </div>
        ) : mode === 'single' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div>
              <div className="flex! items-center! justify-between!" style={{ marginBottom: '6px' }}>
                <FieldLabel>Recipient</FieldLabel>
                {singleIssues.self ? (
                  <span style={{ fontSize: '11px', color: 'var(--neg)' }}>
                    {t('send.selfSend')}
                  </span>
                ) : (
                  recipientName && (
                    <span
                      className="animate-in! fade-in! duration-200!"
                      style={{
                        fontSize: '11px',
                        fontFamily: 'var(--font-mono)',
                        color: 'var(--fg-3)',
                      }}
                    >
                      {middleCut(singleAddress, 8, 6)}
                    </span>
                  )
                )}
              </div>
              <div className="relative!">
                <input
                  ref={inputRef}
                  type="text"
                  value={recipientText}
                  onChange={(e) => {
                    const next = cleanRecipientInput(e.target.value);
                    setRecipient(next);
                    setShowAddressDropdown(next.length < OCT_ADDRESS_LENGTH);
                  }}
                  onFocus={() => setShowAddressDropdown(true)}
                  placeholder="oct..."
                  spellCheck={false}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  aria-invalid={addressInvalid || singleIssues.self}
                  className={quietField}
                  style={
                    addressInvalid || singleIssues.self ? { borderColor: 'var(--neg)' } : undefined
                  }
                />
                {showAddressDropdown && (nameLookup.state !== 'off' || contacts.length > 0) && (
                  <div
                    ref={dropdownRef}
                    className="z-dropdown! absolute! left-0! right-0! rounded-[10px]! overflow-y-auto! scrollbar-hide! bg-(--bg-1)!"
                    style={{
                      top: 'calc(100% + 4px)',
                      maxHeight: '160px',
                      boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
                    }}
                  >
                    {nameLookup.state !== 'off' && (
                      <NameRow
                        lookup={nameLookup}
                        selected={
                          nameLookup.state === 'resolved' &&
                          recipientName === nameLookup.name &&
                          singleAddress === nameLookup.address
                        }
                        onPick={(name, address) => {
                          setRecipient(address, name);
                          setShowAddressDropdown(false);
                        }}
                        onRetry={retryName}
                      />
                    )}
                    {contacts
                      .filter(
                        (c: any) =>
                          !recipientText ||
                          c.address.toLowerCase().includes(recipientText.toLowerCase()) ||
                          c.name.toLowerCase().includes(recipientText.toLowerCase())
                      )
                      .slice(0, 6)
                      .map((c: any) => (
                        <div
                          key={c.id}
                          onClick={() => handleSelectContact(c)}
                          className="hover:bg-(--bg-2)!"
                          style={{
                            padding: '9px 12px',
                            cursor: 'pointer',
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            gap: '8px',
                          }}
                        >
                          <span className="flex! items-center! min-w-0!" style={{ gap: '6px' }}>
                            <WalletAvatar address={c.address} size={20} />
                            <span
                              className="truncate!"
                              style={{ fontSize: '12px', fontWeight: 500, color: 'var(--fg)' }}
                            >
                              {c.name}
                            </span>
                            {c.category === 'wallet' && (
                              <span
                                style={{ fontSize: '11px', color: 'var(--fg-3)', flexShrink: 0 }}
                              >
                                {t('send.you')}
                              </span>
                            )}
                          </span>
                          <span
                            style={{
                              fontSize: '11px',
                              color: 'var(--fg-3)',
                              flexShrink: 0,
                              fontVariantNumeric: 'tabular-nums',
                            }}
                          >
                            {c.address.slice(0, 8)}…{c.address.slice(-6)}
                          </span>
                        </div>
                      ))}
                  </div>
                )}
              </div>
            </div>

            <div>
              <div className="flex! items-center! justify-between!" style={{ marginBottom: '6px' }}>
                <FieldLabel>Amount</FieldLabel>
                <div className="flex! items-center!" style={{ gap: '8px' }}>
                  <span
                    style={{
                      fontSize: '11px',
                      color: 'var(--fg-3)',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {availableText} {symbol}
                  </span>
                  <button
                    onClick={handleMax}
                    disabled={maxAmount === null}
                    style={{
                      background: 'none',
                      border: 'none',
                      padding: 0,
                      cursor: maxAmount === null ? 'not-allowed' : 'pointer',
                      fontSize: '11px',
                      fontWeight: 600,
                      color: 'var(--accent)',
                      opacity: maxAmount === null ? 0.4 : 1,
                    }}
                  >
                    {t('send.max')}
                  </button>
                </div>
              </div>
              <div
                className={`flex! items-center! rounded-[10px]! bg-(--bg-1)! border! ${
                  amountExceeds ? 'border-(--neg)!' : 'border-transparent!'
                }`}
                style={{ height: '56px', padding: '0 12px' }}
              >
                {amountInUsd && (
                  <span
                    style={{
                      fontSize: `${amountFont}px`,
                      fontWeight: 600,
                      color: 'var(--fg-2)',
                      marginRight: '2px',
                      lineHeight: 1,
                    }}
                  >
                    $
                  </span>
                )}
                <input
                  ref={amountInputRef}
                  type="text"
                  inputMode="decimal"
                  value={amountDisplay}
                  onChange={handleAmountChange}
                  onPaste={handleAmountPaste}
                  placeholder="0.00"
                  style={{
                    flex: 1,
                    minWidth: 0,
                    background: 'transparent',
                    border: 'none',
                    outline: 'none',
                    fontSize: `${amountFont}px`,
                    fontWeight: 600,
                    color: 'var(--fg)',
                    letterSpacing: '-0.01em',
                    fontVariantNumeric: 'tabular-nums',
                    transition: 'font-size 120ms ease',
                  }}
                />
                <div ref={tokenPickerRef} style={{ position: 'relative', marginLeft: '8px' }}>
                  <button
                    onClick={() =>
                      amountInUsd
                        ? setAmountInUsd(false)
                        : canSwitchToken && setShowTokenPicker(!showTokenPicker)
                    }
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '3px',
                      background: 'none',
                      border: 'none',
                      padding: 0,
                      fontSize: '13px',
                      fontWeight: 600,
                      color: amountInUsd || canSwitchToken ? 'var(--fg)' : 'var(--fg-2)',
                      cursor: amountInUsd || canSwitchToken ? 'pointer' : 'default',
                    }}
                  >
                    {amountInUsd ? 'USD' : symbol}
                    {!amountInUsd && canSwitchToken && (
                      <ChevronDown size={12} style={{ color: 'var(--fg-3)' }} />
                    )}
                  </button>
                  {showTokenPicker && !amountInUsd && (
                    <div
                      className="z-dropdown! absolute! right-0! rounded-[10px]! overflow-y-auto! scrollbar-hide! bg-(--bg-1)!"
                      style={{
                        top: 'calc(100% + 6px)',
                        minWidth: '150px',
                        maxHeight: '140px',
                        boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
                      }}
                    >
                      {availableTokens.map((tok) => (
                        <button
                          key={tok.contractAddress ?? 'native'}
                          onClick={() => {
                            setSelectedToken(tok);
                            setShowTokenPicker(false);
                            setSingleAmount('');
                            setUsdInput('');
                          }}
                          className="hover:bg-(--bg-2)!"
                          style={{
                            width: '100%',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: '12px',
                            padding: '8px 12px',
                            cursor: 'pointer',
                            textAlign: 'left',
                            background:
                              tok.symbol === selectedToken.symbol ? 'var(--bg-2)' : 'transparent',
                            border: 'none',
                            fontSize: '12px',
                            fontWeight: 600,
                            color: 'var(--fg)',
                          }}
                        >
                          <span
                            style={{
                              minWidth: 0,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {tok.symbol}
                          </span>
                          <span
                            style={{
                              fontSize: '11px',
                              fontWeight: 400,
                              color: 'var(--fg-3)',
                              fontVariantNumeric: 'tabular-nums',
                              flexShrink: 0,
                            }}
                          >
                            {displayAmount(tok.balance, tok.decimals)}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              {!isCustomToken || amountExceeds || singleIssues.feeShort ? (
                <button
                  onClick={toggleAmountUnit}
                  className="group! flex! items-center!"
                  style={{
                    gap: '4px',
                    marginTop: '6px',
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    cursor: canToggleUsd ? 'pointer' : 'default',
                    fontSize: '11px',
                    color: amountExceeds || singleIssues.feeShort ? 'var(--neg)' : 'var(--fg-3)',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {amountExceeds
                    ? t('send.insufficientBalance')
                    : singleIssues.feeShort
                      ? t('send.feeShort')
                      : amountInUsd
                        ? `≈ ${formatAmountDisplay(singleAmount || '0')} ${symbol}`
                        : (amountUsd ?? '--')}
                  {canToggleUsd && (
                    <ArrowUpDown
                      size={11}
                      className="group-hover:text-(--fg)! transition-colors!"
                    />
                  )}
                </button>
              ) : null}
            </div>

            {!isFHE && !isCustomToken && (
              <button
                onClick={() => setShowMemoModal(true)}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: 0,
                  textAlign: 'left',
                  fontSize: '11px',
                  color: memo ? 'var(--accent)' : 'var(--fg-3)',
                }}
              >
                {memo ? `"${memo.slice(0, 20)}${memo.length > 20 ? '…' : ''}"` : 'Add message'}
              </button>
            )}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div className="flex! items-center! justify-between!" style={{ padding: '4px 0' }}>
              <div>
                <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--fg)' }}>
                  {recipients.length} recipients
                </div>
                <div
                  style={{
                    fontSize: '11px',
                    color: bulkExceeds || bulkCheck.self ? 'var(--neg)' : 'var(--fg-3)',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {bulkCheck.self ? (
                    t('send.selfSend')
                  ) : (
                    <>
                      Total {displayAmount(bulkTotal, 6)} OCT
                      {bulkExceeds ? ` (${t('send.insufficientBalance').toLowerCase()})` : ''}
                    </>
                  )}
                </div>
              </div>
              <button
                onClick={addRecipient}
                style={{
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  cursor: 'pointer',
                  fontSize: '12px',
                  fontWeight: 600,
                  color: 'var(--accent)',
                }}
              >
                Add
              </button>
            </div>
            {recipients.map((r, idx) => (
              <div
                key={idx}
                className="rounded-[10px]! bg-(--bg-1)!"
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr auto auto',
                  gap: '8px',
                  padding: '8px 12px',
                  alignItems: 'center',
                }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
                  <input
                    type="text"
                    value={r.address}
                    placeholder="oct..."
                    onChange={(e) =>
                      updateRecipient(
                        idx,
                        'address',
                        normalizeAddress(e.target.value).slice(0, OCT_ADDRESS_LENGTH)
                      )
                    }
                    spellCheck={false}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    aria-invalid={r.address.length > 0 && !isOctAddress(r.address)}
                    style={{
                      width: '100%',
                      background: 'transparent',
                      border: 'none',
                      outline: 'none',
                      fontSize: '12px',
                      color:
                        (r.address.length >= OCT_ADDRESS_LENGTH && !isOctAddress(r.address)) ||
                        isSelfSend(r.address, activeWallet?.address)
                          ? 'var(--neg)'
                          : 'var(--fg)',
                    }}
                  />
                  <input
                    type="text"
                    inputMode="decimal"
                    value={r.amount}
                    placeholder="0.00"
                    onChange={(e) => {
                      const v = cleanAmountInput(e.target.value, 6);
                      if (v !== null) updateRecipient(idx, 'amount', v);
                    }}
                    style={{
                      width: '100%',
                      background: 'transparent',
                      border: 'none',
                      outline: 'none',
                      fontSize: '13px',
                      fontWeight: 600,
                      color: 'var(--fg)',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  />
                </div>
                <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--fg-2)' }}>OCT</span>
                {recipients.length > 1 && (
                  <button
                    onClick={() => removeRecipient(idx)}
                    className="text-content-muted! hover:text-(--neg)! transition-colors!"
                    style={{
                      width: '22px',
                      height: '22px',
                      background: 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <X size={13} />
                  </button>
                )}
              </div>
            ))}
            <div
              style={{
                fontSize: '11px',
                color: 'var(--fg-3)',
                padding: '4px 0 0',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {feeOct
                ? t('send.bulkFeeLine', {
                    count: validRecipients.length,
                    fee: feeOct,
                    defaultValue: '{{count}} transactions at {{fee}} OCT each',
                  })
                : null}
            </div>
            <button
              onClick={() => setShowMemoModal(true)}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: '4px 0 0',
                textAlign: 'left',
                fontSize: '11px',
                color: memo ? 'var(--accent)' : 'var(--fg-3)',
              }}
            >
              {memo ? `"${memo.slice(0, 20)}${memo.length > 20 ? '…' : ''}"` : 'Add message'}
            </button>
          </div>
        )}
      </div>

      {!(isFHE && mode === 'bulk') && (
        <div className="shrink-0!" style={{ padding: '8px var(--gutter) 16px' }}>
          <button
            onClick={() =>
              feeReadFailed ? retryFee() : liveFee ? setShowOUModal(true) : undefined
            }
            className="group! flex! items-center! justify-between! w-full!"
            style={{
              background: 'none',
              border: 'none',
              padding: '4px 0 12px',
              cursor: feeReadFailed || liveFee ? 'pointer' : 'default',
            }}
          >
            <span style={{ fontSize: '11px', color: 'var(--fg-3)' }}>
              {t('send.networkFee', { defaultValue: 'Network fee' })}
            </span>
            {feeOct ? (
              <span
                className="flex! items-center! text-content-secondary! group-hover:text-(--fg)! transition-colors!"
                style={{
                  gap: '4px',
                  fontSize: '12px',
                  fontWeight: 500,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {feeIsCustom ? (
                  `${feeOct} OCT`
                ) : (
                  <FeeValue state={sendFee.state} text={`${feeOct} OCT`} ageMs={sendFee.ageMs} />
                )}
                {liveFee && <ChevronDown size={12} />}
              </span>
            ) : (
              <FeeValue
                state={
                  feeReadFailed
                    ? 'failed'
                    : sendFee.state === 'unsupported'
                      ? 'unsupported'
                      : 'loading'
                }
                retry
              />
            )}
          </button>
          <PrivacyOpsCta state={opsState} onMigrate={migrate.open}>
            <button
              onClick={handleReview}
              disabled={sendBlocked}
              className="flex! items-center! justify-center! w-full! hover:bg-accent-hover! transition-colors! duration-150!"
              style={{
                height: '44px',
                borderRadius: '10px',
                background: 'var(--accent)',
                border: 'none',
                color: 'var(--accent-fg)',
                fontSize: '13px',
                fontWeight: 600,
                cursor: isSending ? 'wait' : sendBlocked ? 'not-allowed' : 'pointer',
                opacity: sendBlocked ? 0.5 : 1,
              }}
            >
              {mode === 'bulk'
                ? `Review bulk send (${validRecipients.length})`
                : isFHE
                  ? 'Review private send'
                  : 'Review send'}
            </button>
          </PrivacyOpsCta>
        </div>
      )}

      <MigrateBalanceModal
        show={migrate.showPopup}
        onClose={migrate.closePopup}
        onSubmit={migrate.submit}
        submitting={migrate.verifying}
        progress={migrate.progress}
        encryptedOct={privateBalance ?? ''}
        feeOct={migrate.feeOct}
        publicOct={balance ?? ''}
        feeShort={migrate.feeShort}
        feeFailed={migrate.feeFailed}
        onRetryFee={() => void migrate.retryFee()}
        reusingPayload={migrate.reusing}
      />

      <Sheet
        open={showMemoModal}
        onClose={() => setShowMemoModal(false)}
        title="On-chain message"
        sub="Stored with the transaction and visible to anyone."
        footer={
          <div className="flex!" style={{ gap: '10px' }}>
            <div style={{ flex: 1 }}>
              <PrimaryButton
                secondary
                disabled={!memo}
                onClick={() => {
                  setMemo('');
                  memoRef.current?.focus();
                }}
              >
                {t('send.clear')}
              </PrimaryButton>
            </div>
            <div style={{ flex: 2 }}>
              <PrimaryButton onClick={() => setShowMemoModal(false)}>Done</PrimaryButton>
            </div>
          </div>
        }
      >
        <textarea
          ref={memoRef}
          value={memo}
          onChange={(e) => setMemo(clampMemo(e.target.value, MEMO_INPUT_MAX_BYTES))}
          placeholder="Optional message stored on-chain"
          rows={3}
          autoFocus
          className="rounded-xl! border! border-transparent! bg-(--bg-1)! focus:border-(--line-2)!"
          style={{
            width: '100%',
            padding: '10px 12px',
            fontSize: '13px',
            color: 'var(--fg)',
            outline: 'none',
            resize: 'none',
            fontFamily: 'inherit',
            boxSizing: 'border-box',
          }}
        />
        <div
          style={{
            marginTop: '6px',
            fontSize: '11px',
            color: 'var(--fg-3)',
            fontVariantNumeric: 'tabular-nums',
            textAlign: 'right',
          }}
        >
          {memoBytes(memo)}/{MEMO_INPUT_MAX_BYTES}
        </div>
      </Sheet>

      <FeeSheet
        open={showOUModal}
        value={sendOu ?? ''}
        presets={feePresets}
        defaultOu={liveFee?.recommended}
        minOu={liveFee?.minimum}
        onSave={setCustomOU}
        onClose={() => setShowOUModal(false)}
      />
    </div>
  );
};

export default SendScreen;
