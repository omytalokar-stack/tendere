import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Download, RefreshCw, Search, X } from 'lucide-react';
import { celebrate } from '../services/notificationService';
import { buildCandleAuditRows, type CandleAuditRow } from '../utils/indicators';
import {
  CORE_USDT_PAIRS,
  scanCorePairs,
  type ScreenerOpportunity,
} from '../utils/screener';
import type { TerminalTimeframe } from '../services/binanceMarketData';

type ScreenerFilter = 'ALL' | 'OPPORTUNITIES' | 'LONGS' | 'SHORTS';
const FILTERS: ScreenerFilter[] = ['ALL', 'OPPORTUNITIES', 'LONGS', 'SHORTS'];
const PAGE_SIZE = 25;

function display(value: number | null, digits = 4): string {
  return value === null || !Number.isFinite(value)
    ? '—'
    : value.toLocaleString('en-US', { maximumFractionDigits: digits });
}

function downloadCsv(symbol: string, rows: CandleAuditRow[]): void {
  const columns: Array<keyof CandleAuditRow> = [
    'openTime', 'open', 'high', 'low', 'close', 'volume', 'ema20', 'ema50', 'ema200',
    'supertrend', 'rsi14', 'macdHistogram', 'stochasticK', 'stochasticD',
    'bollingerPercentB', 'adx14', 'pdi14', 'mdi14', 'obv', 'obvSma20', 'atr14',
  ];
  const csv = [
    columns.join(','),
    ...rows.map((row) => columns.map((column) => {
      const value = row[column];
      return value ?? '';
    }).join(',')),
  ].join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${symbol.toLowerCase()}-500-candle-audit.csv`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function OpportunityScreener() {
  const [expanded, setExpanded] = useState(false);
  const [timeframe, setTimeframe] = useState<TerminalTimeframe>('15m');
  const [filter, setFilter] = useState<ScreenerFilter>('ALL');
  const [opportunities, setOpportunities] = useState<ScreenerOpportunity[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [audit, setAudit] = useState<ScreenerOpportunity | null>(null);
  const priorTopTwo = useRef(new Set<string>());
  const inFlight = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);

  const runScan = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    setError('');
    try {
      const result = await scanCorePairs(timeframe, controller.signal);
      if (controller.signal.aborted) return;
      const topTwo = new Set(result.filter((row) => row.isTopOpportunity).map((row) => row.symbol));
      if ([...topTwo].some((symbol) => !priorTopTwo.current.has(symbol))) {
        celebrate('opportunity');
      }
      priorTopTwo.current = topTwo;
      setOpportunities(result);
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : 'Unable to scan the core USDT pairs.');
      }
    } finally {
      if (controllerRef.current === controller) {
        setLoading(false);
        inFlight.current = false;
      }
    }
  }, [timeframe]);

  useEffect(() => {
    if (!expanded) return;
    void runScan();
    const timer = window.setInterval(() => void runScan(), 90_000);
    return () => {
      window.clearInterval(timer);
      controllerRef.current?.abort();
      inFlight.current = false;
    };
  }, [expanded, runScan]);

  const filtered = opportunities.filter((row) => {
    if (filter === 'OPPORTUNITIES') return row.analysis.side !== null;
    if (filter === 'LONGS') return row.analysis.side === 'LONG';
    if (filter === 'SHORTS') return row.analysis.side === 'SHORT';
    return true;
  });

  return (
    <section className="mb-5 overflow-hidden rounded-3xl border border-purple-400/15 bg-white/[0.025] shadow-xl backdrop-blur-xl">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center justify-between gap-3 p-4 text-left sm:p-5"
      >
        <div>
          <p className="text-[10px] font-mono uppercase tracking-[.2em] text-pink-300/70">Closed-candle consensus</p>
          <h2 className="mt-1 text-base font-bold text-white">Multi-Coin Opportunity Screener</h2>
          <p className="mt-1 text-[10px] text-slate-500">Ten core USDT pairs · 10 equal-weight indicators · top two ranked by volume spike × ADX</p>
        </div>
        {expanded ? <ChevronUp className="h-5 w-5 shrink-0 text-purple-200" /> : <ChevronDown className="h-5 w-5 shrink-0 text-purple-200" />}
      </button>
      {expanded && (
        <div className="space-y-4 border-t border-purple-400/10 p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-2">
              {FILTERS.map((item) => (
                <button
                  type="button"
                  key={item}
                  onClick={() => setFilter(item)}
                  aria-pressed={filter === item}
                  className={`rounded-lg px-2.5 py-1.5 text-[10px] font-mono ${
                    filter === item ? 'bg-purple-400/20 text-purple-100' : 'bg-black/20 text-slate-400'
                  }`}
                >
                  {item}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <select
                aria-label="Screener timeframe"
                value={timeframe}
                onChange={(event) => setTimeframe(event.target.value as TerminalTimeframe)}
                className="rounded-lg border border-purple-400/15 bg-[#151020] px-2.5 py-1.5 text-[10px] text-slate-200"
              >
                {['5m', '15m', '1h', '4h', '1d'].map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
              <button
                type="button"
                onClick={() => void runScan()}
                disabled={loading}
                aria-label="Refresh opportunity scan"
                className="inline-flex items-center gap-1.5 rounded-lg border border-purple-400/15 px-2.5 py-1.5 text-[10px] text-purple-100 disabled:opacity-50"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
                {loading ? 'Scanning' : 'Scan now'}
              </button>
            </div>
          </div>
          {error && <p role="alert" className="rounded-xl border border-rose-400/20 bg-rose-950/20 p-3 text-xs text-rose-200">{error}</p>}
          {loading && opportunities.length === 0 && <p role="status" className="py-5 text-center text-xs text-purple-200">Validating 500 closed candles per core pair…</p>}
          {!loading && !error && opportunities.length === 0 && <p className="py-5 text-center text-xs text-slate-500">No scan results yet.</p>}
          {opportunities.length > 0 && (
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {filtered.map((row) => (
                <article key={row.symbol} className={`rounded-2xl border p-3 ${
                  row.isTopOpportunity ? 'border-amber-300/40 bg-amber-500/[0.06]' : 'border-purple-400/10 bg-black/15'
                }`}>
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="font-mono text-xs font-bold text-white">{row.symbol}</h3>
                    <div className="flex items-center gap-1">
                      {row.isTopOpportunity && <span className="rounded-full bg-amber-400/15 px-2 py-1 text-[9px] font-bold text-amber-200">TOP {row.opportunityRank}</span>}
                      <span className={`rounded-full px-2 py-1 text-[9px] font-mono ${
                        row.analysis.side ? 'bg-emerald-500/10 text-emerald-200' : 'bg-slate-800 text-slate-400'
                      }`}>{row.analysis.side ?? 'NO ENTRY'}</span>
                    </div>
                  </div>
                  <div className="mt-2 grid grid-cols-3 gap-2 text-[9px] font-mono">
                    <span className="text-slate-400">Votes <b className="text-emerald-200">{row.analysis.bullishCount}</b>/<b className="text-rose-200">{row.analysis.bearishCount}</b></span>
                    <span className="text-slate-400">ADX <b className="text-slate-200">{row.analysis.adx.toFixed(1)}</b></span>
                    <span className="text-right text-slate-400">Vol <b className="text-slate-200">{row.analysis.volumeSpikeRatio.toFixed(2)}x</b></span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    <span className={`rounded-full border px-2 py-1 text-[9px] font-mono ${
                      row.analysis.htf1hTrend === 'BULLISH'
                        ? 'border-emerald-400/20 bg-emerald-500/10 text-emerald-200'
                        : row.analysis.htf1hTrend === 'BEARISH'
                          ? 'border-rose-400/20 bg-rose-500/10 text-rose-200'
                          : 'border-slate-400/15 bg-slate-800/60 text-slate-400'
                    }`}>1H {row.analysis.htf1hTrend}</span>
                    <span className={`rounded-full border px-2 py-1 text-[9px] font-mono ${
                      row.analysis.htf4hTrend === 'BULLISH'
                        ? 'border-emerald-400/20 bg-emerald-500/10 text-emerald-200'
                        : row.analysis.htf4hTrend === 'BEARISH'
                          ? 'border-rose-400/20 bg-rose-500/10 text-rose-200'
                          : 'border-slate-400/15 bg-slate-800/60 text-slate-400'
                    }`}>4H {row.analysis.htf4hTrend}</span>
                    {row.analysis.htfAlignment === 'ALIGNED_1H_4H' && row.analysis.side && (
                      <span className="rounded-full border border-amber-300/30 bg-amber-400/15 px-2 py-1 text-[9px] font-bold text-amber-100">A+ 35%</span>
                    )}
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <span className="text-[9px] text-slate-500">Score {row.opportunityScore.toFixed(2)}</span>
                    <button type="button" onClick={() => setAudit(row)} className="text-[9px] font-semibold text-purple-200 hover:text-white">500-candle audit</button>
                  </div>
                </article>
              ))}
            </div>
          )}
          <p className="text-[9px] text-slate-500">Auto-entry remains limited to the ten core pairs. PEPE and custom pairs are chart/watchlist and manual-local only.</p>
        </div>
      )}
      {audit && <CandleAuditModal opportunity={audit} onClose={() => setAudit(null)} />}
    </section>
  );
}

function CandleAuditModal({ opportunity, onClose }: { opportunity: ScreenerOpportunity; onClose: () => void }) {
  const rows = useMemo(() => buildCandleAuditRows(opportunity.candles), [opportunity.candles]);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const filtered = rows.filter((row) => {
    if (!query.trim()) return true;
    const search = query.trim().toLowerCase();
    return Object.values(row).join(' ').toLowerCase().includes(search);
  });
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const visible = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const highest = Math.max(...rows.map((row) => row.high));
  const lowest = Math.min(...rows.map((row) => row.low));
  const totalVolume = rows.reduce((sum, row) => sum + row.volume, 0);
  const bullishCandles = rows.filter((row) => row.close > row.open).length;

  useEffect(() => setPage(0), [query]);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-2 sm:p-5">
      <section role="dialog" aria-modal="true" aria-labelledby="audit-title" className="max-h-[95vh] w-full max-w-7xl overflow-hidden rounded-3xl border border-purple-400/20 bg-[#110d1b] p-4 shadow-2xl sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 id="audit-title" className="text-lg font-bold text-white">{opportunity.symbol} · 500-candle audit</h2>
            <p className="mt-1 text-[10px] text-slate-400">Completed {opportunity.candles.length} {opportunity.candles[0] ? new Date(opportunity.candles[0].openTime).toLocaleString() : ''} onward</p>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => downloadCsv(opportunity.symbol, rows)} className="inline-flex items-center gap-1.5 rounded-lg border border-purple-300/20 px-3 py-2 text-[10px] text-purple-100"><Download className="h-3.5 w-3.5" />Download CSV</button>
            <button type="button" onClick={onClose} aria-label="Close candle audit" className="rounded-lg p-2 text-slate-300 hover:bg-white/10"><X className="h-4 w-4" /></button>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2 text-[10px] sm:grid-cols-4">
          <div className="rounded-xl border border-purple-400/10 bg-black/20 p-3"><span className="text-slate-500">High / Low</span><p className="mt-1 font-mono text-slate-200">{display(highest)} / {display(lowest)}</p></div>
          <div className="rounded-xl border border-purple-400/10 bg-black/20 p-3"><span className="text-slate-500">Total base volume</span><p className="mt-1 font-mono text-slate-200">{display(totalVolume, 2)}</p></div>
          <div className="rounded-xl border border-purple-400/10 bg-black/20 p-3"><span className="text-slate-500">Bullish candles</span><p className="mt-1 font-mono text-slate-200">{bullishCandles} / {rows.length}</p></div>
          <div className="rounded-xl border border-purple-400/10 bg-black/20 p-3"><span className="text-slate-500">Consensus / score</span><p className="mt-1 font-mono text-slate-200">{opportunity.analysis.side ?? 'NO ENTRY'} · {opportunity.opportunityScore.toFixed(2)}</p></div>
        </div>
        <label className="mt-4 flex max-w-sm items-center gap-2 rounded-xl border border-purple-400/15 bg-black/20 px-3 py-2">
          <Search className="h-4 w-4 text-slate-500" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search candle time or values" className="w-full bg-transparent text-xs text-slate-200 outline-none placeholder:text-slate-600" />
        </label>
        <div className="mt-3 max-h-[52vh] overflow-auto rounded-xl border border-purple-400/10">
          <table className="w-full min-w-[1500px] text-left font-mono text-[9px]">
            <thead className="sticky top-0 bg-[#1a1424] text-slate-400">
              <tr>{['Time', 'Open', 'High', 'Low', 'Close', 'Volume', 'EMA20', 'EMA50', 'EMA200', 'Supertrend', 'RSI', 'MACD Hist', 'Stoch K/D', '%B', 'ADX +DI/-DI', 'OBV / SMA20', 'ATR'].map((label) => <th key={label} className="px-2 py-2">{label}</th>)}</tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr key={row.openTime} className="border-t border-purple-400/10 text-slate-300">
                  <td className="whitespace-nowrap px-2 py-2">{new Date(row.openTime).toLocaleString()}</td>
                  <td className="px-2 py-2">{display(row.open)}</td><td className="px-2 py-2">{display(row.high)}</td>
                  <td className="px-2 py-2">{display(row.low)}</td><td className="px-2 py-2">{display(row.close)}</td>
                  <td className="px-2 py-2">{display(row.volume, 2)}</td><td className="px-2 py-2">{display(row.ema20)}</td>
                  <td className="px-2 py-2">{display(row.ema50)}</td><td className="px-2 py-2">{display(row.ema200)}</td>
                  <td className="px-2 py-2">{display(row.supertrend)}</td><td className="px-2 py-2">{display(row.rsi14, 2)}</td>
                  <td className="px-2 py-2">{display(row.macdHistogram)}</td>
                  <td className="px-2 py-2">{display(row.stochasticK, 2)} / {display(row.stochasticD, 2)}</td>
                  <td className="px-2 py-2">{display(row.bollingerPercentB, 3)}</td>
                  <td className="px-2 py-2">{display(row.adx14, 2)} {display(row.pdi14, 2)}/{display(row.mdi14, 2)}</td>
                  <td className="px-2 py-2">{display(row.obv, 2)} / {display(row.obvSma20, 2)}</td>
                  <td className="px-2 py-2">{display(row.atr14)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {visible.length === 0 && <p className="p-5 text-center text-xs text-slate-500">No candle rows match the search.</p>}
        </div>
        <div className="mt-3 flex items-center justify-between text-[10px] text-slate-400">
          <span>{filtered.length} rows · page {page + 1} of {pageCount}</span>
          <div className="flex gap-2">
            <button type="button" disabled={page === 0} onClick={() => setPage((value) => Math.max(0, value - 1))} className="rounded-lg border border-purple-400/15 px-3 py-1.5 disabled:opacity-40">Previous</button>
            <button type="button" disabled={page + 1 >= pageCount} onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))} className="rounded-lg border border-purple-400/15 px-3 py-1.5 disabled:opacity-40">Next</button>
          </div>
        </div>
      </section>
    </div>
  );
}
