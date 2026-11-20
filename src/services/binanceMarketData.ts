import type { ClosedCandle } from '../utils/indicators';

export const TERMINAL_TIMEFRAMES = ['5m', '15m', '1h', '4h', '1d'] as const;
export type TerminalTimeframe = typeof TERMINAL_TIMEFRAMES[number];

const REST_ORIGIN = 'https://data-api.binance.vision';
const STREAM_ORIGIN = 'wss://data-stream.binance.vision/stream';
const INTERVAL_MS: Record<TerminalTimeframe, number> = {
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

export interface LiveKline extends ClosedCandle {
  isClosed: boolean;
}

export interface BinanceStreamHandlers {
  onConnectionChange: (connected: boolean) => void;
  onPrice: (price: number, eventTime: number) => void;
  onCandle: (candle: LiveKline) => void;
  onError: (message: string) => void;
}

export function normalizeUsdtSymbol(input: string): string {
  const cleaned = input.trim().toUpperCase();
  if (!cleaned || !/^[A-Z0-9]+$/.test(cleaned)) {
    throw new Error('Enter a Binance symbol using letters or numbers only.');
  }
  const symbol = cleaned.endsWith('USDT') ? cleaned : `${cleaned}USDT`;
  if (!/^[A-Z0-9]{2,20}USDT$/.test(symbol)) {
    throw new Error('The symbol must be a valid USDT pair such as ETHUSDT.');
  }
  return symbol;
}

function parseKline(row: unknown[]): LiveKline | null {
  if (row.length < 7) return null;
  const openTime = Number(row[0]);
  const closeTime = Number(row[6]);
  const candle = {
    time: Math.floor(openTime / 1000),
    openTime,
    closeTime,
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
    isClosed: closeTime < Date.now(),
  };
  if (![candle.openTime, candle.closeTime, candle.open, candle.high, candle.low, candle.close, candle.volume]
    .every(Number.isFinite)
    || candle.open <= 0
    || candle.high < Math.max(candle.open, candle.close)
    || candle.low > Math.min(candle.open, candle.close)
    || candle.low <= 0
    || candle.volume < 0) return null;
  return candle;
}

function isContiguous(candles: LiveKline[], timeframe: TerminalTimeframe): boolean {
  return candles.slice(1).every((candle, index) =>
    candle.openTime - candles[index].openTime === INTERVAL_MS[timeframe]);
}

export async function fetchClosedCandles(
  symbolValue: string,
  timeframe: TerminalTimeframe,
  signal?: AbortSignal,
): Promise<ClosedCandle[]> {
  const symbol = normalizeUsdtSymbol(symbolValue);
  const url = new URL('/api/v3/klines', REST_ORIGIN);
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('interval', timeframe);
  url.searchParams.set('limit', '501');
  const response = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Binance history request failed (${response.status}).`);
  const rows = await response.json() as unknown;
  if (!Array.isArray(rows)) throw new Error('Binance returned an invalid candle response.');
  const closed = rows
    .filter((row): row is unknown[] => Array.isArray(row))
    .map(parseKline)
    .filter((candle): candle is LiveKline => Boolean(candle?.isClosed));
  const history = closed.slice(-500);
  if (history.length !== 500 || !isContiguous(history, timeframe)) {
    throw new Error(`Expected 500 contiguous, completed ${timeframe} candles for ${symbol}.`);
  }
  return history;
}

export async function fetchLatestPrice(symbolValue: string, signal?: AbortSignal): Promise<number> {
  const symbol = normalizeUsdtSymbol(symbolValue);
  const url = new URL('/api/v3/ticker/price', REST_ORIGIN);
  url.searchParams.set('symbol', symbol);
  const response = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Binance price request failed (${response.status}).`);
  const payload = await response.json() as { price?: unknown };
  const price = Number(payload.price);
  if (!Number.isFinite(price) || price <= 0) throw new Error(`Binance returned an invalid price for ${symbol}.`);
  return price;
}

export function connectBinanceStream(
  symbolValue: string,
  timeframe: TerminalTimeframe,
  handlers: BinanceStreamHandlers,
): () => void {
  const symbol = normalizeUsdtSymbol(symbolValue).toLowerCase();
  let closedByCaller = false;
  let socket: WebSocket | null = null;
  let reconnectTimer: number | null = null;
  let reconnectDelay = 1_000;

  const connect = () => {
    if (closedByCaller) return;
    socket = new WebSocket(`${STREAM_ORIGIN}?streams=${symbol}@trade/${symbol}@kline_${timeframe}`);
    socket.addEventListener('open', () => {
      reconnectDelay = 1_000;
      handlers.onConnectionChange(true);
    });
    socket.addEventListener('message', (message) => {
      try {
        const payload = JSON.parse(String(message.data)) as {
          data?: Record<string, unknown> & { k?: Record<string, unknown> };
        };
        const event = payload.data;
        if (!event) return;
        if (event.e === 'trade') {
          const price = Number(event.p);
          const eventTime = Number(event.T);
          if (Number.isFinite(price) && price > 0 && Number.isFinite(eventTime)) {
            handlers.onPrice(price, eventTime);
          }
          return;
        }
        if (event.e !== 'kline' || !event.k) return;
        const kline = event.k;
        const candle = parseKline([
          kline.t, kline.o, kline.h, kline.l, kline.c, kline.v, kline.T,
        ]);
        if (!candle) {
          handlers.onError(`Binance sent an invalid ${timeframe} candle for ${symbol.toUpperCase()}.`);
          return;
        }
        const isClosed = Boolean(kline.x);
        handlers.onCandle({ ...candle, isClosed });
      } catch {
        handlers.onError('Unable to decode the Binance live market message.');
      }
    });
    socket.addEventListener('error', () => {
      handlers.onError('Binance live market stream reported a connection error.');
    });
    socket.addEventListener('close', () => {
      handlers.onConnectionChange(false);
      socket = null;
      if (closedByCaller) return;
      reconnectTimer = window.setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
    });
  };

  connect();
  return () => {
    closedByCaller = true;
    if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
    if (socket) {
      socket.close();
      socket = null;
    }
    handlers.onConnectionChange(false);
  };
}
