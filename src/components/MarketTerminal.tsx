import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, BarChart2, Search, X } from 'lucide-react';
import {
  connectBinanceStream,
  fetchClosedCandles,
  normalizeUsdtSymbol,
  TERMINAL_TIMEFRAMES,
  type LiveKline,
  type TerminalTimeframe,
} from '../services/binanceMarketData';
import { analyzeClosedCandles, type ClosedCandle } from '../utils/indicators';

const TerminalChart = lazy(() => import('./TerminalChart').then((module) => ({
  default: module.TerminalChart,
})));

const QUICK_PAIRS = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX', 'SUI', 'NEAR', 'PEPE'];
const INTERVAL_MS: Record<TerminalTimeframe, number> = {
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

export interface TerminalQuote {
  symbol: string;
  price: number;
  atr: number;
  isLive: boolean;
  updatedAt: number;
}

interface MarketTerminalProps {
  onQuoteChange?: (quote: TerminalQuote | null) => void;
}

function priceDecimals(price: number): number {
  if (price >= 100) return 2;
  if (price >= 1) return 4;
  return 6;
}

function formatCountdown(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function MarketTerminal({ onQuoteChange }: MarketTerminalProps) {
  const [symbol, setSymbol] = useState('BTCUSDT');
  const [timeframe, setTimeframe] = useState<TerminalTimeframe>('15m');
  const [customSymbol, setCustomSymbol] = useState('');
  const [candles, setCandles] = useState<ClosedCandle[]>([]);
  const [liveCandle, setLiveCandle] = useState<LiveKline | null>(null);
  const [price, setPrice] = useState<number | null>(null);
  const [priceUpdatedAt, setPriceUpdatedAt] = useState<number | null>(null);
  const [previousDayPrice, setPreviousDayPrice] = useState<number | null>(null);
  const [tickCount, setTickCount] = useState(0);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [chartOpen, setChartOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const quoteHandler = useRef(onQuoteChange);
  quoteHandler.current = onQuoteChange;

  useEffect(() => {
    let disposed = false;
    let disconnect: (() => void) | null = null;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setConnected(false);
    setCandles([]);
    setLiveCandle(null);
    setPrice(null);
    setPriceUpdatedAt(null);
    setTickCount(0);

    void fetchClosedCandles(symbol, timeframe, controller.signal)
      .then((history) => {
        if (disposed) return;
        setCandles(history);
        const latest = history[history.length - 1];
        setPrice(latest.close);
        const dayAgo = latest.openTime - 86_400_000;
        const reference = [...history].reverse().find((candle) => candle.openTime <= dayAgo);
        setPreviousDayPrice(reference?.close ?? history[0].open);
        setLoading(false);
        disconnect = connectBinanceStream(symbol, timeframe, {
          onConnectionChange: (value) => {
            if (!disposed) setConnected(value);
          },
          onPrice: (nextPrice, eventTime) => {
            if (disposed) return;
            setPrice(nextPrice);
            setPriceUpdatedAt(eventTime);
            setTickCount((count) => count + 1);
          },
          onCandle: (candle) => {
            if (disposed) return;
            if (candle.isClosed) {
              setCandles((current) => {
                if (current[current.length - 1]?.openTime === candle.openTime) {
                  return [...current.slice(0, -1), candle].slice(-500);
                }
                return [...current, candle].slice(-500);
              });
              setLiveCandle(null);
            } else {
              setLiveCandle(candle);
            }
          },
          onError: (message) => {
            if (!disposed) setError(message);
          },
        });
      })
      .catch((cause: unknown) => {
        if (disposed || (cause instanceof DOMException && cause.name === 'AbortError')) return;
        setError(cause instanceof Error ? cause.message : 'Unable to load Binance market history.');
        setLoading(false);
      });

    return () => {
      disposed = true;
      controller.abort();
      disconnect?.();
    };
  }, [symbol, timeframe]);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const openChart = () => setChartOpen(true);
    window.addEventListener('auraalgo:open-terminal-chart', openChart);
    return () => window.removeEventListener('auraalgo:open-terminal-chart', openChart);
  }, []);

  const analysis = useMemo(() => {
    if (candles.length < 250) return null;
    try {
      return analyzeClosedCandles(candles);
    } catch (cause) {
      console.warn('Terminal indicators are unavailable for the current candle history.', cause);
      return null;
    }
  }, [candles]);

  useEffect(() => {
    quoteHandler.current?.(price !== null && analysis
      ? {
          symbol,
          price,
          atr: analysis.atr,
          isLive: connected && priceUpdatedAt !== null,
          updatedAt: priceUpdatedAt ?? 0,
        }
      : null);
  }, [analysis, connected, price, priceUpdatedAt, symbol]);

  const percentChange = price !== null && previousDayPrice
    ? ((price / previousDayPrice) - 1) * 100
    : null;
  const closeAt = liveCandle
    ? liveCandle.closeTime + 1
    : candles.length ? candles[candles.length - 1].closeTime + 1 + INTERVAL_MS[timeframe] : null;
  const countdown = closeAt === null ? '—' : formatCountdown(closeAt - now);

  function chooseSymbol(value: string) {
    try {
      const normalized = normalizeUsdtSymbol(value);
      setSymbol(normalized);
      setCustomSymbol(normalized.replace(/USDT$/, ''));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Invalid Binance symbol.');
    }
  }

  return (
    <>
      <section id="market-terminal" className="mb-5 rounded-3xl border border-purple-400/15 bg-white/[0.025] p-4 shadow-xl backdrop-blur-xl sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-mono uppercase tracking-[.2em] text-pink-300/70">Live market terminal</p>
            <h2 className="mt-1 text-lg font-bold text-white">{symbol} <span className="text-xs font-normal text-slate-400">Binance Spot</span></h2>
          </div>
          <button
            type="button"
            disabled={loading || candles.length < 250}
            onClick={() => setChartOpen(true)}
            className="inline-flex items-center gap-2 rounded-xl border border-pink-300/25 bg-pink-500/10 px-3 py-2 text-xs font-semibold text-pink-100 transition hover:bg-pink-500/20 disabled:opacity-40"
          >
            <BarChart2 className="h-4 w-4" />
            Open interactive chart
          </button>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {QUICK_PAIRS.map((pair) => (
            <button
              key={pair}
              type="button"
              onClick={() => chooseSymbol(pair)}
              aria-pressed={symbol === `${pair}USDT`}
              className={`rounded-lg border px-2.5 py-1.5 text-[10px] font-mono transition ${
                symbol === `${pair}USDT`
                  ? 'border-pink-300/35 bg-pink-500/15 text-pink-100'
                  : 'border-purple-400/15 bg-black/15 text-slate-400 hover:text-white'
              }`}
            >
              {pair}
            </button>
          ))}
          <form
            className="flex min-w-[180px] flex-1 items-center gap-1 rounded-lg border border-purple-400/15 bg-black/20 px-2"
            onSubmit={(event) => {
              event.preventDefault();
              chooseSymbol(customSymbol);
            }}
          >
            <Search className="h-3.5 w-3.5 text-slate-500" />
            <input
              aria-label="Custom USDT symbol"
              value={customSymbol}
              onChange={(event) => setCustomSymbol(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
              placeholder="Custom symbol"
              className="min-w-0 flex-1 bg-transparent py-1.5 text-[10px] text-slate-200 outline-none placeholder:text-slate-600"
            />
            <button type="submit" className="text-[10px] font-semibold text-purple-200">Go</button>
          </form>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          {TERMINAL_TIMEFRAMES.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setTimeframe(item)}
              aria-pressed={timeframe === item}
              className={`rounded-lg px-3 py-1.5 text-[10px] font-mono ${
                timeframe === item ? 'bg-purple-400/20 text-purple-100' : 'bg-black/20 text-slate-400 hover:text-white'
              }`}
            >
              {item}
            </button>
          ))}
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2 rounded-2xl border border-purple-400/10 bg-black/20 p-3 sm:grid-cols-5">
          <div>
            <p className="text-[9px] uppercase text-slate-500">Live price</p>
            <p className="mt-1 font-mono text-sm text-white">{price === null ? '—' : `$${price.toLocaleString('en-US', { minimumFractionDigits: priceDecimals(price), maximumFractionDigits: priceDecimals(price) })}`}</p>
          </div>
          <div>
            <p className="text-[9px] uppercase text-slate-500">24h change</p>
            <p className={`mt-1 font-mono text-sm ${percentChange === null ? 'text-slate-400' : percentChange >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
              {percentChange === null ? '—' : `${percentChange >= 0 ? '+' : ''}${percentChange.toFixed(2)}%`}
            </p>
          </div>
          <div>
            <p className="text-[9px] uppercase text-slate-500">WebSocket</p>
            <p className={`mt-1 flex items-center gap-1 font-mono text-xs ${connected ? 'text-emerald-300' : 'text-rose-300'}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-emerald-400' : 'bg-rose-400'}`} />
              {connected ? 'Connected' : 'Reconnecting'}
            </p>
          </div>
          <div>
            <p className="text-[9px] uppercase text-slate-500">Live ticks</p>
            <p className="mt-1 font-mono text-sm text-purple-200">{tickCount.toLocaleString()}</p>
          </div>
          <div>
            <p className="text-[9px] uppercase text-slate-500">Candle closes in</p>
            <p className="mt-1 flex items-center gap-1 font-mono text-sm text-amber-200"><Activity className="h-3 w-3" />{countdown}</p>
          </div>
        </div>
        {analysis && (
          <div className="mt-3 flex flex-wrap items-center gap-3 text-[10px] text-slate-400">
            <span>Closed-candle ATR(14): <b className="font-mono text-slate-200">{analysis.atr.toPrecision(5)}</b></span>
            <span>Consensus: <b className="font-mono text-slate-200">{analysis.bullishCount} BUY / {analysis.bearishCount} SELL</b></span>
            {analysis.side && <span className="rounded-full border border-emerald-300/20 bg-emerald-500/10 px-2 py-1 font-mono text-emerald-200">{analysis.side} candidate</span>}
          </div>
        )}
        {loading && <p role="status" className="mt-3 text-xs text-purple-200">Loading at least 250 finalized Binance candles…</p>}
        {error && <p role="alert" className="mt-3 break-words rounded-xl border border-rose-400/20 bg-rose-950/20 p-3 text-xs text-rose-200">{error}</p>}
        {!loading && candles.length >= 250 && !error && (
          <p className="mt-3 text-[10px] text-slate-500">{candles.length} contiguous closed {timeframe} candles verified. Chart and indicator calculations use Binance public market data.</p>
        )}
      </section>

      {chartOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-2 sm:p-5">
          <section role="dialog" aria-modal="true" aria-labelledby="terminal-chart-title" className="max-h-[96vh] w-full max-w-6xl overflow-y-auto rounded-3xl border border-purple-400/20 bg-[#110d1b] p-4 shadow-2xl sm:p-6">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h2 id="terminal-chart-title" className="text-lg font-bold text-white">{symbol} · {timeframe} interactive terminal</h2>
                <p className="mt-1 text-xs text-slate-400">Hover or move the crosshair to inspect candle OHLCV.</p>
              </div>
              <button type="button" onClick={() => setChartOpen(false)} aria-label="Close chart" className="rounded-xl p-2 text-slate-300 hover:bg-white/10"><X className="h-5 w-5" /></button>
            </div>
            <Suspense fallback={<div role="status" className="flex h-[420px] items-center justify-center text-xs text-purple-200">Loading interactive chart…</div>}>
              <TerminalChart symbol={symbol} candles={candles} liveCandle={liveCandle} />
            </Suspense>
          </section>
        </div>
      )}
    </>
  );
}
