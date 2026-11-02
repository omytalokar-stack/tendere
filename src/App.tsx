import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ArrowLeft,
  AlertTriangle,
  BarChart2,
  Bell,
  CheckCircle2,
  Clock,
  Download,
  LockKeyhole,
  Radio,
  RefreshCw,
  Settings,
  Shield,
  Smartphone,
  Sparkles,
  Wallet,
  X,
} from 'lucide-react';
import { TradingViewProModal } from './components/TradingViewProModal';
import {
  closePaperTrade,
  getBackendAudit,
  getBackendSnapshot,
  getRealCandles,
  setBotEnabled,
  type BackendAuditEvent,
  type BackendCandle,
  type BackendMarket,
  type BackendSnapshot,
  type BackendTrade,
} from './services/backendApi';
import {
  areBrowserAlertsEnabled,
  disableBrowserAlerts,
  enableBrowserAlerts,
  notifyTradeClosed,
  notifyTradeCooldown,
  notifyTradeOpened,
} from './services/notificationService';

const COINS = [
  { id: 'ETH', symbol: 'ETHUSDT', name: 'Ethereum', decimals: 2, color: '#a78bfa' },
  { id: 'SOL', symbol: 'SOLUSDT', name: 'Solana', decimals: 2, color: '#ec4899' },
  { id: 'BNB', symbol: 'BNBUSDT', name: 'BNB', decimals: 2, color: '#f59e0b' },
  { id: 'XRP', symbol: 'XRPUSDT', name: 'XRP', decimals: 4, color: '#38bdf8' },
  { id: 'ADA', symbol: 'ADAUSDT', name: 'Cardano', decimals: 4, color: '#2dd4bf' },
  { id: 'AVAX', symbol: 'AVAXUSDT', name: 'Avalanche', decimals: 2, color: '#f43f5e' },
] as const;

type Tab = 'home' | 'strategy' | 'health' | 'wallet';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

