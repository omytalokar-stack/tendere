import { useEffect, useState } from 'react';
import { History, Wallet } from 'lucide-react';
import type { TerminalQuote } from './MarketTerminal';
import {
  localAvailableMargin,
  type LocalPaperAccount,
  type LocalPaperTrade,
} from '../utils/browserDatabase';

interface LocalPaperWalletProps {
  account: LocalPaperAccount;
  prices: Record<string, { value: number; at: number }>;
  quote: TerminalQuote | null;
  quoteUpdatedAt: number | null;
  error: string;
  onBook: (symbol: string, side: 'LONG' | 'SHORT', price: number, atr: number) => Promise<void>;
  onClose: (tradeId: string, price: number) => Promise<void>;
  onAdjustEquity: (balance: number) => Promise<void>;
}

function usd(value: number): string {
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
}

function tradePrice(value: number): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: 8 });
}

export function LocalPaperWallet({
  account,
  prices,
  quote,
  quoteUpdatedAt,
  error,
  onBook,
  onClose,
  onAdjustEquity,
}: LocalPaperWalletProps) {
  const [view, setView] = useState<'OPEN' | 'HISTORY'>('OPEN');
  const [bookingOpen, setBookingOpen] = useState(false);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [side, setSide] = useState<'LONG' | 'SHORT'>('LONG');
  const [equityInput, setEquityInput] = useState(String(account.balance));
  const [pending, setPending] = useState('');
  const [localError, setLocalError] = useState('');
  const openTrades = account.trades.filter((trade) => trade.status === 'OPEN');
  const closedTrades = account.trades.filter((trade) => trade.status === 'CLOSED');
  const quoteIsFresh = Boolean(quote && quote.isLive && quoteUpdatedAt !== null && Date.now() - quoteUpdatedAt < 20_000);

  useEffect(() => {
    setEquityInput(String(account.balance));
  }, [account.balance]);

  async function submitBooking() {
    if (!quote || !quoteIsFresh) {
      setLocalError('Manual booking requires a fresh live Binance price for the selected terminal pair.');
      return;
    }
    setPending('book');
    setLocalError('');
    try {
      await onBook(quote.symbol, side, quote.price, quote.atr);
      setBookingOpen(false);
      setView('OPEN');
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : 'Unable to book a local paper trade.');
    } finally {
      setPending('');
    }
  }

  async function submitEquity() {
    setPending('equity');
    setLocalError('');
    try {
      await onAdjustEquity(Number(equityInput));
      setAdjustOpen(false);
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : 'Unable to adjust local equity.');
    } finally {
      setPending('');
    }
  }

  async function closeTrade(trade: LocalPaperTrade) {
    const latest = prices[trade.symbol];
    if (!latest || Date.now() - latest.at > 20_000) {
      setLocalError(`A fresh ${trade.symbol} Binance tick is required before closing this position.`);
      return;
    }
    setPending(trade.id);
    setLocalError('');
    try {
      await onClose(trade.id, latest.value);
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : 'Unable to close the local paper position.');
    } finally {
      setPending('');
    }
  }

  return (
    <div className="space-y-5">
      <section className="rounded-3xl border border-amber-300/20 bg-amber-500/[0.04] p-4">
        <div className="flex items-start gap-3">
          <Wallet className="mt-0.5 h-5 w-5 shrink-0 text-amber-200" />
          <div>
            <h2 className="text-sm font-bold text-amber-100">Local IndexedDB paper account</h2>
            <p className="mt-1 text-[10px] leading-relaxed text-amber-100/70">
              Cloud backend is unavailable. This account is stored in this browser only; manual trades use public live Binance ticks and are simulated, never sent to an exchange.
            </p>
          </div>
        </div>
      </section>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-2xl border border-purple-400/12 bg-white/[0.025] p-4"><p className="text-[10px] text-slate-500">Account balance</p><p className="mt-2 font-mono text-lg text-white">{usd(account.balance)}</p></div>
        <div className="rounded-2xl border border-purple-400/12 bg-white/[0.025] p-4"><p className="text-[10px] text-slate-500">Available margin</p><p className="mt-2 font-mono text-lg text-white">{usd(localAvailableMargin(account))}</p></div>
        <div className="rounded-2xl border border-purple-400/12 bg-white/[0.025] p-4"><p className="text-[10px] text-slate-500">Realized P&amp;L</p><p className={`mt-2 font-mono text-lg ${account.totalRealizedPnl >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>{usd(account.totalRealizedPnl)}</p></div>
      </div>

      <section className="rounded-3xl border border-purple-400/15 bg-white/[0.025] p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex gap-2">
            <button type="button" onClick={() => setView('OPEN')} aria-pressed={view === 'OPEN'} className={`rounded-lg px-3 py-2 text-[10px] ${view === 'OPEN' ? 'bg-purple-400/20 text-purple-100' : 'text-slate-400'}`}>Open positions ({openTrades.length})</button>
            <button type="button" onClick={() => setView('HISTORY')} aria-pressed={view === 'HISTORY'} className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-[10px] ${view === 'HISTORY' ? 'bg-purple-400/20 text-purple-100' : 'text-slate-400'}`}><History className="h-3.5 w-3.5" />Order history ({closedTrades.length})</button>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => setAdjustOpen(true)} className="rounded-lg border border-purple-400/15 px-3 py-2 text-[10px] text-slate-300">Adjust equity</button>
            <button type="button" onClick={() => setBookingOpen(true)} disabled={!quoteIsFresh || !quote} className="rounded-lg border border-pink-300/25 bg-pink-500/10 px-3 py-2 text-[10px] font-semibold text-pink-100 disabled:opacity-40">Manual book</button>
          </div>
        </div>

        {(error || localError) && <p role="alert" className="mt-3 rounded-xl border border-rose-400/20 bg-rose-950/20 p-3 text-xs text-rose-200">{localError || error}</p>}

        {view === 'OPEN' && (
          <div className="mt-4 grid gap-3 lg:grid-cols-2">
            {openTrades.map((trade) => {
              const mark = prices[trade.symbol];
              const fresh = mark && Date.now() - mark.at < 20_000;
              const direction = trade.side === 'LONG' ? 1 : -1;
              const livePnl = fresh ? trade.realizedPnl + direction * (mark.value - trade.entryPrice) * trade.remainingQuantity : null;
              return (
                <article key={trade.id} className="rounded-2xl border border-purple-400/15 bg-black/15 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div><h3 className="font-mono text-sm font-bold text-white">{trade.symbol}</h3><p className="mt-1 text-[10px] text-slate-500">Entry {tradePrice(trade.entryPrice)} · {new Date(trade.openedAt).toLocaleString()}</p></div>
                    <span className={`rounded-full px-2 py-1 text-[9px] font-mono ${trade.side === 'LONG' ? 'bg-emerald-500/10 text-emerald-200' : 'bg-rose-500/10 text-rose-200'}`}>{trade.side}</span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    <span className="rounded-full border border-slate-400/15 bg-slate-800/60 px-2 py-1 text-[9px] font-mono text-slate-400">1H —</span>
                    <span className="rounded-full border border-slate-400/15 bg-slate-800/60 px-2 py-1 text-[9px] font-mono text-slate-400">4H —</span>
                    <span className="rounded-full border border-purple-300/15 bg-purple-500/10 px-2 py-1 text-[9px] font-mono text-purple-100">MANUAL · STANDARD 25%</span>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] font-mono">
                    <span className="text-slate-500">Live price <b className="text-white">{fresh ? tradePrice(mark.value) : 'waiting for fresh tick'}</b></span>
                    <span className="text-right text-slate-500">Open P&amp;L <b className={livePnl === null ? 'text-slate-400' : livePnl >= 0 ? 'text-emerald-200' : 'text-rose-200'}>{livePnl === null ? '—' : usd(livePnl)}</b></span>
                    <span className="text-rose-200">Stop {tradePrice(trade.stopLoss)}</span>
                    <span className="text-right text-emerald-200">TP1 {tradePrice(trade.tp1Price)}</span>
                    <span className="text-emerald-200">TP2 {tradePrice(trade.tp2Price)}</span>
                    <span className="text-right text-slate-400">Qty {tradePrice(trade.remainingQuantity)}</span>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <span className={`rounded-full px-2 py-1 text-[9px] ${trade.tp1Filled ? 'bg-emerald-500/15 text-emerald-200' : 'bg-slate-800 text-slate-400'}`}>{trade.tp1Filled ? 'TP1 partial fill · 50%' : 'TP1 pending'}</span>
                    <span className={`rounded-full px-2 py-1 text-[9px] ${trade.tp1Filled ? 'bg-amber-500/10 text-amber-200' : 'bg-slate-800 text-slate-500'}`}>{trade.tp1Filled ? 'Breakeven +0.35% stop' : 'Initial 1.5 ATR stop'}</span>
                    <button type="button" disabled={pending !== '' || !fresh} onClick={() => void closeTrade(trade)} className="ml-auto rounded-lg border border-rose-300/20 px-2.5 py-1 text-[9px] text-rose-200 disabled:opacity-40">{pending === trade.id ? 'Closing…' : 'Manual close'}</button>
                  </div>
                </article>
              );
            })}
            {openTrades.length === 0 && <p className="col-span-full py-8 text-center text-xs text-slate-500">No open local positions. Select a symbol in the terminal, then book a simulated manual trade.</p>}
          </div>
        )}

        {view === 'HISTORY' && (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[780px] text-left font-mono text-[10px]">
              <thead className="text-slate-500"><tr>{['Pair / side', 'Entry', 'Exit', 'TP1', 'P&L', 'Reason', 'Closed'].map((label) => <th key={label} className="pb-3 pr-3">{label}</th>)}</tr></thead>
              <tbody>
                {closedTrades.map((trade) => (
                  <tr key={trade.id} className="border-t border-purple-400/10">
                    <td className="py-3 pr-3 text-slate-200">{trade.symbol} <span className={trade.side === 'LONG' ? 'text-emerald-300' : 'text-rose-300'}>{trade.side}</span></td>
                    <td className="py-3 pr-3">{tradePrice(trade.entryPrice)}</td><td className="py-3 pr-3">{trade.exitPrice === null ? '—' : tradePrice(trade.exitPrice)}</td>
                    <td className="py-3 pr-3">{trade.tp1Filled ? '50% filled' : 'Not reached'}</td>
                    <td className={`py-3 pr-3 ${trade.realizedPnl >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>{usd(trade.realizedPnl)}</td>
                    <td className="py-3 pr-3 text-slate-400">{trade.closeReason?.replace('_', ' ') ?? '—'}</td>
                    <td className="py-3 text-slate-500">{trade.closedAt ? new Date(trade.closedAt).toLocaleString() : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {closedTrades.length === 0 && <p className="py-8 text-center text-xs text-slate-500">No local order history yet.</p>}
          </div>
        )}
      </section>

      {bookingOpen && quote && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4">
          <section role="dialog" aria-modal="true" aria-labelledby="local-book-title" className="w-full max-w-md rounded-3xl border border-purple-400/20 bg-[#110d1b] p-5 shadow-2xl">
            <h2 id="local-book-title" className="text-lg font-bold text-white">Manual local paper trade</h2>
            <p className="mt-1 text-xs text-slate-400">{quote.symbol} · live price {tradePrice(quote.price)} · ATR(14) {quote.atr.toPrecision(5)}</p>
            <div className="mt-4 grid grid-cols-2 gap-2">
              {(['LONG', 'SHORT'] as const).map((item) => (
                <button key={item} type="button" onClick={() => setSide(item)} aria-pressed={side === item} className={`rounded-xl border p-3 text-xs font-semibold ${side === item ? item === 'LONG' ? 'border-emerald-300/30 bg-emerald-500/10 text-emerald-100' : 'border-rose-300/30 bg-rose-500/10 text-rose-100' : 'border-purple-400/10 text-slate-400'}`}>{item}</button>
              ))}
            </div>
            <div className="mt-4 space-y-2 rounded-xl border border-purple-400/10 bg-black/20 p-3 text-[10px] text-slate-400">
              <p>Size: 25% of available margin, capped at $2,500.</p><p>Stop-loss: 1.5 ATR · TP1: 1.5 ATR · TP2: 3 ATR.</p>
              <p>TP1 closes half; remaining stop moves to breakeven +0.35%.</p>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setBookingOpen(false)} className="rounded-xl border border-purple-400/15 px-4 py-2 text-xs text-slate-300">Cancel</button>
              <button type="button" disabled={pending !== '' || !quoteIsFresh} onClick={() => void submitBooking()} className="rounded-xl border border-pink-300/25 bg-pink-500/10 px-4 py-2 text-xs font-semibold text-pink-100 disabled:opacity-40">{pending === 'book' ? 'Booking…' : 'Book simulated trade'}</button>
            </div>
          </section>
        </div>
      )}

      {adjustOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4">
          <section role="dialog" aria-modal="true" aria-labelledby="equity-title" className="w-full max-w-sm rounded-3xl border border-purple-400/20 bg-[#110d1b] p-5 shadow-2xl">
            <h2 id="equity-title" className="text-lg font-bold text-white">Adjust local equity</h2>
            <p className="mt-1 text-xs text-slate-400">Open positions and order history remain unchanged.</p>
            <label className="mt-4 block text-[10px] text-slate-400">New account balance (USDT)
              <input type="number" min="0.01" step="0.01" value={equityInput} onChange={(event) => setEquityInput(event.target.value)} className="mt-2 w-full rounded-xl border border-purple-400/15 bg-black/20 px-3 py-2 font-mono text-sm text-white outline-none" />
            </label>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setAdjustOpen(false)} className="rounded-xl border border-purple-400/15 px-4 py-2 text-xs text-slate-300">Cancel</button>
              <button type="button" disabled={pending !== ''} onClick={() => void submitEquity()} className="rounded-xl border border-purple-300/25 bg-purple-500/10 px-4 py-2 text-xs text-purple-100 disabled:opacity-40">{pending === 'equity' ? 'Saving…' : 'Save equity'}</button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
