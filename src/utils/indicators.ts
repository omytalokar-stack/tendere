import {
  ADX,
  ATR,
  BollingerBands,
  EMA,
  MACD,
  OBV,
  RSI,
  SMA,
  StochasticRSI,
} from 'technicalindicators';

export interface ClosedCandle {
  time: number;
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  isClosed: boolean;
}

export type MarketDirection = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

export interface IndicatorVote {
  name: string;
  value: unknown;
  direction: MarketDirection;
  weight: 1;
}

export interface ConsensusAnalysis {
  side: 'LONG' | 'SHORT' | null;
  bullishCount: number;
  bearishCount: number;
  buyVotes: number;
  sellVotes: number;
  totalVotes: 10;
  close: number;
  ema20: number;
  ema50: number;
  ema200: number;
  atr: number;
  rsi: number;
  adx: number;
  pdi: number;
  mdi: number;
  supertrend: { value: number; direction: MarketDirection };
  stochasticRsi: { stochRSI: number; k: number; d: number };
  macd: { MACD: number; signal: number; histogram: number };
  bollinger: { upper: number; middle: number; lower: number; percentB: number };
  obv: number;
  obvSma20: number;
  currentVolume: number;
  averageVolume: number;
  volumeRatio: number;
  volumeSpikeRatio: number;
  opportunityScore: number;
  indicators: IndicatorVote[];
}

export interface CandleAuditRow extends ClosedCandle {
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  supertrend: number | null;
  rsi14: number | null;
  macdHistogram: number | null;
  stochasticK: number | null;
  stochasticD: number | null;
  bollingerPercentB: number | null;
  atr14: number | null;
  adx14: number | null;
  pdi14: number | null;
  mdi14: number | null;
  obv: number | null;
  obvSma20: number | null;
}

const REQUIRED_CANDLES = 500;
const MIN_ENTRY_VOTES = 7;

function latest<T>(values: T[]): T | undefined {
  return values.length ? values[values.length - 1] : undefined;
}

function directionToVote(direction: MarketDirection): 'BUY' | 'SELL' | 'NEUTRAL' {
  return direction === 'BULLISH' ? 'BUY' : direction === 'BEARISH' ? 'SELL' : 'NEUTRAL';
}

export function calculateSupertrend(candles: ClosedCandle[]) {
  const atrValues = ATR.calculate({
    high: candles.map((candle) => candle.high),
    low: candles.map((candle) => candle.low),
    close: candles.map((candle) => candle.close),
    period: 10,
  });
  const atrOffset = candles.length - atrValues.length;
  let finalUpper: number | null = null;
  let finalLower: number | null = null;
  let trend: MarketDirection = 'NEUTRAL';
  let value: number | null = null;

  for (let index = 0; index < atrValues.length; index += 1) {
    const candleIndex = atrOffset + index;
    const candle = candles[candleIndex];
    const previousClose = candleIndex > 0 ? candles[candleIndex - 1].close : candle.close;
    const midpoint = (candle.high + candle.low) / 2;
    const basicUpper = midpoint + 3 * atrValues[index];
    const basicLower = midpoint - 3 * atrValues[index];

    if (finalUpper === null || finalLower === null) {
      finalUpper = basicUpper;
      finalLower = basicLower;
      trend = candle.close >= midpoint ? 'BULLISH' : 'BEARISH';
    } else {
      finalUpper = basicUpper < finalUpper || previousClose > finalUpper ? basicUpper : finalUpper;
      finalLower = basicLower > finalLower || previousClose < finalLower ? basicLower : finalLower;
      trend = trend === 'BEARISH'
        ? candle.close > finalUpper ? 'BULLISH' : 'BEARISH'
        : candle.close < finalLower ? 'BEARISH' : 'BULLISH';
    }
    value = trend === 'BULLISH' ? finalLower : finalUpper;
  }
  if (!Number.isFinite(value)) throw new Error('Unable to calculate Supertrend from closed candles.');
  return { value: value as number, direction: trend };
}

