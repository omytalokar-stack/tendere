const rawUrl = import.meta.env.VITE_API_BASE_URL || '/api';
const normalizedUrl = rawUrl.replace(/\/+$/, '');
const API_BASE_URL = normalizedUrl.endsWith('/api')
  ? normalizedUrl
  : `${normalizedUrl}/api`;

export interface BackendStatus {
  running: boolean;
  enabled: boolean;
  feedConnected: boolean;
  marketDataReady: boolean;
  interval: string;
  entryIntervals?: string[];
  symbols: string[];
  prices: Record<string, number>;
  riskPercent: number;
  takerFeeRate: number;
  rewardRiskRatio: number;
  leverage: number;
  dailyLossLimit: number;
}

export interface BackendMarket {
  symbol: string;
  price: number;
  priceSource: 'TRADE' | 'ORDER_BOOK_MID';
  lastTradeAt: string;
  marketAgeMs: number;
  candleCount: number;
  orderBook: {
    bids: Array<{ price: number; quantity: number }>;
    asks: Array<{ price: number; quantity: number }>;
    bestBid: number;
    bestAsk: number;
    bidQuantity: number;
    askQuantity: number;
    bidNotional: number;
    askNotional: number;
    levelCount: number;
    updatedAt: string;
  };
  indicators: {
    side: 'LONG' | 'SHORT' | null;
    buyVotes: number;
    sellVotes: number;
    totalVotes: number;
    atr: number;
    rsi: number;
    adx: number;
    vwap: number;
    supertrend: { value: number; direction: 'BUY' | 'SELL' };
    currentVolume: number;
    averageVolume: number;
    volumeRatio: number;
    orderBookPressure: { bidQuantity: number; askQuantity: number; bidPercent: number; askPercent: number };
    indicators: Array<{ name: string; value: unknown; vote: 'BUY' | 'SELL' | 'NEUTRAL' }>;
  };
}

export interface BackendCandle {
  time: string;
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  isFinal: true;
}

export interface BackendWallet {
  balance: number;
  availableMargin: number;
  inTradeMargin: number;
  totalRealizedPnl: number;
  winCount: number;
  lossCount: number;
}

interface MarketsResponse {
  markets: BackendMarket[];
}

interface CandlesResponse {
  candles: BackendCandle[];
}

export interface BackendTrade {
  _id: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  status: 'OPEN' | 'CLOSED';
  entryPrice: number;
  exitPrice: number | null;
  entryFeeUsd?: number;
  exitFeeUsd?: number;
  totalFeesUsd?: number;
  grossPnlUsd?: number;
  quantity: number;
  margin: number;
  leverage: number;
  stopLoss: number;
  takeProfit: number;
  pnlUsd: number;
  pnlPercent: number;
  closeReason: 'TAKE_PROFIT' | 'STOP_LOSS' | 'EARLY_MOMENTUM_REVERSAL' | 'MANUAL' | null;
  failureAnalysis?: {
    volumeRatio?: number | null;
    indicators?: Array<{ name: string; value: unknown; vote: 'BUY' | 'SELL' | 'NEUTRAL' }>;
  } | null;
  cooldownUntil?: string | null;
  strategy: string;
  openedAt: string;
  closedAt: string | null;
};

export interface BackendAuditEvent {
  id: string;
  time: string;
  type: 'ENGINE' | 'TRADE' | 'FEED';
  symbol: string | null;
  message: string;
}

interface TradesResponse {
  trades: BackendTrade[];
}

export interface BackendSnapshot {
  status: BackendStatus;
  wallet: BackendWallet;
  trades: BackendTrade[];
  markets: BackendMarket[];
}

async function request<T>(path: string, signal?: AbortSignal, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}/${path.replace(/^\/+/, '')}`, {
    headers: { Accept: 'application/json', ...init?.headers },
    ...init,
    signal,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error || `Backend request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

async function requestControl(path: string): Promise<void> {
  const response = await fetch(`/api/control/${path}`, {
    method: 'POST',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error || `Control request failed (${response.status})`);
  }
}

export async function getBackendSnapshot(signal?: AbortSignal): Promise<BackendSnapshot> {
  const [status, wallet, openTradeResponse, closedTradeResponse, marketResponse] = await Promise.all([
    request<BackendStatus>('/bot/status', signal),
    request<BackendWallet>('/wallet', signal),
    request<TradesResponse>('/trades?status=OPEN&limit=200', signal),
    request<TradesResponse>('/trades?status=CLOSED&limit=200', signal),
    request<MarketsResponse>('/market/status', signal),
  ]);
  if (!Array.isArray(status.symbols)
    || !Array.isArray(marketResponse.markets)
    || marketResponse.markets.length !== status.symbols.length
    || !marketResponse.markets.every((market) =>
      status.symbols.includes(market.symbol)
      && Number.isFinite(market.price)
      && ['TRADE', 'ORDER_BOOK_MID'].includes(market.priceSource)
      && market.candleCount === 500
      && market.orderBook?.levelCount === 20
      && Array.isArray(market.orderBook.bids)
      && market.orderBook.bids.length === 20
      && Array.isArray(market.orderBook.asks)
      && market.orderBook.asks.length === 20)) {
    throw new Error('DATA_FEED_OFFLINE: backend returned incomplete or invalid Binance market data');
  }
  return {
    status,
    wallet,
    trades: [...openTradeResponse.trades, ...closedTradeResponse.trades],
    markets: marketResponse.markets,
  };
}

export async function getBackendAudit(signal?: AbortSignal): Promise<BackendAuditEvent[]> {
  const response = await request<{ events: BackendAuditEvent[] }>('/bot/audit', signal);
  if (!Array.isArray(response.events)) throw new Error('Backend returned invalid audit events');
  return response.events;
}

export async function setBotEnabled(enabled: boolean): Promise<void> {
  await requestControl(`bot/${enabled ? 'start' : 'stop'}`);
}

export async function closePaperTrade(tradeId: string): Promise<void> {
  await requestControl(`trades/${encodeURIComponent(tradeId)}/close`);
}

export async function getRealCandles(symbol: string, signal?: AbortSignal): Promise<BackendCandle[]> {
  const response = await request<CandlesResponse>(`/market/${encodeURIComponent(symbol)}/candles`, signal);
  if (!Array.isArray(response.candles)) {
    throw new Error(`DATA_FEED_OFFLINE: invalid Binance candle response for ${symbol}`);
  }
  if (response.candles.length < 250) {
    throw new Error(`INSUFFICIENT_HISTORICAL_DATA: received fewer than 250 finalized Binance candles for ${symbol}`);
  }
  if (response.candles.length !== 500
    || !response.candles.every((candle) => candle.isFinal === true
      && [candle.openTime, candle.closeTime, candle.open, candle.high, candle.low, candle.close, candle.volume]
        .every(Number.isFinite))
    || !response.candles.slice(1).every((candle, index) =>
      response.candles[index].closeTime + 1 === candle.openTime)) {
    throw new Error(`DATA_FEED_OFFLINE: expected 500 valid finalized Binance candles for ${symbol}`);
  }
  return response.candles;
}
