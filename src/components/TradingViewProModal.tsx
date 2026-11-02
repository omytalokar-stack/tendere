import React from 'react';
import { X } from 'lucide-react';
import type { BackendCandle, BackendMarket } from '../services/backendApi';

interface CoinConfig {
  id: string;
  symbol: string;
  name: string;
  decimals: number;
  color: string;
}

interface TradingViewProModalProps {
  isOpen: boolean;
  onClose: () => void;
  coin: CoinConfig;
  candles: BackendCandle[];
  market: BackendMarket | null;
  loading: boolean;
  error: string;
}

export function TradingViewProModal({
  isOpen,
  onClose,
  coin,
  candles,
  market,
  loading,
  error,
}: TradingViewProModalProps) {
  if (!isOpen) return null;

  const chartCandles = candles.slice(-80);
  const hasData = chartCandles.length > 0;
  const minPrice = hasData ? Math.min(...chartCandles.map((candle) => candle.low)) : 0;
  const maxPrice = hasData ? Math.max(...chartCandles.map((candle) => candle.high)) : 0;
  const priceRange = maxPrice - minPrice;
  const maxVolume = hasData ? Math.max(...chartCandles.map((candle) => candle.volume)) : 0;
  const plot = { left: 12, right: 788, top: 16, bottom: 270 };
  const xFor = (index: number) => plot.left + ((index + 0.5) / Math.max(chartCandles.length, 1)) * (plot.right - plot.left);
  const yFor = (price: number) => priceRange > 0
    ? plot.bottom - ((price - minPrice) / priceRange) * (plot.bottom - plot.top)
    : (plot.top + plot.bottom) / 2;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-3 sm:p-6">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="market-chart-title"
        className="max-h-[92vh] w-full max-w-5xl overflow-y-auto rounded-3xl border border-purple-400/20 bg-[#110d1b] p-5 shadow-2xl sm:p-7"
      >
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h2 id="market-chart-title" className="text-xl font-bold text-white">{coin.symbol} · Binance Spot</h2>
            <p className="mt-1 text-xs text-slate-400">
              Candles are finalized Binance klines. Chart displays the latest {chartCandles.length} of 500.
            </p>
          </div>
          <button onClick={onClose} aria-label="Close market chart" className="rounded-xl p-2 text-slate-300 hover:bg-white/10">
            <X className="h-5 w-5" />
          </button>
        </div>

        {loading && <div role="status" className="rounded-xl border border-purple-500/20 p-5 text-sm text-purple-200">Loading finalized Binance candles…</div>}
        {!loading && error && (
          <div role="alert" className="rounded-xl border border-rose-500/40 bg-rose-950/30 p-5 text-sm text-rose-200">
            {error}
          </div>
        )}
        {!loading && !error && !hasData && (
          <div role="alert" className="rounded-xl border border-rose-500/40 bg-rose-950/30 p-5 text-sm text-rose-200">
            INSUFFICIENT_HISTORICAL_DATA
          </div>
        )}

        {hasData && !error && (
          <>
            <div className="overflow-x-auto rounded-2xl border border-purple-500/15 bg-black/30 p-3">
              <svg viewBox="0 0 800 360" role="img" aria-label={`${coin.symbol} finalized Binance candles`} className="min-w-[700px] w-full">
                {[0, 1, 2, 3, 4].map((line) => {
                  const y = plot.top + (line / 4) * (plot.bottom - plot.top);
                  return <line key={line} x1={plot.left} x2={plot.right} y1={y} y2={y} stroke="#6b557c" strokeOpacity="0.28" />;
                })}
                {chartCandles.map((candle, index) => {
                  const center = xFor(index);
                  const width = Math.max(2, ((plot.right - plot.left) / chartCandles.length) * 0.62);
                  const bullish = candle.close >= candle.open;
                  const color = bullish ? '#34d399' : '#fb7185';
                  const bodyTop = yFor(Math.max(candle.open, candle.close));
                  const bodyBottom = yFor(Math.min(candle.open, candle.close));
                  const bodyHeight = Math.max(1, bodyBottom - bodyTop);
                  const volumeHeight = maxVolume > 0 ? (candle.volume / maxVolume) * 58 : 0;
                  return (
                    <g key={candle.openTime}>
                      <line x1={center} x2={center} y1={yFor(candle.high)} y2={yFor(candle.low)} stroke={color} strokeWidth="1" />
                      <rect x={center - width / 2} y={bodyTop} width={width} height={bodyHeight} fill={color} />
                      <rect
                        x={center - width / 2}
                        y={332 - volumeHeight}
                        width={width}
                        height={volumeHeight}
                        fill={color}
                        fillOpacity="0.45"
                      />
                    </g>
                  );
                })}
                <line x1={plot.left} x2={plot.right} y1="290" y2="290" stroke="#6b557c" strokeOpacity="0.5" />
                <text x={plot.left} y="350" fill="#94a3b8" fontSize="11">Volume (base asset)</text>
                <text x={plot.right} y="12" textAnchor="end" fill="#c4b5fd" fontSize="11">
                  High {maxPrice.toFixed(coin.decimals)} · Low {minPrice.toFixed(coin.decimals)}
                </text>
              </svg>
            </div>

            {market && (
              <div className="mt-5 grid gap-4 md:grid-cols-2">
                <div className="rounded-2xl border border-purple-500/15 p-4">
                  <h3 className="mb-3 text-sm font-semibold text-white">Binance L2 · Top 20 levels</h3>
                  <div className="grid grid-cols-2 gap-3 text-xs font-mono">
                    <div className="text-emerald-300">
                      Best bid: {market.orderBook.bestBid.toFixed(coin.decimals)}
                      <div className="mt-1 text-slate-400">Base qty: {market.orderBook.bidQuantity}</div>
                      <div className="text-slate-400">Quote value: {market.orderBook.bidNotional.toFixed(2)} USDT</div>
                    </div>
                    <div className="text-rose-300">
                      Best ask: {market.orderBook.bestAsk.toFixed(coin.decimals)}
                      <div className="mt-1 text-slate-400">Base qty: {market.orderBook.askQuantity}</div>
                      <div className="text-slate-400">Quote value: {market.orderBook.askNotional.toFixed(2)} USDT</div>
                    </div>
                  </div>
                  <p className="mt-3 text-[10px] text-slate-500">
                    Binance depth stream update received {new Date(market.orderBook.updatedAt).toLocaleTimeString()}.
                  </p>
                </div>
                <div className="rounded-2xl border border-purple-500/15 p-4">
                  <h3 className="mb-3 text-sm font-semibold text-white">Closed-candle indicators</h3>
                  <dl className="grid grid-cols-2 gap-2 text-xs">
                    <dt className="text-slate-400">RSI (14)</dt><dd className="text-right text-slate-200">{market.indicators.rsi.toFixed(2)}</dd>
                    <dt className="text-slate-400">ATR (14)</dt><dd className="text-right text-slate-200">{market.indicators.atr.toFixed(coin.decimals)}</dd>
                    <dt className="text-slate-400">ADX (14)</dt><dd className="text-right text-slate-200">{market.indicators.adx.toFixed(2)}</dd>
                    <dt className="text-slate-400">VWAP (500)</dt><dd className="text-right text-slate-200">{market.indicators.vwap.toFixed(coin.decimals)}</dd>
                    <dt className="text-slate-400">Volume / prior 20 avg</dt>
                    <dd className="text-right text-slate-200">{market.indicators.volumeRatio.toFixed(2)}x</dd>
                    <dt className="text-slate-400">Consensus</dt>
                    <dd className="text-right text-slate-200">{market.indicators.buyVotes}/{market.indicators.totalVotes} buy · {market.indicators.sellVotes} sell</dd>
                  </dl>
                </div>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