export function calculateSupertrendSeries(candles: ClosedCandle[]): Array<number | null> {
  const atrValues = ATR.calculate({
    high: candles.map((candle) => candle.high),
    low: candles.map((candle) => candle.low),
    close: candles.map((candle) => candle.close),
    period: 10,
  });
  const result: Array<number | null> = Array(candles.length).fill(null);
  const offset = candles.length - atrValues.length;
  let finalUpper: number | null = null;
  let finalLower: number | null = null;
  let trend: MarketDirection = 'NEUTRAL';
  for (let index = 0; index < atrValues.length; index += 1) {
    const candleIndex = offset + index;
    const candle = candles[candleIndex];
    const previousClose = candleIndex > 0 ? candles[candleIndex - 1].close : candle.close;
    const midpoint = (candle.high + candle.low) / 2;
    const upper = midpoint + 3 * atrValues[index];
    const lower = midpoint - 3 * atrValues[index];
    if (finalUpper === null || finalLower === null) {
      finalUpper = upper;
      finalLower = lower;
      trend = candle.close >= midpoint ? 'BULLISH' : 'BEARISH';
    } else {
      finalUpper = upper < finalUpper || previousClose > finalUpper ? upper : finalUpper;
      finalLower = lower > finalLower || previousClose < finalLower ? lower : finalLower;
      trend = trend === 'BEARISH'
        ? candle.close > finalUpper ? 'BULLISH' : 'BEARISH'
        : candle.close < finalLower ? 'BEARISH' : 'BULLISH';
    }
    result[candleIndex] = trend === 'BULLISH' ? finalLower : finalUpper;
  }
  return result;
}

export function calculateEmaSeries(candles: ClosedCandle[], period: number): Array<number | null> {
  const values = EMA.calculate({ values: candles.map((candle) => candle.close), period });
  const offset = candles.length - values.length;
  return candles.map((_, index) => values[index - offset] ?? null);
}

export function calculateBollingerSeries(candles: ClosedCandle[]) {
  const values = BollingerBands.calculate({
    values: candles.map((candle) => candle.close),
    period: 20,
    stdDev: 2,
  });
  const offset = candles.length - values.length;
  return candles.map((_, index) => {
    const band = values[index - offset];
    return band
      ? { upper: band.upper, middle: band.middle, lower: band.lower }
      : null;
  });
}

export function buildCandleAuditRows(candles: ClosedCandle[]): CandleAuditRow[] {
  const close = candles.map((candle) => candle.close);
  const high = candles.map((candle) => candle.high);
  const low = candles.map((candle) => candle.low);
  const volume = candles.map((candle) => candle.volume);
  const align = (values: number[], index: number, offset: number) => values[index - offset] ?? null;
  const ema20 = EMA.calculate({ values: close, period: 20 });
  const ema50 = EMA.calculate({ values: close, period: 50 });
  const ema200 = EMA.calculate({ values: close, period: 200 });
  const rsi14 = RSI.calculate({ values: close, period: 14 });
  const atr14 = ATR.calculate({ high, low, close, period: 14 });
  const adxValues = ADX.calculate({ high, low, close, period: 14 });
  const adx14 = adxValues.map((entry) => entry.adx);
  const obv = OBV.calculate({ close, volume });
  const obvSma20 = SMA.calculate({ values: obv, period: 20 });
  const macd = MACD.calculate({
    values: close,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });
  const stochastic = StochasticRSI.calculate({
    values: close,
    rsiPeriod: 14,
    stochasticPeriod: 14,
    kPeriod: 3,
    dPeriod: 3,
  });
  const bands = calculateBollingerSeries(candles);
  const supertrend = calculateSupertrendSeries(candles);
  const ema20Offset = candles.length - ema20.length;
  const ema50Offset = candles.length - ema50.length;
  const ema200Offset = candles.length - ema200.length;
  const rsiOffset = candles.length - rsi14.length;
  const atrOffset = candles.length - atr14.length;
  const adxOffset = candles.length - adx14.length;
  const obvSmaOffset = candles.length - obvSma20.length;
  const macdOffset = candles.length - macd.length;
  const stochasticOffset = candles.length - stochastic.length;
  return candles.map((candle, index) => ({
    ...candle,
    ema20: align(ema20, index, ema20Offset),
    ema50: align(ema50, index, ema50Offset),
    ema200: align(ema200, index, ema200Offset),
    supertrend: supertrend[index] ?? null,
    rsi14: align(rsi14, index, rsiOffset),
    macdHistogram: macd[index - macdOffset]?.histogram ?? null,
    stochasticK: stochastic[index - stochasticOffset]?.k ?? null,
    stochasticD: stochastic[index - stochasticOffset]?.d ?? null,
    bollingerPercentB: bands[index] && bands[index]!.upper !== bands[index]!.lower
      ? (candle.close - bands[index]!.lower) / (bands[index]!.upper - bands[index]!.lower)
      : null,
    atr14: align(atr14, index, atrOffset),
    adx14: align(adx14, index, adxOffset),
    pdi14: adxValues[index - adxOffset]?.pdi ?? null,
    mdi14: adxValues[index - adxOffset]?.mdi ?? null,
    obv: obv[index] ?? null,
    obvSma20: align(obvSma20, index, obvSmaOffset),
  }));
}

