export type LocalTradeSide = 'LONG' | 'SHORT';
export type LocalTradeStatus = 'OPEN' | 'CLOSED';
export type LocalCloseReason = 'TAKE_PROFIT' | 'STOP_LOSS' | 'MANUAL';

export interface LocalPaperTrade {
  id: string;
  symbol: string;
  side: LocalTradeSide;
  status: LocalTradeStatus;
  entryPrice: number;
  exitPrice: number | null;
  stopLoss: number;
  tp1Price: number;
  tp2Price: number;
  quantity: number;
  initialQuantity: number;
  remainingQuantity: number;
  margin: number;
  tp1Filled: boolean;
  realizedPnl: number;
  pnlUsd: number;
  closeReason: LocalCloseReason | null;
  openedAt: string;
  closedAt: string | null;
}

export interface LocalPaperAccount {
  id: 'primary';
  balance: number;
  startingBalance: number;
  totalRealizedPnl: number;
  winCount: number;
  lossCount: number;
  trades: LocalPaperTrade[];
  updatedAt: string;
}

const DATABASE_NAME = 'auraalgo-local';
const DATABASE_VERSION = 1;
const ACCOUNT_STORE = 'accounts';
const INITIAL_BALANCE = 10_000;

let databasePromise: Promise<IDBDatabase> | null = null;
let mutationQueue: Promise<void> = Promise.resolve();

function openDatabase(): Promise<IDBDatabase> {
  if (!('indexedDB' in window)) {
    return Promise.reject(new Error('IndexedDB is unavailable; local paper account cannot be opened.'));
  }
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(ACCOUNT_STORE)) {
        database.createObjectStore(ACCOUNT_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => {
      databasePromise = null;
      reject(new Error(`Unable to open local paper account: ${request.error?.message || 'IndexedDB request failed.'}`));
    };
    request.onblocked = () => {
      databasePromise = null;
      reject(new Error('Local paper account upgrade is blocked by another open AuraAlgo tab.'));
    };
  });
  return databasePromise;
}

function createAccount(): LocalPaperAccount {
  return {
    id: 'primary',
    balance: INITIAL_BALANCE,
    startingBalance: INITIAL_BALANCE,
    totalRealizedPnl: 0,
    winCount: 0,
    lossCount: 0,
    trades: [],
    updatedAt: new Date().toISOString(),
  };
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error(request.error?.message || 'IndexedDB operation failed.'));
  });
}

export async function loadLocalAccount(): Promise<LocalPaperAccount> {
  const database = await openDatabase();
  const transaction = database.transaction(ACCOUNT_STORE, 'readwrite');
  const store = transaction.objectStore(ACCOUNT_STORE);
  const existing = await requestResult(store.get('primary')) as LocalPaperAccount | undefined;
  const account = existing || createAccount();
  if (!existing) store.put(account);
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(new Error(transaction.error?.message || 'Unable to load local paper account.'));
    transaction.onabort = () => reject(new Error(transaction.error?.message || 'Local account transaction was aborted.'));
  });
  return account;
}

export async function updateLocalAccount(
  updater: (account: LocalPaperAccount) => LocalPaperAccount,
): Promise<LocalPaperAccount> {
  const operation = mutationQueue.then(async () => {
    const database = await openDatabase();
    const transaction = database.transaction(ACCOUNT_STORE, 'readwrite');
    const store = transaction.objectStore(ACCOUNT_STORE);
    const existing = await requestResult(store.get('primary')) as LocalPaperAccount | undefined;
    const updated = updater(existing || createAccount());
    updated.updatedAt = new Date().toISOString();
    store.put(updated);
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(new Error(transaction.error?.message || 'Unable to save local paper account.'));
      transaction.onabort = () => reject(new Error(transaction.error?.message || 'Local account update was aborted.'));
    });
    return updated;
  });
  mutationQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

export function localAvailableMargin(account: LocalPaperAccount): number {
  const reserved = account.trades
    .filter((trade) => trade.status === 'OPEN')
    .reduce((sum, trade) => sum + trade.margin * trade.remainingQuantity / trade.initialQuantity, 0);
  return Math.max(0, account.balance - reserved);
}

