import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CandlestickSeries,
  ColorType,
  HistogramSeries,
  LineSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type Time,
} from 'lightweight-charts';
import {
  calculateBollingerSeries,
  calculateEmaSeries,
  calculateSupertrendSeries,
  type ClosedCandle,
} from '../utils/indicators';
import type { LiveKline } from '../services/binanceMarketData';

interface TerminalChartProps {
  symbol: string;
  candles: ClosedCandle[];
  liveCandle: LiveKline | null;
}

type OverlayKey = 'ema20' | 'ema50' | 'ema200' | 'supertrend' | 'bollinger' | 'volume';
const OVERLAYS: Array<{ key: OverlayKey; label: string }> = [
  { key: 'ema20', label: 'EMA 20' },
  { key: 'ema50', label: 'EMA 50' },
  { key: 'ema200', label: 'EMA 200' },
  { key: 'supertrend', label: 'Supertrend 10/3' },
  { key: 'bollinger', label: 'Bollinger 20/2' },
  { key: 'volume', label: 'Volume' },
];

export function TerminalChart({ symbol, candles, liveCandle }: TerminalChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const overlaySeriesRef = useRef<Partial<Record<OverlayKey, ISeriesApi<'Line'>>>>({});
  const bollingerMiddleRef = useRef<ISeriesApi<'Line'> | null>(null);
  const bollingerLowerRef = useRef<ISeriesApi<'Line'> | null>(null);
  const [enabled, setEnabled] = useState<Record<OverlayKey, boolean>>({
    ema20: true,
    ema50: true,
    ema200: true,
    supertrend: false,
    bollinger: false,
    volume: true,
  });
  const [crosshair, setCrosshair] = useState<{
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  } | null>(null);

  const overlays = useMemo(() => ({
    ema20: calculateEmaSeries(candles, 20),
    ema50: calculateEmaSeries(candles, 50),
    ema200: calculateEmaSeries(candles, 200),
    supertrend: calculateSupertrendSeries(candles),
    bollinger: calculateBollingerSeries(candles),
  }), [candles]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: '#0d0b14' },
        textColor: '#94a3b8',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      },
      grid: {
        vertLines: { color: 'rgba(167, 139, 250, 0.08)' },
        horzLines: { color: 'rgba(167, 139, 250, 0.08)' },
      },
      rightPriceScale: { borderColor: 'rgba(167, 139, 250, 0.18)' },
      timeScale: { borderColor: 'rgba(167, 139, 250, 0.18)', timeVisible: true },
      crosshair: { vertLine: { color: '#c084fc' }, horzLine: { color: '#c084fc' } },
    });
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#34d399',
      downColor: '#fb7185',
      borderUpColor: '#34d399',
      borderDownColor: '#fb7185',
      wickUpColor: '#34d399',
      wickDownColor: '#fb7185',
    });
    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    const lineOptions = { lineWidth: 2 as const, priceLineVisible: false, lastValueVisible: false };
    const series: Partial<Record<OverlayKey, ISeriesApi<'Line'>>> = {
      ema20: chart.addSeries(LineSeries, { ...lineOptions, color: '#38bdf8' }),
      ema50: chart.addSeries(LineSeries, { ...lineOptions, color: '#fbbf24' }),
      ema200: chart.addSeries(LineSeries, { ...lineOptions, color: '#c084fc' }),
      supertrend: chart.addSeries(LineSeries, { ...lineOptions, color: '#34d399', lineWidth: 2 }),
      bollinger: chart.addSeries(LineSeries, { ...lineOptions, color: '#f472b6', lineWidth: 1 }),
    };
    bollingerMiddleRef.current = chart.addSeries(LineSeries, {
      ...lineOptions,
      color: 'rgba(244, 114, 182, 0.65)',
      lineWidth: 1,
      lineStyle: 2,
    });
    bollingerLowerRef.current = chart.addSeries(LineSeries, {
      ...lineOptions,
      color: 'rgba(244, 114, 182, 0.65)',
      lineWidth: 1,
      lineStyle: 2,
    });
    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;
    overlaySeriesRef.current = series;
    chart.subscribeCrosshairMove((parameter) => {
      if (!parameter.time) {
        setCrosshair(null);
        return;
      }
      const candle = parameter.seriesData.get(candleSeries) as {
        open?: number;
        high?: number;
        low?: number;
        close?: number;
      } | undefined;
      if (!candle || candle.open === undefined || candle.high === undefined
        || candle.low === undefined || candle.close === undefined) {
        setCrosshair(null);
        return;
      }
      const volume = parameter.seriesData.get(volumeSeries) as { value?: number } | undefined;
      setCrosshair({
        time: Number(parameter.time),
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: volume?.value ?? 0,
      });
    });
    return () => {
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      overlaySeriesRef.current = {};
      bollingerMiddleRef.current = null;
      bollingerLowerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    const candleSeries = candleSeriesRef.current;
    const volumeSeries = volumeSeriesRef.current;
    if (!chart || !candleSeries || !volumeSeries || candles.length === 0) return;

    candleSeries.setData(candles.map((candle) => ({
      time: candle.time as Time,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
    })));
    volumeSeries.setData(candles.map((candle) => ({
      time: candle.time as Time,
      value: candle.volume,
      color: candle.close >= candle.open ? 'rgba(52, 211, 153, 0.42)' : 'rgba(251, 113, 133, 0.42)',
    })));

    const line = (values: Array<number | null>) => values.flatMap((value, index) =>
      value === null || !Number.isFinite(value)
        ? []
        : [{ time: candles[index].time as Time, value }]);
    overlaySeriesRef.current.ema20?.setData(line(overlays.ema20));
    overlaySeriesRef.current.ema50?.setData(line(overlays.ema50));
    overlaySeriesRef.current.ema200?.setData(line(overlays.ema200));
    overlaySeriesRef.current.supertrend?.setData(line(overlays.supertrend));
    const bollingerUpper = overlays.bollinger.flatMap((bands, index) =>
      bands ? [{ time: candles[index].time as Time, value: bands.upper }] : []);
    const bollingerMiddle = overlays.bollinger.flatMap((bands, index) =>
      bands ? [{ time: candles[index].time as Time, value: bands.middle }] : []);
    const bollingerLower = overlays.bollinger.flatMap((bands, index) =>
      bands ? [{ time: candles[index].time as Time, value: bands.lower }] : []);
    overlaySeriesRef.current.bollinger?.setData(bollingerUpper);
    bollingerMiddleRef.current?.setData(bollingerMiddle);
    bollingerLowerRef.current?.setData(bollingerLower);
    chart.timeScale().fitContent();
  }, [candles, overlays, enabled.bollinger]);

  useEffect(() => {
    if (!liveCandle || liveCandle.isClosed) return;
    const candleSeries = candleSeriesRef.current;
    const volumeSeries = volumeSeriesRef.current;
    if (!candleSeries || !volumeSeries) return;
    candleSeries.update({
      time: liveCandle.time as Time,
      open: liveCandle.open,
      high: liveCandle.high,
      low: liveCandle.low,
      close: liveCandle.close,
    });
    volumeSeries.update({
      time: liveCandle.time as Time,
      value: liveCandle.volume,
      color: liveCandle.close >= liveCandle.open ? 'rgba(52, 211, 153, 0.42)' : 'rgba(251, 113, 133, 0.42)',
    });
  }, [liveCandle]);

  useEffect(() => {
    for (const [key, series] of Object.entries(overlaySeriesRef.current)) {
      if (series) series.applyOptions({ visible: enabled[key as OverlayKey] });
    }
    bollingerMiddleRef.current?.applyOptions({ visible: enabled.bollinger });
    bollingerLowerRef.current?.applyOptions({ visible: enabled.bollinger });
    volumeSeriesRef.current?.applyOptions({ visible: enabled.volume });
  }, [enabled]);

  const price = (value: number | undefined) => value === undefined
    ? '—'
    : value.toLocaleString('en-US', { maximumFractionDigits: 8 });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {OVERLAYS.map(({ key, label }) => (
          <label key={key} className="flex cursor-pointer items-center gap-2 rounded-lg border border-purple-400/15 bg-black/20 px-2.5 py-1.5 text-[10px] text-slate-300">
            <input
              type="checkbox"
              checked={enabled[key]}
              onChange={(event) => setEnabled((current) => ({ ...current, [key]: event.target.checked }))}
              className="accent-fuchsia-400"
            />
            {label}
          </label>
        ))}
      </div>
      <div className="rounded-2xl border border-purple-400/15 bg-[#0d0b14] p-2">
        <div className="flex min-h-7 flex-wrap items-center gap-x-4 gap-y-1 px-2 pb-2 font-mono text-[10px] text-slate-400" aria-live="polite">
          <span>{symbol}</span>
          <span>O {price(crosshair?.open)}</span>
          <span>H {price(crosshair?.high)}</span>
          <span>L {price(crosshair?.low)}</span>
          <span>C {price(crosshair?.close)}</span>
          <span>V {crosshair?.volume.toLocaleString('en-US', { maximumFractionDigits: 4 }) ?? '—'}</span>
        </div>
        <div ref={containerRef} className="h-[420px] min-w-[320px] w-full" />
      </div>
      <p className="text-[10px] text-slate-500">Indicator overlays use finalized candles; the current Binance kline updates live.</p>
    </div>
  );
}