export function analyzeClosedCandles(candles: ClosedCandle[]): ConsensusAnalysis {
  if (candles.length !== REQUIRED_CANDLES
    || !candles.every((candle) => candle.isClosed === true
      && [candle.openTime, candle.open, candle.high, candle.low, candle.close, candle.volume]
        .every(Number.isFinite)
      && candle.open > 0
      && candle.high >= Math.max(candle.open, candle.close)
      && candle.low <= Math.min(candle.open, candle.close)
      && candle.low > 0
      && candle.close > 0
      && candle.volume >= 0)
    || !candles.slice(1).every((candle, index) =>
      candle.openTime > candles[index].openTime)) {
    throw new Error('INSUFFICIENT_HISTORICAL_DATA: exactly 500 valid closed candles are required.');
  }

  const close = candles.map((candle) => candle.close);
  const high = candles.map((candle) => candle.high);
  const low = candles.map((candle) => candle.low);
  const volume = candles.map((candle) => candle.volume);
  const latestCandle = candles[candles.length - 1];
  const rsi = Number(latest(RSI.calculate({ values: close, period: 14 })));
  const ema20 = Number(latest(EMA.calculate({ values: close, period: 20 })));
  const ema50 = Number(latest(EMA.calculate({ values: close, period: 50 })));
  const ema200 = Number(latest(EMA.calculate({ values: close, period: 200 })));
  const macdOutput = latest(MACD.calculate({
    values: close,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  }));
  const macd = {
    MACD: Number(macdOutput?.MACD),
    signal: Number(macdOutput?.signal),
    histogram: Number(macdOutput?.histogram),
  };
  const bandsOutput = latest(BollingerBands.calculate({ values: close, period: 20, stdDev: 2 }));
  const bands = {
    upper: Number(bandsOutput?.upper),
    middle: Number(bandsOutput?.middle),
    lower: Number(bandsOutput?.lower),
  };
  const atr = Number(latest(ATR.calculate({ high, low, close, period: 14 })));
  const adxOutput = latest(ADX.calculate({ high, low, close, period: 14 }));
  const adx = {
    adx: Number(adxOutput?.adx),
    pdi: Number(adxOutput?.pdi),
    mdi: Number(adxOutput?.mdi),
  };
  const stochasticOutput = latest(StochasticRSI.calculate({
    values: close,
    rsiPeriod: 14,
    stochasticPeriod: 14,
    kPeriod: 3,
    dPeriod: 3,
  }));
  const stochasticRsi = {
    stochRSI: Number(stochasticOutput?.stochRSI),
    k: Number(stochasticOutput?.k),
    d: Number(stochasticOutput?.d),
  };
  const obvSeries = OBV.calculate({ close, volume });
  const obv = Number(latest(obvSeries));
  const obvSma20 = Number(latest(SMA.calculate({ values: obvSeries, period: 20 })));
  const supertrend = calculateSupertrend(candles);
  const priorVolumes = volume.slice(-21, -1);
  const averageVolume = priorVolumes.reduce((sum, item) => sum + item, 0) / priorVolumes.length;
  const currentVolume = latestCandle.volume;
  const volumeRatio = averageVolume > 0 ? currentVolume / averageVolume : Number.NaN;
  const percentB = bands && bands.upper !== bands.lower
    ? (latestCandle.close - bands.lower) / (bands.upper - bands.lower)
    : Number.NaN;
  const values = [
    rsi, ema20, ema50, ema200, macd?.MACD, macd?.signal, macd?.histogram,
    bands?.middle, bands?.upper, bands?.lower, percentB, atr, adx?.adx, adx?.pdi,
    adx?.mdi, stochasticRsi?.k, stochasticRsi?.d, obv, obvSma20, supertrend.value,
    averageVolume, volumeRatio,
  ];
  if (!values.every(Number.isFinite) || averageVolume <= 0) {
    throw new Error('INVALID_LIVE_MARKET_DATA: closed-candle indicators could not be calculated.');
  }

  const stochasticDirection = stochasticRsi.k < 20 && stochasticRsi.k > stochasticRsi.d
    ? 'BULLISH'
    : stochasticRsi.k > 80 && stochasticRsi.k < stochasticRsi.d
      ? 'BEARISH'
      : stochasticRsi.k > stochasticRsi.d
        ? 'BULLISH'
        : stochasticRsi.k < stochasticRsi.d ? 'BEARISH' : 'NEUTRAL';
  const adxDirection = adx.adx >= 20
    ? adx.pdi > adx.mdi ? 'BULLISH' : adx.mdi > adx.pdi ? 'BEARISH' : 'NEUTRAL'
    : 'NEUTRAL';
  const volumeDirection = volumeRatio >= 1.15
    ? latestCandle.close > candles[candles.length - 2].close
      ? 'BULLISH'
      : latestCandle.close < candles[candles.length - 2].close ? 'BEARISH' : 'NEUTRAL'
    : 'NEUTRAL';
  const indicators: IndicatorVote[] = [
    { name: 'EMA-200 macro trend', value: ema200, direction: latestCandle.close > ema200 ? 'BULLISH' : latestCandle.close < ema200 ? 'BEARISH' : 'NEUTRAL', weight: 1 },
    { name: 'EMA-20/50 ribbon', value: { ema20, ema50 }, direction: ema20 > ema50 ? 'BULLISH' : ema20 < ema50 ? 'BEARISH' : 'NEUTRAL', weight: 1 },
    { name: 'Supertrend-10/3', value: supertrend, direction: supertrend.direction, weight: 1 },
    { name: 'RSI-14', value: rsi, direction: rsi <= 35 ? 'BULLISH' : rsi >= 65 ? 'BEARISH' : 'NEUTRAL', weight: 1 },
    { name: 'MACD-12/26/9', value: macd, direction: macd.histogram > 0 ? 'BULLISH' : macd.histogram < 0 ? 'BEARISH' : 'NEUTRAL', weight: 1 },
    { name: 'Stoch RSI-14/14/3/3', value: stochasticRsi, direction: stochasticDirection, weight: 1 },
    { name: 'Bollinger-20/2', value: { ...bands, percentB }, direction: percentB > 0.5 && latestCandle.close > bands.middle ? 'BULLISH' : percentB < 0.5 && latestCandle.close < bands.middle ? 'BEARISH' : 'NEUTRAL', weight: 1 },
    { name: 'ADX/+DI/-DI-14', value: adx, direction: adxDirection, weight: 1 },
    { name: 'OBV vs SMA-20', value: { obv, obvSma20 }, direction: obv > obvSma20 ? 'BULLISH' : obv < obvSma20 ? 'BEARISH' : 'NEUTRAL', weight: 1 },
    { name: 'ATR-14 + candle body', value: { atr, body: latestCandle.close - latestCandle.open }, direction: latestCandle.close > latestCandle.open ? 'BULLISH' : latestCandle.close < latestCandle.open ? 'BEARISH' : 'NEUTRAL', weight: 1 },
  ];
  const bullishCount = indicators.filter((item) => item.direction === 'BULLISH').length;
  const bearishCount = indicators.filter((item) => item.direction === 'BEARISH').length;
  const side = bullishCount >= MIN_ENTRY_VOTES
    && latestCandle.close > ema200
    && ema20 > ema50
    && adx.adx >= 20
    && adx.pdi > adx.mdi
    && adx.adx > 22
    && volumeRatio >= 1.2
    && rsi <= 68
    ? 'LONG'
    : bearishCount >= MIN_ENTRY_VOTES
      && latestCandle.close < ema200
      && ema20 < ema50
      && adx.adx >= 20
      && adx.mdi > adx.pdi
      && adx.adx > 22
      && volumeRatio >= 1.2
      && rsi >= 32
      ? 'SHORT'
      : null;
  return {
    side,
    bullishCount,
    bearishCount,
    buyVotes: bullishCount,
    sellVotes: bearishCount,
    totalVotes: 10,
    close: latestCandle.close,
    ema20,
    ema50,
    ema200,
    atr,
    rsi,
    adx: adx.adx,
    pdi: adx.pdi,
    mdi: adx.mdi,
    supertrend,
    stochasticRsi,
    macd,
    bollinger: { ...bands, percentB },
    obv,
    obvSma20,
    currentVolume,
    averageVolume,
    volumeRatio,
    volumeSpikeRatio: volumeRatio,
    opportunityScore: volumeRatio * adx.adx,
    indicators,
  };
}

export function indicatorVoteLabel(direction: MarketDirection): 'BUY' | 'SELL' | 'NEUTRAL' {
  return directionToVote(direction);
}