function isStandaloneApp(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

const TABS: Array<{ id: Tab; label: string; icon: typeof Activity }> = [
  { id: 'home', label: 'Home', icon: Activity },
  { id: 'strategy', label: 'Strategy', icon: BarChart2 },
  { id: 'health', label: 'Brain Health', icon: Shield },
  { id: 'wallet', label: 'Wallet', icon: Wallet },
];

function formatPrice(value: number, decimals: number) {
  return value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function formatUsd(value: number) {
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function pnlFor(trade: BackendTrade, markPrice: number, takerFeeRate: number) {
  const direction = trade.side === 'LONG' ? 1 : -1;
  const grossPnlUsd = direction * (markPrice - trade.entryPrice) * trade.quantity;
  const entryFeeUsd = trade.entryFeeUsd ?? 0;
  const estimatedExitFeeUsd = markPrice * trade.quantity * takerFeeRate;
  const pnlUsd = grossPnlUsd - entryFeeUsd - estimatedExitFeeUsd;
  return {
    pnlUsd,
    pnlPercent: trade.margin > 0 ? (pnlUsd / trade.margin) * 100 : 0,
  };
}

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('home');
  const [walletSettingsOpen, setWalletSettingsOpen] = useState(false);
  const [canInstallApp, setCanInstallApp] = useState(false);
  const [appInstalled, setAppInstalled] = useState(isStandaloneApp);
  const [installMessage, setInstallMessage] = useState('');
  const [snapshot, setSnapshot] = useState<BackendSnapshot | null>(null);
  const [auditEvents, setAuditEvents] = useState<BackendAuditEvent[]>([]);
  const [backendError, setBackendError] = useState('');
  const [auditError, setAuditError] = useState('');
  const [loading, setLoading] = useState(true);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [chartCandles, setChartCandles] = useState<BackendCandle[]>([]);
  const [chartError, setChartError] = useState('');
  const [chartLoading, setChartLoading] = useState(false);
  const [chartOpen, setChartOpen] = useState(false);
  const [actionError, setActionError] = useState('');
  const [actionPending, setActionPending] = useState<string | null>(null);
  const [closeConfirmation, setCloseConfirmation] = useState<BackendTrade | null>(null);
  const [alertsEnabled, setAlertsEnabled] = useState(areBrowserAlertsEnabled);
  const tradeStatuses = useRef(new Map<string, BackendTrade['status']>());
  const hasTradeBaseline = useRef(false);
  const notificationBaselineAt = useRef<number | null>(null);
  const installPrompt = useRef<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      installPrompt.current = event as BeforeInstallPromptEvent;
      setCanInstallApp(true);
    };
    const onAppInstalled = () => {
      installPrompt.current = null;
      setCanInstallApp(false);
      setAppInstalled(true);
      setInstallMessage('AuraAlgo has been installed on this device.');
    };

    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onAppInstalled);
    navigator.serviceWorker.register('/sw.js').catch((error: unknown) => {
      console.error('AuraAlgo service worker registration failed', error);
    });

    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onAppInstalled);
    };
  }, []);

  const handleInstallApp = async () => {
    setInstallMessage('');
    if (appInstalled) {
      setInstallMessage('AuraAlgo is already installed on this device.');
      return;
    }

    const prompt = installPrompt.current;
    if (!prompt) {
      const isAppleMobile = /iPhone|iPad|iPod/i.test(navigator.userAgent);
      setInstallMessage(isAppleMobile
        ? 'In Safari, tap Share, then choose “Add to Home Screen”.'
        : 'If the install prompt is unavailable, open your browser menu and choose “Install app” or “Add to Home screen”.');
      return;
    }

    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      installPrompt.current = null;
      setCanInstallApp(false);
      setInstallMessage(choice.outcome === 'accepted'
        ? 'AuraAlgo is installing. You can open it from your home screen.'
        : 'Installation was cancelled. You can install AuraAlgo later from this page.');
      if (choice.outcome === 'accepted') setAppInstalled(true);
    } catch (error) {
      console.error('AuraAlgo installation prompt failed', error);
      setInstallMessage('The install prompt could not be opened. Use your browser menu to install the app.');
    }
  };

  useEffect(() => {
    let disposed = false;
    let controller: AbortController | null = null;
    let auditController: AbortController | null = null;
    let refreshing = false;
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      controller = new AbortController();
      auditController = new AbortController();
      const started = performance.now();
      try {
        const [snapshotResult, auditResult] = await Promise.allSettled([
          getBackendSnapshot(controller.signal),
          getBackendAudit(auditController.signal),
        ]);
        if (disposed) return;
        if (snapshotResult.status === 'fulfilled') {
          const nextSnapshot = snapshotResult.value;
          if (hasTradeBaseline.current) {
            const previousStatuses = tradeStatuses.current;
            const baselineAt = notificationBaselineAt.current ?? Date.now();
            for (const trade of nextSnapshot.trades) {
              const previousStatus = previousStatuses.get(trade._id);
              const openedAfterBaseline = Date.parse(trade.openedAt) > baselineAt;
              const closedAfterBaseline = Boolean(
                trade.closedAt && Date.parse(trade.closedAt) > baselineAt,
              );
              const notify = (operation: Promise<void>) => {
                void operation.catch((error: unknown) => {
                  console.warn('Browser trade notification failed', error);
                  setActionError(error instanceof Error ? error.message : 'Browser trade notification failed.');
                });
              };

              if ((trade.status === 'OPEN' && previousStatus !== 'OPEN')
                || (trade.status === 'CLOSED'
                  && previousStatus === undefined
                  && openedAfterBaseline)) {
                notify(notifyTradeOpened(trade));
              }
              if (trade.status === 'CLOSED'
                && (previousStatus === 'OPEN' || (previousStatus === undefined && closedAfterBaseline))) {
                notify(notifyTradeClosed(trade));
                if (trade.closeReason === 'STOP_LOSS'
                  && trade.pnlUsd < 0
                  && trade.cooldownUntil) {
                  notify(notifyTradeCooldown(trade));
                }
              }
              previousStatuses.set(trade._id, trade.status);
            }
            while (tradeStatuses.current.size > 500) {
              const oldestTradeId = tradeStatuses.current.keys().next().value;
              if (oldestTradeId === undefined) break;
              tradeStatuses.current.delete(oldestTradeId);
            }
          } else {
            notificationBaselineAt.current = Date.now();
            for (const trade of nextSnapshot.trades) {
              tradeStatuses.current.set(trade._id, trade.status);
            }
            hasTradeBaseline.current = true;
          }
          setSnapshot(nextSnapshot);
          setBackendError('');
          setLatencyMs(Math.round(performance.now() - started));
        } else if (!(snapshotResult.reason instanceof DOMException && snapshotResult.reason.name === 'AbortError')) {
          setSnapshot(null);
          setBackendError(snapshotResult.reason instanceof Error ? snapshotResult.reason.message : 'Backend request failed');
        }
        if (auditResult.status === 'fulfilled') {
          setAuditEvents(auditResult.value);
          setAuditError('');
        } else if (!(auditResult.reason instanceof DOMException && auditResult.reason.name === 'AbortError')) {
          setAuditEvents([]);
          setAuditError(auditResult.reason instanceof Error ? auditResult.reason.message : 'Audit log unavailable');
        }
        setLoading(false);
      } finally {
        refreshing = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      controller?.abort();
      auditController?.abort();
    };
  }, []);

  const selectedCoin = useMemo(
    () => COINS.find((coin) => coin.symbol === selectedSymbol) ?? null,
    [selectedSymbol],
  );
  const selectedMarket = snapshot?.markets.find((market) => market.symbol === selectedSymbol) ?? null;

  useEffect(() => {
    if (!selectedCoin) {
      setChartCandles([]);
      setChartError('');
      setChartLoading(false);
      setChartOpen(false);
      return;
    }
    if (!snapshot) {
      setChartCandles([]);
      setChartError(backendError || 'DATA_FEED_OFFLINE: live backend data is unavailable');
      setChartLoading(false);
      return;
    }
    const controller = new AbortController();
    let disposed = false;
    setChartCandles([]);
    setChartError('');
    setChartLoading(true);
    getRealCandles(selectedCoin.symbol, controller.signal)
      .then((candles) => setChartCandles(candles))
      .catch((error: unknown) => {
        if (disposed || (error instanceof DOMException && error.name === 'AbortError')) return;
        setChartCandles([]);
        setChartError(error instanceof Error ? error.message : 'Binance candle request failed');
      })
      .finally(() => {
        if (!disposed) setChartLoading(false);
      });
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [selectedCoin, snapshot !== null, backendError]);

  const openTrades = snapshot?.trades.filter((trade) => trade.status === 'OPEN') ?? [];
  const closedTrades = snapshot?.trades
    .filter((trade) => trade.status === 'CLOSED')
    .sort((a, b) => new Date(a.closedAt ?? a.openedAt).getTime() - new Date(b.closedAt ?? b.openedAt).getTime()) ?? [];
  const startingBalance = snapshot
    ? snapshot.wallet.balance - snapshot.wallet.totalRealizedPnl
    : null;
  const tickAgeMs = snapshot?.markets.length
    ? Math.max(...snapshot.markets.map((market) => market.marketAgeMs))
    : null;

  async function runControlAction(actionId: string, operation: () => Promise<void>) {
    setActionPending(actionId);
    setActionError('');
    try {
      await operation();
      setActionError('Action accepted by backend.');
      const next = await getBackendSnapshot();
      setSnapshot(next);
    } catch (error) {
      setActionError(error instanceof Error
        ? error.message
        : 'Control request failed. The backend may require trusted authorization.');
    } finally {
      setActionPending(null);
    }
  }

  const rootStyle: React.CSSProperties = {
    background: 'radial-gradient(ellipse at 10% 0%, rgba(107, 54, 150, .16), transparent 35%), #0d0b14',
  };

  async function handleAlertsToggle() {
    setActionError('');
    if (alertsEnabled) {
      if (disableBrowserAlerts()) {
        setAlertsEnabled(false);
        setActionError('Browser trade alerts disabled.');
      } else {
        setActionError('Browser storage is unavailable; alert preference could not be saved.');
      }
      return;
    }

    const result = await enableBrowserAlerts();
    setAlertsEnabled(result.enabled);
    setActionError(result.message);
  }

  return (
    <div className="relative min-h-screen overflow-x-hidden pb-28 text-slate-100" style={rootStyle}>
      <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
        <div className="absolute -left-36 -top-32 h-96 w-96 rounded-full bg-purple-700/10 blur-3xl animate-pulse-glow" />
        <div className="absolute -right-36 top-1/3 h-96 w-96 rounded-full bg-pink-600/10 blur-3xl animate-pulse-glow" />
      </div>

      <header className="sticky top-0 z-30 border-b border-purple-400/10 bg-[#0d0b14]/80 px-4 py-3 backdrop-blur-xl">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-purple-400/30 bg-purple-500/10 shadow-[0_0_24px_rgba(168,85,247,.12)]">
              <Sparkles className="h-5 w-5 text-pink-300" />
            </div>
            <div>
              <h1 className="font-bold tracking-tight text-white">AuraAlgo</h1>
              <p className="text-[10px] font-mono text-slate-400">REAL BINANCE · PAPER MODE</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void handleAlertsToggle()}
              aria-label={alertsEnabled ? 'Disable browser trade alerts' : 'Enable browser trade alerts'}
              title={alertsEnabled ? 'Disable browser trade alerts' : 'Enable browser trade alerts'}
              className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11px] transition ${
                alertsEnabled
                  ? 'border-pink-300/40 bg-pink-500/15 text-pink-100'
                  : 'border-purple-400/15 bg-purple-950/30 text-slate-300 hover:border-pink-300/40 hover:text-pink-100'
              }`}
            >
              <Bell className="h-3.5 w-3.5" />
              <span>{alertsEnabled ? 'Alerts on' : 'Enable alerts'}</span>
            </button>
            <div className="flex items-center gap-2 rounded-full border border-purple-400/15 bg-purple-950/30 px-3 py-1.5 text-[11px]">
              <span className={`h-2 w-2 rounded-full ${snapshot?.status.feedConnected ? 'bg-emerald-400' : 'bg-rose-400'}`} />
              <span className={snapshot?.status.feedConnected ? 'text-emerald-200' : 'text-rose-200'}>
                {snapshot?.status.feedConnected ? 'Live feed' : 'Feed offline'}
              </span>
            </div>
          </div>
        </div>
      </header>

      <main className="relative z-10 mx-auto max-w-5xl px-4 pt-5">
        {backendError && (
          <div role="alert" className="mb-5 flex items-start gap-3 rounded-2xl border border-pink-400/30 bg-pink-950/30 p-4 text-sm text-pink-100 shadow-[0_0_24px_rgba(236,72,153,.08)]">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-pink-300" />
            <div>
              <p className="font-semibold">Live data unavailable</p>
              <p className="mt-1 break-words text-xs text-pink-100/80">{backendError}</p>
            </div>
          </div>
        )}
        {actionError && (
          <div role="status" className="mb-5 flex items-start justify-between gap-3 rounded-2xl border border-pink-400/25 bg-pink-950/25 p-3 text-xs text-pink-100">
            <span>{actionError}</span>
            <button onClick={() => setActionError('')} aria-label="Dismiss notification"><X className="h-4 w-4" /></button>
          </div>
        )}

        {activeTab === 'home' && (
          <HomeTab
            loading={loading}
            feedReady={Boolean(snapshot?.status.marketDataReady)}
            trades={openTrades}
            markets={snapshot?.markets ?? []}
            realizedPnl={snapshot?.wallet.totalRealizedPnl ?? null}
            takerFeeRate={snapshot?.status.takerFeeRate ?? 0}
            pendingAction={actionPending}
            onClose={(trade) => setCloseConfirmation(trade)}
            onScan={() => setActiveTab('strategy')}
          />
        )}

        {activeTab === 'strategy' && (
          <StrategyTab
            snapshot={snapshot}
            loading={loading}
            selectedSymbol={selectedSymbol}
            selectedCoin={selectedCoin}
            selectedMarket={selectedMarket}
            candles={chartCandles}
            candleLoading={chartLoading}
            candleError={chartError}
            onSelect={(symbol) => {
              setSelectedSymbol((current) => current === symbol ? null : symbol);
              setChartOpen(false);
            }}
            onOpenChart={() => setChartOpen(true)}
          />
        )}

        {activeTab === 'health' && (
          <HealthTab
            snapshot={snapshot}
            loading={loading}
            latencyMs={latencyMs}
            tickAgeMs={tickAgeMs}
            events={auditEvents}
            auditError={auditError}
            actionPending={actionPending}
            onSetEnabled={(enabled) => runControlAction(`bot-${enabled}`, () => setBotEnabled(enabled))}
          />
        )}

        {activeTab === 'wallet' && (
          walletSettingsOpen
            ? <WalletSettings
                appInstalled={appInstalled}
                canInstall={canInstallApp}
                installMessage={installMessage}
                onBack={() => setWalletSettingsOpen(false)}
                onInstall={() => void handleInstallApp()}
              />
            : <WalletTab
                snapshot={snapshot}
                loading={loading}
                closedTrades={closedTrades}
                startingBalance={startingBalance}
                onOpenSettings={() => {
                  setInstallMessage('');
                  setWalletSettingsOpen(true);
                }}
              />
        )}
      </main>

      {selectedCoin && chartOpen && (
        <TradingViewProModal
          isOpen
          onClose={() => setChartOpen(false)}
          coin={selectedCoin}
          candles={chartCandles}
          market={selectedMarket}
          loading={chartLoading}
          error={chartError}
        />
      )}

      {closeConfirmation && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
          <div role="dialog" aria-modal="true" aria-labelledby="close-trade-title" className="w-full max-w-sm rounded-3xl border border-purple-400/25 bg-[#130f1e] p-6 shadow-2xl">
            <h2 id="close-trade-title" className="text-lg font-bold text-white">Close paper position?</h2>
            <p className="mt-2 text-sm text-slate-400">
              {closeConfirmation.symbol} {closeConfirmation.side} will close at a fresh Binance quote. The backend must authorize the request.
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button onClick={() => setCloseConfirmation(null)} className="rounded-xl border border-purple-400/20 px-4 py-2 text-sm text-slate-300 hover:bg-white/5">Cancel</button>
              <button
                disabled={actionPending !== null}
                onClick={() => {
                  const trade = closeConfirmation;
                  setCloseConfirmation(null);
                  void runControlAction(`close-${trade._id}`, () => closePaperTrade(trade._id));
                }}
                className="rounded-xl border border-pink-400/30 bg-pink-500/15 px-4 py-2 text-sm font-semibold text-pink-100 hover:bg-pink-500/25 disabled:opacity-50"
              >
                {actionPending === `close-${closeConfirmation._id}` ? 'Closing…' : 'Close position'}
              </button>
            </div>
          </div>
        </div>
      )}

      <nav aria-label="Main navigation" className="fixed inset-x-0 bottom-0 z-40 px-4 pb-[max(12px,env(safe-area-inset-bottom))]">
        <div className="mx-auto grid max-w-md grid-cols-4 gap-1 rounded-2xl border border-purple-300/15 bg-[#130f1e]/90 p-1.5 shadow-[0_-8px_35px_rgba(0,0,0,.4)] backdrop-blur-2xl">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              aria-current={activeTab === id ? 'page' : undefined}
              className={`flex flex-col items-center justify-center gap-1 rounded-xl px-2 py-2 transition-all duration-200 ${
                activeTab === id
                  ? 'bg-purple-500/15 text-pink-300 shadow-[0_0_18px_rgba(236,72,153,.1)]'
                  : 'text-slate-500 hover:bg-white/[0.04] hover:text-purple-200'
              }`}
            >
              <Icon className="h-4 w-4" />
              <span className="text-[10px] font-medium">{label}</span>
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
}

function HomeTab({
  loading,
  feedReady,
  trades,
  markets,
  realizedPnl,
  takerFeeRate,
  pendingAction,
  onClose,
  onScan,
}: {
  loading: boolean;
  feedReady: boolean;
  trades: BackendTrade[];
  markets: BackendMarket[];
  realizedPnl: number | null;
  takerFeeRate: number;
  pendingAction: string | null;
  onClose: (trade: BackendTrade) => void;
  onScan: () => void;
}) {
  if (loading) {
    return <div className="mx-auto flex min-h-[65vh] max-w-lg flex-col justify-center gap-4"><SkeletonCard /><SkeletonCard /></div>;
  }

  if (!feedReady) {
    return (
      <section className="mx-auto flex min-h-[68vh] max-w-lg flex-col items-center justify-center py-10 text-center">
        <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-full border border-pink-300/20 bg-pink-500/[0.06] shadow-[0_0_35px_rgba(236,72,153,.08)]">
          <Radio className="h-8 w-8 text-pink-200" />
        </div>
        <h2 className="text-xl font-semibold text-white">Waiting for verified market data</h2>
        <p className="mt-2 max-w-xs text-sm text-slate-400">The scanner stays paused until the backend confirms fresh Binance candles, trades, and order books.</p>
        <button onClick={onScan} className="mt-6 rounded-xl border border-purple-300/20 bg-purple-500/10 px-4 py-2.5 text-xs text-purple-100 hover:bg-purple-500/15">View feed status</button>
      </section>
    );
  }

  if (trades.length === 0) {
    return (
      <section className="mx-auto flex min-h-[72vh] max-w-lg flex-col items-center justify-center py-10 text-center">
        <div className="relative mb-7 flex h-28 w-28 items-center justify-center">
          <div className="absolute inset-2 rounded-full border border-purple-400/20" />
          <div className="relative flex h-20 w-20 items-center justify-center rounded-full border border-purple-300/30 bg-gradient-to-br from-purple-500/20 to-pink-500/10 shadow-[0_0_40px_rgba(168,85,247,.2)] animate-heartbeat motion-reduce:animate-none">
            <svg viewBox="0 0 64 64" role="img" aria-label="Black cat mascot" className="h-12 w-12">
              <path
                d="M23 39c-6 2-10 7-10 15l-3 7h20l2-7h4l2 7h20l-3-8c0-7-5-12-11-14Z"
                fill="#08060d"
                stroke="#a78bfa"
                strokeLinejoin="round"
                strokeWidth="1.5"
              />
              <path
                d="m19 30-5-20 17 10a18 18 0 0 1 8 0l17-10-5 21c4 3 6 7 6 12 0 9-8 15-22 15S13 52 13 43c0-5 2-10 6-13Z"
                fill="#08060d"
                stroke="#a78bfa"
                strokeLinejoin="round"
                strokeWidth="1.5"
              />
              <path d="M21 39c2-3 6-3 8 0-2 3-6 3-8 0Zm14 0c2-3 6-3 8 0-2 3-6 3-8 0Z" fill="#f9a8d4" />
              <path d="m30 45 2-2 2 2-2 2z" fill="#f472b6" />
            </svg>
          </div>
        </div>
        <p className="mb-2 text-[10px] font-mono uppercase tracking-[.25em] text-purple-300/70">AuraAlgo · Paper engine</p>
        <h2 className="text-2xl font-bold tracking-tight text-white">Scanning markets with 0 risk...</h2>
        <p className="mt-3 max-w-xs text-sm leading-relaxed text-purple-100/60">
          Resting in cash until the backend confirms a real Binance signal. No open position, no exposure.
        </p>
        <button onClick={onScan} className="mt-7 rounded-2xl border border-purple-400/20 bg-purple-500/10 px-5 py-3 text-xs font-medium text-purple-100 transition hover:border-pink-300/30 hover:bg-purple-500/15">
          Peek at the six-coin scanner
        </button>
      </section>
    );
  }

  return (
    <section className="mx-auto flex min-h-[70vh] max-w-xl flex-col justify-center gap-4 py-6">
      {trades.map((trade) => {
        const coin = COINS.find((item) => item.symbol === trade.symbol);
        const market = markets.find((item) => item.symbol === trade.symbol);
        if (!coin || !market) return null;
        const pnl = pnlFor(trade, market.price, takerFeeRate);
        const progress = trade.side === 'LONG'
          ? ((market.price - trade.stopLoss) / (trade.takeProfit - trade.stopLoss)) * 100
          : ((trade.stopLoss - market.price) / (trade.stopLoss - trade.takeProfit)) * 100;
        return (
          <article key={trade._id} className="relative overflow-hidden rounded-3xl border border-purple-300/20 bg-white/[0.035] p-5 shadow-[0_20px_70px_rgba(0,0,0,.3)] backdrop-blur-xl sm:p-7">
            <div className="pointer-events-none absolute -right-14 -top-16 h-48 w-48 rounded-full bg-purple-500/10 blur-3xl" />
            <div className="relative flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-purple-400/25 bg-purple-950/60 font-mono font-bold text-pink-200">{coin.id}</div>
                <div>
                  <h2 className="text-lg font-bold text-white">{coin.id}<span className="text-slate-400">/USDT</span></h2>
                  <p className="mt-0.5 text-[10px] text-slate-500">{new Date(trade.openedAt).toLocaleString()}</p>
                </div>
              </div>
              <span className={`rounded-full border px-3 py-1 text-[10px] font-mono font-bold tracking-wider ${
                trade.side === 'LONG' ? 'border-pink-300/30 bg-pink-500/15 text-pink-200' : 'border-fuchsia-300/30 bg-fuchsia-500/10 text-fuchsia-200'
              }`}>{trade.side}</span>
            </div>

            <div className="mt-6 grid grid-cols-2 gap-3">
              <div className="rounded-2xl border border-purple-400/10 bg-black/20 p-3">
                <p className="text-[10px] uppercase tracking-wider text-slate-500">Entry price</p>
                <p className="mt-1 font-mono text-sm text-slate-200">${formatPrice(trade.entryPrice, coin.decimals)}</p>
              </div>
              <div className="rounded-2xl border border-purple-400/10 bg-black/20 p-3">
                <p className="text-[10px] uppercase tracking-wider text-slate-500">Live Binance price</p>
                <p className="mt-1 font-mono text-sm text-white">${formatPrice(market.price, coin.decimals)}</p>
                {market.priceSource === 'ORDER_BOOK_MID' && <p className="mt-1 text-[9px] text-slate-500">Live L2 midpoint</p>}
              </div>
            </div>

            <div className={`mt-4 rounded-2xl border p-4 ${pnl.pnlUsd >= 0 ? 'border-emerald-400/20 bg-emerald-950/20' : 'border-pink-400/20 bg-pink-950/20'}`}>
              <p className="text-[10px] uppercase tracking-[.18em] text-slate-400">Estimated net P&amp;L · live mark</p>
              <div className={`mt-1 flex flex-wrap items-baseline gap-x-3 font-mono ${pnl.pnlUsd >= 0 ? 'text-emerald-300' : 'text-pink-300'}`}>
                <span className="text-2xl font-bold">{pnl.pnlUsd >= 0 ? '+' : ''}{formatUsd(pnl.pnlUsd)}</span>
                <span className="text-sm">{pnl.pnlPercent >= 0 ? '+' : ''}{pnl.pnlPercent.toFixed(2)}%</span>
              </div>
              <p className="mt-2 text-[10px] text-slate-500">Includes entry fee and estimated {(takerFeeRate * 100).toFixed(3)}% exit fee · Wallet realized: {realizedPnl === null ? '—' : formatUsd(realizedPnl)}</p>
            </div>

            <div className="mt-5 rounded-2xl border border-purple-400/10 bg-black/15 p-4">
              <div className="flex justify-between gap-2 text-[10px] font-mono">
                <span className="text-pink-200">Stop ${formatPrice(trade.stopLoss, coin.decimals)}</span>
                <span className="text-emerald-200">Target ${formatPrice(trade.takeProfit, coin.decimals)}</span>
              </div>
              <div className="relative mt-3 h-2 overflow-hidden rounded-full bg-slate-800">
                <div className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-pink-500 via-purple-400 to-emerald-400 transition-all duration-700" style={{ width: `${Math.min(100, Math.max(0, progress))}%` }} />
              </div>
              <p className="mt-2 text-right text-[10px] text-slate-500">Position relative to backend stop and target</p>
            </div>

            <button
              disabled={pendingAction !== null}
              onClick={() => onClose(trade)}
              className="mt-5 w-full rounded-2xl border border-pink-300/30 bg-pink-500/10 px-4 py-3 text-sm font-semibold text-pink-100 transition hover:bg-pink-500/20 disabled:cursor-wait disabled:opacity-50"
            >
              {pendingAction === `close-${trade._id}` ? 'Closing position…' : 'Emergency close'}
            </button>
          </article>
        );
      })}
    </section>
  );
}

function StrategyTab({
  snapshot,
  loading,
  selectedSymbol,
  selectedCoin,
  selectedMarket,
  candles,
  candleLoading,
  candleError,
  onSelect,
  onOpenChart,
}: {
  snapshot: BackendSnapshot | null;
  loading: boolean;
  selectedSymbol: string | null;
  selectedCoin: (typeof COINS)[number] | null;
  selectedMarket: BackendMarket | null;
  candles: BackendCandle[];
  candleLoading: boolean;
  candleError: string;
  onSelect: (symbol: string) => void;
  onOpenChart: () => void;
}) {
  if (loading) return <div className="space-y-4"><SkeletonCard /><SkeletonCard /><SkeletonCard /></div>;
  return (
    <div className="space-y-5 pb-4">
      <section className="rounded-3xl border border-purple-400/15 bg-white/[0.025] p-5 backdrop-blur-xl">
        <div className="mb-4 flex items-end justify-between gap-3">
          <div>
            <p className="text-[10px] font-mono uppercase tracking-[.2em] text-pink-300/70">Live scanner</p>
            <h2 className="mt-1 text-xl font-bold text-white">Six-coin matrix</h2>
          </div>
          <span className="text-[10px] text-slate-500">Real Binance · closed-candle signals</span>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {COINS.map((coin) => {
            const market = snapshot?.markets.find((item) => item.symbol === coin.symbol);
            if (!market) return <div key={coin.symbol} className="rounded-2xl border border-pink-400/20 bg-pink-950/20 p-4 text-xs text-pink-200">Market unavailable: {coin.symbol}</div>;
            const { buyVotes, sellVotes, totalVotes, side } = market.indicators;
            return (
              <button
                key={coin.symbol}
                onClick={() => onSelect(coin.symbol)}
                aria-pressed={selectedSymbol === coin.symbol}
                className={`rounded-2xl border p-4 text-left transition-all duration-200 ${
                  selectedSymbol === coin.symbol
                    ? 'border-pink-300/40 bg-purple-500/10 shadow-[0_0_24px_rgba(236,72,153,.1)]'
                    : 'border-purple-400/12 bg-black/15 hover:border-purple-300/30 hover:bg-white/[0.035]'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-bold" style={{ color: coin.color }}>{coin.id}/USDT</span>
                  <span className={`rounded-full px-2 py-1 text-[9px] font-mono ${side ? 'bg-pink-500/10 text-pink-200' : 'bg-slate-800/80 text-slate-400'}`}>
                    {side ?? 'NEUTRAL'}
                  </span>
                </div>
                <p className="mt-3 font-mono text-lg text-white">${formatPrice(market.price, coin.decimals)}</p>
                {market.priceSource === 'ORDER_BOOK_MID' && <p className="mt-1 text-[9px] text-slate-500">Live L2 midpoint</p>}
                <div className="mt-3 flex items-center justify-between text-[10px] font-mono">
                  <span className="text-emerald-300">{buyVotes}/{totalVotes} BUY</span>
                  <span className="text-pink-300">{sellVotes}/{totalVotes} SELL</span>
                </div>
                <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-slate-800">
                  <span className="bg-emerald-400/80" style={{ width: `${(buyVotes / totalVotes) * 100}%` }} />
                  <span className="bg-pink-400/80" style={{ width: `${(sellVotes / totalVotes) * 100}%` }} />
                </div>
              </button>
            );
          })}
        </div>
      </section>

      {selectedCoin && selectedMarket && (
        <section className="rounded-3xl border border-purple-300/20 bg-white/[0.03] p-5 shadow-xl backdrop-blur-xl sm:p-6">
          <div className="flex flex-col justify-between gap-3 border-b border-purple-400/10 pb-4 sm:flex-row sm:items-center">
            <div>
              <p className="text-[10px] font-mono uppercase tracking-[.2em] text-pink-300/70">Real-data inspector</p>
              <h2 className="mt-1 text-lg font-bold text-white">{selectedCoin.symbol} <span className="text-sm font-normal text-slate-400">{selectedCoin.name}</span></h2>
              <p className="mt-1 font-mono text-sm text-purple-200">
                ${formatPrice(selectedMarket.price, selectedCoin.decimals)}
                <span className="ml-2 text-[10px] text-slate-500">
                  {selectedMarket.priceSource === 'ORDER_BOOK_MID' ? 'Binance L2 midpoint' : 'Binance last trade'}
                </span>
              </p>
            </div>
            <button
              disabled={candleLoading || Boolean(candleError) || candles.length !== 500}
              onClick={onOpenChart}
              className="rounded-xl border border-pink-300/25 bg-pink-500/10 px-4 py-2.5 text-xs font-semibold text-pink-100 transition hover:bg-pink-500/20 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {candleLoading ? 'Loading verified candles…' : 'Open candlestick chart'}
            </button>
          </div>

          {candleLoading && <div className="mt-4"><SkeletonCard /></div>}
          {candleError && <p role="alert" className="mt-4 rounded-xl border border-pink-400/25 bg-pink-950/20 p-3 text-xs text-pink-200">{candleError}</p>}

          <div className="mt-5 grid gap-4 lg:grid-cols-2">
            <div>
              <div className="mb-3 flex items-end justify-between">
                <h3 className="text-sm font-semibold text-white">Backend indicator votes</h3>
                <span className="rounded-full border border-purple-300/20 bg-purple-500/10 px-2.5 py-1 text-[10px] font-mono text-purple-100">
                  {selectedMarket.indicators.buyVotes}/{selectedMarket.indicators.totalVotes} BUY
                </span>
              </div>
              <div className="space-y-2">
                {selectedMarket.indicators.indicators.map((indicator, index) => (
                  <div key={indicator.name} className="flex items-center justify-between gap-3 rounded-xl border border-purple-400/10 bg-black/15 px-3 py-2.5">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="w-5 shrink-0 text-[9px] font-mono text-slate-600">{String(index + 1).padStart(2, '0')}</span>
                      <div className="min-w-0">
                        <p className="truncate text-xs font-medium text-slate-200">{indicator.name}</p>
                        <p className="truncate text-[10px] text-slate-500">{formatIndicatorValue(indicator.value, selectedCoin.decimals)}</p>
                      </div>
                    </div>
                    <span className={`shrink-0 rounded-lg px-2 py-1 text-[9px] font-mono font-bold ${voteClass(indicator.vote)}`}>{indicator.vote}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="space-y-4">
              <div className="rounded-2xl border border-purple-400/12 bg-purple-950/15 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold text-white">Real volume vs prior 20 candles</p>
                    <p className="mt-1 text-[10px] text-slate-500">Current closed Binance candle / mean of previous 20</p>
                  </div>
                  <span className="rounded-full border border-purple-300/20 bg-purple-500/10 px-3 py-1.5 font-mono text-sm text-purple-100">{selectedMarket.indicators.volumeRatio.toFixed(2)}x</span>
                </div>
                <div className="mt-3 flex justify-between text-[10px] font-mono text-slate-400">
                  <span>Current {selectedMarket.indicators.currentVolume.toLocaleString()}</span>
                  <span>20 avg {selectedMarket.indicators.averageVolume.toLocaleString()}</span>
                </div>
              </div>

              <div className="rounded-2xl border border-purple-400/12 bg-purple-950/15 p-4">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-xs font-semibold text-white">Binance L2 · top 20</h3>
                  <span className="text-[9px] text-slate-500">Snapshot {new Date(selectedMarket.orderBook.updatedAt).toLocaleTimeString()}</span>
                </div>
                <div className="flex justify-between text-[10px] font-mono">
                  <span className="text-emerald-300">{selectedMarket.indicators.orderBookPressure.bidPercent.toFixed(1)}% bids</span>
                  <span className="text-pink-300">{selectedMarket.indicators.orderBookPressure.askPercent.toFixed(1)}% asks</span>
                </div>
                <div className="mt-2 flex h-2 overflow-hidden rounded-full bg-slate-800">
                  <div className="bg-emerald-400 transition-all" style={{ width: `${selectedMarket.indicators.orderBookPressure.bidPercent}%` }} />
                  <div className="bg-pink-400 transition-all" style={{ width: `${selectedMarket.indicators.orderBookPressure.askPercent}%` }} />
                </div>
                <div className="mt-3 grid grid-cols-2 gap-3 text-[10px] font-mono">
                  <span className="text-slate-400">Best bid <b className="text-emerald-200">{formatPrice(selectedMarket.orderBook.bestBid, selectedCoin.decimals)}</b></span>
                  <span className="text-right text-slate-400">Best ask <b className="text-pink-200">{formatPrice(selectedMarket.orderBook.bestAsk, selectedCoin.decimals)}</b></span>
                </div>
              </div>

              <SwingRiskPanel candles={candles} market={selectedMarket} decimals={selectedCoin.decimals} loading={candleLoading} error={candleError} />
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

function SwingRiskPanel({ candles, market, decimals, loading, error }: {
  candles: BackendCandle[];
  market: BackendMarket;
  decimals: number;
  loading: boolean;
  error: string;
}) {
  if (loading) return <SkeletonCard />;
  if (error || candles.length !== 500) return (
    <div className="rounded-2xl border border-purple-400/10 bg-black/15 p-4 text-xs text-slate-500">
      Swing-risk view requires all 500 verified closed candles.
    </div>
  );
  const recent = candles.slice(-50);
  const high = Math.max(...recent.map((candle) => candle.high));
  const low = Math.min(...recent.map((candle) => candle.low));
  const atrDistance = market.indicators.atr * 1.5;
  const nearLow = market.price - low <= market.indicators.atr * 0.45;
  const nearHigh = high - market.price <= market.indicators.atr * 0.45;
  return (
    <div className="rounded-2xl border border-purple-400/12 bg-purple-950/15 p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-white">Recent swing &amp; ATR risk</h3>
        {(nearLow || nearHigh)
          ? <span className="rounded-full border border-amber-300/20 bg-amber-500/10 px-2 py-1 text-[9px] text-amber-200">Near recent swing · wick risk</span>
          : <span className="rounded-full border border-emerald-300/15 bg-emerald-500/5 px-2 py-1 text-[9px] text-emerald-200">Between recent swings</span>}
      </div>
      <p className="mt-2 text-[10px] leading-relaxed text-slate-500">Uses actual highs/lows from the latest 50 closed candles; this is a swing-price warning, not a liquidation-map estimate.</p>
      <div className="mt-3 grid grid-cols-2 gap-3 text-[10px] font-mono">
        <span className="text-slate-400">50-candle high <b className="text-slate-200">{formatPrice(high, decimals)}</b></span>
        <span className="text-right text-slate-400">50-candle low <b className="text-slate-200">{formatPrice(low, decimals)}</b></span>
        <span className="col-span-2 text-purple-200">ATR stop distance (1.5×): {formatPrice(atrDistance, decimals)}</span>
      </div>
    </div>
  );
}

function HealthTab({
  snapshot,
  loading,
  latencyMs,
  tickAgeMs,
  events,
  auditError,
  actionPending,
  onSetEnabled,
}: {
  snapshot: BackendSnapshot | null;
  loading: boolean;
  latencyMs: number | null;
  tickAgeMs: number | null;
  events: BackendAuditEvent[];
  auditError: string;
  actionPending: string | null;
  onSetEnabled: (enabled: boolean) => void;
}) {
  if (loading) return <div className="space-y-4"><SkeletonCard /><SkeletonCard /></div>;
  const feedOk = Boolean(snapshot?.status.feedConnected && snapshot.status.marketDataReady);
  const riskOk = Boolean(snapshot && snapshot.status.riskPercent <= 2);
  const targetEnabled = Boolean(snapshot?.status.enabled);
  return (
    <div className="space-y-5">
      <section>
        <p className="text-[10px] font-mono uppercase tracking-[.2em] text-pink-300/70">Engine diagnostics</p>
        <h2 className="mt-1 text-xl font-bold text-white">Brain health &amp; risk shield</h2>
      </section>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <HealthCard icon={<Radio />} label="Binance WebSocket" value={snapshot?.status.feedConnected ? 'Connected' : 'Disconnected'} ok={Boolean(snapshot?.status.feedConnected)} />
        <HealthCard icon={<CheckCircle2 />} label="Market readiness" value={snapshot?.status.marketDataReady ? '6 markets verified' : 'Data gate closed'} ok={feedOk} />
        <HealthCard icon={<RefreshCw />} label="API refresh latency" value={latencyMs === null ? 'Unavailable' : `${latencyMs} ms`} ok={latencyMs !== null && latencyMs < 1500} />
        <HealthCard icon={<Clock />} label="Oldest live quote" value={tickAgeMs === null ? 'Unavailable' : `${(tickAgeMs / 1000).toFixed(1)} sec`} ok={tickAgeMs !== null && tickAgeMs <= 15_000} />
        <HealthCard icon={<Shield />} label="Strict risk shield" value={snapshot ? `${snapshot.status.riskPercent}% per trade` : 'Unavailable'} ok={riskOk} />
        <HealthCard icon={<CheckCircle2 />} label="Binance taker fee" value={snapshot ? `${(snapshot.status.takerFeeRate * 100).toFixed(3)}% per fill` : 'Unavailable'} ok={Boolean(snapshot)} />
      </div>

      <section className="rounded-3xl border border-purple-400/15 bg-white/[0.025] p-5 backdrop-blur-xl">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
          <div>
            <div className="flex items-center gap-2">
              <LockKeyhole className="h-4 w-4 text-purple-200" />
              <h3 className="text-sm font-semibold text-white">Entry circuit breaker</h3>
            </div>
            <p className="mt-1 text-xs text-slate-500">Backend state: {targetEnabled ? 'enabled' : 'paused'} · Open positions remain monitored.</p>
            <p className="mt-2 max-w-xl text-[10px] leading-relaxed text-slate-500">
              Start/stop and close actions use a server-side gateway; the private token is never shipped to browser code. Keep Vercel Deployment Protection enabled and restrict access to trusted users.
            </p>
          </div>
          <button
            disabled={!snapshot || actionPending !== null}
            onClick={() => onSetEnabled(!targetEnabled)}
            className={`rounded-xl border px-4 py-2.5 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${
              targetEnabled ? 'border-pink-300/25 bg-pink-500/10 text-pink-100 hover:bg-pink-500/20' : 'border-purple-300/25 bg-purple-500/10 text-purple-100 hover:bg-purple-500/20'
            }`}
          >
            {actionPending?.startsWith('bot-') ? 'Sending…' : targetEnabled ? 'Pause entries' : 'Enable entries'}
          </button>
        </div>
      </section>

      <section className="rounded-3xl border border-purple-400/15 bg-white/[0.025] p-5">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-white">Per-market feed health</h3>
          <span className="text-[9px] font-mono text-slate-500">Fresh tick · 500 closed candles · L2 top 20</span>
        </div>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {(snapshot?.markets ?? []).map((market) => (
            <div key={market.symbol} className="flex items-center justify-between rounded-xl border border-purple-400/10 bg-black/15 px-3 py-2.5">
              <span className="text-xs font-mono text-slate-300">{market.symbol}</span>
              <span className="text-[9px] text-emerald-200">{(market.marketAgeMs / 1000).toFixed(1)}s · {market.candleCount} · {market.orderBook.levelCount} levels</span>
            </div>
          ))}
          {snapshot?.markets.length === 0 && <p className="text-xs text-slate-500">Live market details unavailable.</p>}
        </div>
      </section>

      <section className="rounded-3xl border border-purple-400/15 bg-white/[0.025] p-5">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-white">Tactical audit log</h3>
            <p className="mt-1 text-[10px] text-slate-500">Backend-recorded feed and paper engine events</p>
          </div>
          <Activity className="h-4 w-4 text-pink-300" />
        </div>
        {auditError && <p role="alert" className="mb-3 text-xs text-pink-200">{auditError}</p>}
        {!auditError && events.length === 0 && <p className="py-5 text-center text-xs text-slate-500">No backend audit events recorded in this process.</p>}
        <div className="space-y-2">
          {events.slice(0, 20).map((event) => (
            <div key={event.id} className="flex items-start gap-3 rounded-xl border border-purple-400/10 bg-black/15 px-3 py-2.5">
              <span className={`mt-0.5 rounded-md px-1.5 py-1 text-[8px] font-mono font-bold ${
                event.type === 'TRADE' ? 'bg-pink-500/10 text-pink-200' : event.type === 'FEED' ? 'bg-amber-500/10 text-amber-200' : 'bg-purple-500/10 text-purple-200'
              }`}>{event.type}</span>
              <div className="min-w-0 flex-1">
                <p className="text-xs text-slate-300">{event.message}</p>
                <p className="mt-1 text-[9px] text-slate-600">{event.symbol ? `${event.symbol} · ` : ''}{new Date(event.time).toLocaleString()}</p>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function WalletTab({
  snapshot,
  loading,
  closedTrades,
  startingBalance,
  onOpenSettings,
}: {
  snapshot: BackendSnapshot | null;
  loading: boolean;
  closedTrades: BackendTrade[];
  startingBalance: number | null;
  onOpenSettings: () => void;
}) {
  const heading = (
    <section className="flex items-start justify-between gap-4">
      <div>
        <p className="text-[10px] font-mono uppercase tracking-[.2em] text-pink-300/70">Paper account</p>
        <h2 className="mt-1 text-xl font-bold text-white">Wallet &amp; funds</h2>
      </div>
      <button
        type="button"
        onClick={onOpenSettings}
        className="flex shrink-0 items-center gap-2 rounded-xl border border-purple-300/20 bg-purple-500/10 px-3 py-2 text-xs font-semibold text-purple-100 transition hover:border-pink-300/40 hover:bg-purple-500/20"
      >
        <Settings className="h-4 w-4" />
        Settings
      </button>
    </section>
  );
  if (loading) return <div className="space-y-4">{heading}<SkeletonCard /><SkeletonCard /><SkeletonCard /></div>;
  if (!snapshot || startingBalance === null) {
    return <div className="space-y-4">{heading}<p className="rounded-2xl border border-pink-400/20 bg-pink-950/20 p-5 text-sm text-pink-100">Wallet data unavailable.</p></div>;
  }
  const equity = [startingBalance];
  const recentPnl = closedTrades.reduce((total, trade) => total + trade.pnlUsd, 0);
  equity[0] = snapshot.wallet.balance - recentPnl;
  for (const trade of closedTrades) equity.push(equity[equity.length - 1] + trade.pnlUsd);
  const low = Math.min(...equity);
  const high = Math.max(...equity);
  const range = high - low;
  const points = equity.map((value, index) => {
    const x = equity.length <= 1 ? 250 : 12 + (index / (equity.length - 1)) * 476;
    const y = range > 0 ? 116 - ((value - low) / range) * 100 : 66;
    return `${x},${y}`;
  }).join(' ');
  const coinDecimals = (symbol: string) => COINS.find((coin) => coin.symbol === symbol)?.decimals ?? 2;
  return (
    <div className="space-y-5">
      {heading}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <WalletCard label="Starting margin" value={formatUsd(startingBalance)} note="Derived from wallet balance less realized P&L" />
        <WalletCard label="Current balance" value={formatUsd(snapshot.wallet.balance)} note={`Available ${formatUsd(snapshot.wallet.availableMargin)} · reserved ${formatUsd(snapshot.wallet.inTradeMargin)}`} />
        <WalletCard label="Realized net P&L" value={formatUsd(snapshot.wallet.totalRealizedPnl)} note={`${snapshot.wallet.winCount} wins · ${snapshot.wallet.lossCount} losses`} accent={snapshot.wallet.totalRealizedPnl >= 0} />
      </div>

      <section className="rounded-3xl border border-purple-400/15 bg-white/[0.025] p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-white">Realized equity curve</h3>
            <p className="mt-1 text-[10px] text-slate-500">Wallet balance reconstructed across the latest closed trades, oldest to newest</p>
          </div>
          <span className="rounded-full border border-purple-300/15 bg-purple-500/10 px-2.5 py-1 text-[9px] text-purple-200">Last {closedTrades.length} closed trades</span>
        </div>
        {closedTrades.length === 0 ? (
          <div className="flex h-40 items-center justify-center text-xs text-slate-500">No closed-trade history to plot yet.</div>
        ) : (
          <div className="mt-4">
            <svg viewBox="0 0 500 135" role="img" aria-label="Realized paper wallet equity from recorded closed trades" className="h-40 w-full overflow-visible">
              <defs>
                <linearGradient id="realEquityFill" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor="#ec4899" stopOpacity=".25" />
                  <stop offset="100%" stopColor="#a855f7" stopOpacity="0" />
                </linearGradient>
              </defs>
              {[25, 65, 105].map((y) => <line key={y} x1="8" x2="492" y1={y} y2={y} stroke="#a78bfa" strokeOpacity=".12" strokeDasharray="4 5" />)}
              <polygon points={`12,125 ${points} 488,125`} fill="url(#realEquityFill)" />
              <polyline points={points} fill="none" stroke="#f472b6" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
              {equity.length > 0 && <circle cx={equity.length <= 1 ? 250 : 488} cy={range > 0 ? 116 - ((equity[equity.length - 1] - low) / range) * 100 : 66} r="4" fill="#f472b6" />}
            </svg>
            <div className="flex justify-between border-t border-purple-400/10 pt-3 text-[10px] font-mono text-slate-500">
              <span>Before shown trades {formatUsd(equity[0])}</span><span>Current {formatUsd(snapshot.wallet.balance)}</span>
            </div>
          </div>
        )}
      </section>

      <section className="rounded-3xl border border-purple-400/15 bg-white/[0.025] p-5">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-white">Closed paper trades</h3>
            <p className="mt-1 text-[10px] text-slate-500">MongoDB audit records · latest 200</p>
          </div>
          <Clock className="h-4 w-4 text-purple-300" />
        </div>
        {closedTrades.length === 0 ? <p className="py-6 text-center text-xs text-slate-500">No closed paper trades.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[740px] text-left text-[10px] font-mono">
              <thead className="text-slate-500">
                <tr>
                  <th className="pb-3 pr-3">Pair / side</th><th className="pb-3 pr-3">Entry</th><th className="pb-3 pr-3">Exit</th>
                  <th className="pb-3 pr-3">Fees</th><th className="pb-3 pr-3">Net P&amp;L</th><th className="pb-3 pr-3">Exit reason</th><th className="pb-3">Closed</th>
                </tr>
              </thead>
              <tbody>
                {[...closedTrades].reverse().map((trade) => (
                  <tr key={trade._id} className="border-t border-purple-400/10">
                    <td className="py-3 pr-3 text-slate-200">{trade.symbol} <span className={trade.side === 'LONG' ? 'text-emerald-300' : 'text-pink-300'}>{trade.side}</span></td>
                    <td className="py-3 pr-3 text-slate-300">{formatPrice(trade.entryPrice, coinDecimals(trade.symbol))}</td>
                    <td className="py-3 pr-3 text-slate-300">{trade.exitPrice === null ? '—' : formatPrice(trade.exitPrice, coinDecimals(trade.symbol))}</td>
                    <td className="py-3 pr-3 text-slate-400">{formatUsd(trade.totalFeesUsd ?? 0)}</td>
                    <td className={`py-3 pr-3 ${trade.pnlUsd >= 0 ? 'text-emerald-300' : 'text-pink-300'}`}>{trade.pnlUsd >= 0 ? '+' : ''}{formatUsd(trade.pnlUsd)}</td>
                    <td className="py-3 pr-3 text-slate-400">{exitReason(trade.closeReason)}</td>
                    <td className="py-3 text-slate-500">{trade.closedAt ? new Date(trade.closedAt).toLocaleString() : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function SkeletonCard() {
  return (
    <div aria-label="Loading live data" className="rounded-3xl border border-purple-400/15 bg-white/[0.025] p-5">
      <div className="h-3 w-1/3 animate-pulse rounded-full bg-purple-400/15" />
      <div className="mt-4 h-7 w-2/3 animate-pulse rounded-xl bg-purple-400/10" />
      <div className="mt-5 h-16 animate-pulse rounded-2xl bg-purple-400/[0.06]" />
    </div>
  );
}

function HealthCard({ icon, label, value, ok }: { icon: React.ReactNode; label: string; value: string; ok: boolean }) {
  return (
    <div className="rounded-2xl border border-purple-400/12 bg-white/[0.025] p-4">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 text-[10px] text-slate-400">{icon}{label}</span>
        <span className={`h-1.5 w-1.5 rounded-full ${ok ? 'bg-emerald-400' : 'bg-pink-400'}`} />
      </div>
      <p className="mt-3 text-sm font-semibold text-slate-100">{value}</p>
    </div>
  );
}

function WalletSettings({
  appInstalled,
  canInstall,
  installMessage,
  onBack,
  onInstall,
}: {
  appInstalled: boolean;
  canInstall: boolean;
  installMessage: string;
  onBack: () => void;
  onInstall: () => void;
}) {
  return (
    <div className="space-y-5">
      <section>
        <button
          type="button"
          onClick={onBack}
          className="mb-4 inline-flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-slate-300 transition hover:bg-white/5 hover:text-white"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to wallet
        </button>
        <p className="text-[10px] font-mono uppercase tracking-[.2em] text-pink-300/70">Preferences</p>
        <h2 className="mt-1 text-xl font-bold text-white">App settings</h2>
      </section>

      <section className="rounded-3xl border border-purple-400/15 bg-white/[0.025] p-5 sm:p-6">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-purple-300/20 bg-purple-500/10">
              <Smartphone className="h-5 w-5 text-pink-200" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-white">Install AuraAlgo</h3>
              <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
                Add to your home screen.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onInstall}
            disabled={appInstalled}
            className="flex shrink-0 items-center justify-center gap-2 rounded-xl border border-pink-300/30 bg-pink-500/15 px-3 py-2.5 text-xs font-semibold text-pink-100 transition hover:bg-pink-500/25 disabled:cursor-default disabled:border-emerald-300/20 disabled:bg-emerald-500/10 disabled:text-emerald-100"
          >
            {appInstalled ? <CheckCircle2 className="h-4 w-4" /> : <Download className="h-4 w-4" />}
            {appInstalled ? 'Installed' : canInstall ? 'Install app' : 'Install'}
          </button>
        </div>

        {installMessage && (
          <p role="status" className="mt-3 rounded-xl border border-purple-300/15 bg-purple-950/30 p-3 text-xs leading-relaxed text-purple-100">
            {installMessage}
          </p>
        )}

        {!appInstalled && !canInstall && !installMessage && (
          <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
            On iPhone/iPad, use Safari’s Share button and choose “Add to Home Screen”. On Android, use the browser menu and choose “Install app” or “Add to Home screen”.
          </p>
        )}
      </section>

      <section className="rounded-3xl border border-purple-400/15 bg-white/[0.025] p-5">
        <h3 className="text-sm font-semibold text-white">Using AuraAlgo offline</h3>
        <p className="mt-2 text-xs leading-relaxed text-slate-400">
          The app shell can reopen when cached, but live Binance prices, account data, and paper-trade updates require an internet connection. Offline requests are never replaced with demo data.
        </p>
      </section>
    </div>
  );
}

function WalletCard({ label, value, note, accent }: { label: string; value: string; note: string; accent?: boolean }) {
  return (
    <div className="rounded-2xl border border-purple-400/12 bg-white/[0.025] p-4">
      <p className="text-[10px] uppercase tracking-wider text-slate-500">{label}</p>
      <p className={`mt-2 font-mono text-xl font-semibold ${accent === undefined ? 'text-white' : accent ? 'text-emerald-300' : 'text-pink-300'}`}>{value}</p>
      <p className="mt-2 text-[10px] text-slate-500">{note}</p>
    </div>
  );
}

function voteClass(vote: 'BUY' | 'SELL' | 'NEUTRAL') {
  if (vote === 'BUY') return 'border border-emerald-400/20 bg-emerald-500/10 text-emerald-200';
  if (vote === 'SELL') return 'border border-pink-400/20 bg-pink-500/10 text-pink-200';
  return 'border border-slate-600/40 bg-slate-800/70 text-slate-300';
}

function formatIndicatorValue(value: unknown, decimals: number): string {
  if (typeof value === 'number') return Number.isFinite(value) ? value.toLocaleString('en-US', { maximumFractionDigits: decimals + 2 }) : '—';
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    return Object.entries(value)
      .filter(([, item]) => typeof item === 'number' || typeof item === 'string')
      .map(([key, item]) => `${key}: ${typeof item === 'number' ? item.toLocaleString('en-US', { maximumFractionDigits: decimals + 2 }) : item}`)
      .join(' · ');
  }
  return 'Calculated from closed Binance candles';
}

function exitReason(reason: BackendTrade['closeReason']) {
  if (reason === 'TAKE_PROFIT') return 'TP hit';
  if (reason === 'STOP_LOSS') return 'SL hit';
  if (reason === 'EARLY_MOMENTUM_REVERSAL') return 'Momentum reversal';
  if (reason === 'MANUAL') return 'Manual close';
  return 'Not recorded';
}
