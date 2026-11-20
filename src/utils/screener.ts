import { fetchClosedCandles, type TerminalTimeframe } from '../services/binanceMarketData';
import { analyzeClosedCandles, type ConsensusAnalysis } from './indicators';

export const CORE_USDT_PAIRS = [
  'BTCUSDT',
  'ETHUSDT',
  'SOLUSDT',
  'BNBUSDT',
  'XRPUSDT',
  'DOGEUSDT',
  'ADAUSDT',
  'AVAXUSDT',
  'SUIUSDT',
  'NEARUSDT',
] as const;

const TIMEFRAME_MS: Record<TerminalTimeframe, number> = {
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

export interface ScreenerOpportunity {
  symbol: typeof CORE_USDT_PAIRS[number];
  candles: Awaited<ReturnType<typeof fetchClosedCandles>>;
  analysis: ConsensusAnalysis;
  opportunityScore: number;
  opportunityRank: number | null;
  isTopOpportunity: boolean;
}

export async function scanCorePairs(
  timeframe: TerminalTimeframe,
  signal?: AbortSignal,
): Promise<ScreenerOpportunity[]> {
  const rows: ScreenerOpportunity[] = await Promise.all(CORE_USDT_PAIRS.map(async (symbol) => {
    const candles = await fetchClosedCandles(symbol, timeframe, signal);
    const analysis = analyzeClosedCandles(candles, TIMEFRAME_MS[timeframe]);
    return {
      symbol,
      candles,
      analysis,
      opportunityScore: analysis.opportunityScore,
      opportunityRank: null,
      isTopOpportunity: false,
    };
  }));
  const ranked = rows
    .filter((row) => row.analysis.side !== null)
    .sort((left, right) => right.opportunityScore - left.opportunityScore
      || left.symbol.localeCompare(right.symbol));
  ranked.slice(0, 2).forEach((row, index) => {
    row.opportunityRank = index + 1;
    row.isTopOpportunity = true;
  });
  return rows.sort((left, right) => left.symbol.localeCompare(right.symbol));
}
