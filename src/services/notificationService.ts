import type { BackendTrade } from './backendApi';
import confetti from 'canvas-confetti';

const ALERTS_ENABLED_KEY = 'alerts_enabled';
const AUDIO_MUTED_KEY = 'audio_muted';
let audioContext: AudioContext | null = null;

export type CelebrationKind = 'opportunity' | 'profit';

export function isAudioMuted(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    const stored = window.localStorage.getItem(AUDIO_MUTED_KEY);
    return stored === null || stored === 'true';
  } catch {
    return true;
  }
}

export function setAudioMuted(muted: boolean): boolean {
  if (typeof window === 'undefined') return false;
  try {
    window.localStorage.setItem(AUDIO_MUTED_KEY, String(muted));
    if (!muted) {
      audioContext ??= new AudioContext();
      void audioContext.resume().catch((error: unknown) => {
        console.warn('Unable to resume AuraAlgo audio feedback', error);
      });
    } else if (audioContext?.state === 'running') {
      void audioContext.suspend().catch((error: unknown) => {
        console.warn('Unable to suspend AuraAlgo audio feedback', error);
      });
    }
    return true;
  } catch {
    return false;
  }
}

function playChime(context: AudioContext, kind: CelebrationKind): void {
  const isProfit = kind === 'profit';
  const frequencies = isProfit ? [660, 880, 1108] : [523, 784];
  frequencies.forEach((frequency, index) => {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const start = context.currentTime + index * 0.12;
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(frequency, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.1, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.22);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(start);
    oscillator.stop(start + 0.24);
  });
}

export function celebrate(kind: CelebrationKind): void {
  if (typeof window === 'undefined') return;
  const isProfit = kind === 'profit';
  confetti({
    particleCount: isProfit ? 90 : 42,
    spread: isProfit ? 70 : 48,
    origin: { y: 0.72 },
    colors: isProfit ? ['#34d399', '#f472b6', '#a78bfa'] : ['#f472b6', '#a78bfa', '#fbbf24'],
    disableForReducedMotion: true,
  });
  if (isAudioMuted()) return;

  try {
    audioContext ??= new AudioContext();
    const context = audioContext;
    if (context.state === 'running') playChime(context, kind);
    else void context.resume()
      .then(() => playChime(context, kind))
      .catch((error: unknown) => console.warn('AuraAlgo audio feedback is unavailable', error));
  } catch (error) {
    console.warn('AuraAlgo audio feedback is unavailable', error);
  }
}

export function areBrowserAlertsEnabled(): boolean {
  if (typeof window === 'undefined' || !('Notification' in window)) return false;
  try {
    const enabled = window.localStorage.getItem(ALERTS_ENABLED_KEY) === 'true';
    if (Notification.permission !== 'granted') {
      if (enabled) storeAlertsEnabled(false);
      return false;
    }
    return enabled;
  } catch {
    return false;
  }
}

function storeAlertsEnabled(enabled: boolean): boolean {
  if (typeof window === 'undefined') return false;
  try {
    window.localStorage.setItem(ALERTS_ENABLED_KEY, String(enabled));
    return true;
  } catch {
    return false;
  }
}

export async function enableBrowserAlerts(): Promise<{ enabled: boolean; message: string }> {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    storeAlertsEnabled(false);
    return { enabled: false, message: 'This browser does not support desktop notifications.' };
  }
  if (!('serviceWorker' in navigator)) {
    storeAlertsEnabled(false);
    return { enabled: false, message: 'This browser does not support service workers.' };
  }

  try {
    const permission = Notification.permission === 'granted'
      ? 'granted'
      : await Notification.requestPermission();
    if (permission !== 'granted') {
      storeAlertsEnabled(false);
      return {
        enabled: false,
        message: permission === 'denied'
          ? 'Notifications are blocked in browser settings.'
          : 'Notification permission was not granted.',
      };
    }

    await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    if (!storeAlertsEnabled(true)) {
      return { enabled: false, message: 'Browser storage is unavailable; alerts could not be enabled.' };
    }
    return { enabled: true, message: 'Browser trade alerts enabled.' };
  } catch (error) {
    storeAlertsEnabled(false);
    return {
      enabled: false,
      message: error instanceof Error ? error.message : 'Unable to enable browser notifications.',
    };
  }
}

export function disableBrowserAlerts(): boolean {
  return storeAlertsEnabled(false);
}

function formatPrice(value: number): string {
  if (!Number.isFinite(value)) throw new Error('Trade notification has an invalid price.');
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 8 })}`;
}

function formatSignedUsd(value: number): string {
  if (!Number.isFinite(value)) throw new Error('Trade notification has invalid P&L.');
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  return `${sign}$${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

async function showBrowserNotification(title: string, body: string, tag: string): Promise<void> {
  if (!areBrowserAlertsEnabled()) return;
  await navigator.serviceWorker.ready;
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) throw new Error('Browser notification service worker is not registered.');
  const notificationIcon = '/icons/auraalgo-192.png';
  await registration.showNotification(title, {
    body,
    icon: notificationIcon,
    badge: notificationIcon,
    tag,
    data: { url: '/' },
  });
}

export async function notifyTradeOpened(trade: BackendTrade): Promise<void> {
  await showBrowserNotification(
    '🚀 AuraAlgo: New Position Opened',
    `${trade.symbol} ${trade.side} @ ${formatPrice(trade.entryPrice)} | SL: ${formatPrice(trade.stopLoss)} | Target: ${formatPrice(trade.takeProfit)}`,
    `trade-open-${trade._id}`,
  );
}

function exitReason(reason: BackendTrade['closeReason']): string {
  switch (reason) {
    case 'TAKE_PROFIT': return 'TP_HIT';
    case 'STOP_LOSS': return 'SL_HIT';
    case 'EARLY_MOMENTUM_REVERSAL': return 'EARLY_MOMENTUM_REVERSAL';
    case 'MANUAL': return 'EMERGENCY';
    default: throw new Error('Closed trade notification is missing its exit reason.');
  }
}

export async function notifyTradeClosed(trade: BackendTrade): Promise<void> {
  if (trade.exitPrice === null || !Number.isFinite(trade.pnlPercent)) {
    throw new Error('Closed trade notification is missing real exit or P&L data.');
  }
  await showBrowserNotification(
    `🎯 AuraAlgo: Trade Closed (${exitReason(trade.closeReason)})`,
    `${trade.symbol} Exit @ ${formatPrice(trade.exitPrice)} | Net P&L: ${formatSignedUsd(trade.pnlUsd)} (${trade.pnlPercent.toFixed(2)}%)`,
    `trade-close-${trade._id}`,
  );
}

export async function notifyTradeCooldown(trade: BackendTrade): Promise<void> {
  const start = trade.closedAt ? Date.parse(trade.closedAt) : Number.NaN;
  const end = trade.cooldownUntil ? Date.parse(trade.cooldownUntil) : Number.NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new Error('Cooldown notification is missing valid cooldown timing data.');
  }
  const durationMinutes = Math.round((end - start) / 60_000);
  await showBrowserNotification(
    '⚠️ AuraAlgo: Symbol Cooldown',
    `${trade.symbol} hit SL. Cooldown active for ${durationMinutes}m to prevent revenge trade.`,
    `trade-cooldown-${trade._id}`,
  );
}