export function bookLocalTrade(
  account: LocalPaperAccount,
  symbol: string,
  side: LocalTradeSide,
  entryPrice: number,
  atr: number,
): LocalPaperAccount {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(atr) || atr <= 0) {
    throw new Error('A fresh positive Binance price and ATR value are required to book a local trade.');
  }
  if (account.trades.some((trade) => trade.status === 'OPEN' && trade.symbol === symbol)) {
    throw new Error(`${symbol} already has an open local paper position.`);
  }
  const margin = Math.min(localAvailableMargin(account) * 0.25, 2_500);
  if (margin <= 0) throw new Error('Local account has no available margin for another paper trade.');
  const quantity = Number((margin / entryPrice).toFixed(8));
  const stopDistance = atr * 1.5;
  const direction = side === 'LONG' ? 1 : -1;
  const trade: LocalPaperTrade = {
    id: crypto.randomUUID(),
    symbol,
    side,
    status: 'OPEN',
    entryPrice,
    exitPrice: null,
    stopLoss: entryPrice - direction * stopDistance,
    tp1Price: entryPrice + direction * atr * 1.5,
    tp2Price: entryPrice + direction * atr * 3,
    quantity,
    initialQuantity: quantity,
    remainingQuantity: quantity,
    margin,
    tp1Filled: false,
    realizedPnl: 0,
    pnlUsd: 0,
    closeReason: null,
    openedAt: new Date().toISOString(),
    closedAt: null,
  };
  return { ...account, trades: [trade, ...account.trades] };
}

function realizeQuantity(
  account: LocalPaperAccount,
  trade: LocalPaperTrade,
  quantity: number,
  price: number,
): void {
  const sign = trade.side === 'LONG' ? 1 : -1;
  const pnl = Number((sign * (price - trade.entryPrice) * quantity).toFixed(8));
  trade.realizedPnl = Number((trade.realizedPnl + pnl).toFixed(8));
  trade.pnlUsd = trade.realizedPnl;
  trade.remainingQuantity = Number((trade.remainingQuantity - quantity).toFixed(8));
  account.balance = Number((account.balance + pnl).toFixed(8));
  account.totalRealizedPnl = Number((account.totalRealizedPnl + pnl).toFixed(8));
}

function closeLocalTrade(
  account: LocalPaperAccount,
  trade: LocalPaperTrade,
  price: number,
  reason: LocalCloseReason,
): void {
  realizeQuantity(account, trade, trade.remainingQuantity, price);
  trade.status = 'CLOSED';
  trade.exitPrice = price;
  trade.closeReason = reason;
  trade.closedAt = new Date().toISOString();
  if (trade.realizedPnl > 0) account.winCount += 1;
  else account.lossCount += 1;
}

export function processLocalPriceTick(
  account: LocalPaperAccount,
  symbol: string,
  price: number,
): { account: LocalPaperAccount; closedProfit: LocalPaperTrade[] } {
  if (!Number.isFinite(price) || price <= 0) return { account, closedProfit: [] };
  const closedProfit: LocalPaperTrade[] = [];
  for (const trade of account.trades) {
    if (trade.status !== 'OPEN' || trade.symbol !== symbol) continue;
    const stopped = trade.side === 'LONG' ? price <= trade.stopLoss : price >= trade.stopLoss;
    if (stopped) {
      closeLocalTrade(account, trade, price, 'STOP_LOSS');
      continue;
    }

    const tp1Hit = trade.side === 'LONG' ? price >= trade.tp1Price : price <= trade.tp1Price;
    if (!trade.tp1Filled && tp1Hit) {
      realizeQuantity(account, trade, trade.initialQuantity * 0.5, price);
      trade.tp1Filled = true;
      trade.stopLoss = Number((trade.entryPrice * (trade.side === 'LONG' ? 1.0035 : 0.9965)).toFixed(8));
      if (trade.realizedPnl > 0) closedProfit.push({ ...trade });
    }

    const tp2Hit = trade.side === 'LONG' ? price >= trade.tp2Price : price <= trade.tp2Price;
    if (trade.tp1Filled && tp2Hit && trade.status === 'OPEN') {
      closeLocalTrade(account, trade, price, 'TAKE_PROFIT');
      if (trade.realizedPnl > 0) closedProfit.push(trade);
    }
  }
  return { account, closedProfit };
}

export function closeLocalPosition(
  account: LocalPaperAccount,
  tradeId: string,
  price: number,
): LocalPaperAccount {
  const trade = account.trades.find((candidate) =>
    candidate.id === tradeId && candidate.status === 'OPEN');
  if (!trade) throw new Error('Open local paper position was not found.');
  if (!Number.isFinite(price) || price <= 0) throw new Error('A fresh positive Binance price is required to close this position.');
  closeLocalTrade(account, trade, price, 'MANUAL');
  return account;
}

export function adjustLocalEquity(account: LocalPaperAccount, balance: number): LocalPaperAccount {
  if (!Number.isFinite(balance) || balance <= 0) {
    throw new Error('Adjusted local equity must be a positive number.');
  }
  return {
    ...account,
    balance: Number(balance.toFixed(2)),
    startingBalance: Number((balance - account.totalRealizedPnl).toFixed(2)),
  };
}
