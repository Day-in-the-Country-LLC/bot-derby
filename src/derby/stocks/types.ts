/** Private market evidence. Never return raw stock quotes, bars or share counts publicly. */
export interface StockQuote {
  symbol: string; bid: number; ask: number; last: number; ts: number; spreadBps: number;
}
export interface StockSignal {
  symbol: string; score: number; slicesAvailable: number; barCount: number;
  atrPct: number; volatilityPct: number; return1dPct: number; return5dPct: number;
  completedThrough: number; previousClose: number;
  /** Raw / split-adjusted close for the identical latest completed bar; non-1 signals an intervening split. */
  splitAdjustmentFactor?: number;
}
export interface StockSession {
  isOpen: boolean; checkedAt: number; nextOpen: number; nextClose: number;
  tradingDate: string;
}
export interface StockMarket {
  ts: number; session: StockSession;
  quotes: Record<string, StockQuote>; signals: Record<string, StockSignal>;
  ready: boolean; error: string | null;
}
export interface StockFeedLike {
  refresh(): Promise<StockMarket>;
  view(): StockMarket;
}
export interface StockRules {
  version: number; season: string; strategy: string; coins: string[];
  startEquityUsd: number; tickMs: number; askEveryCycle: boolean;
  assetClass: "stocks"; feed: "Alpaca IEX"; candleTimeframe: "1Day";
  risk: {
    maxLeverage: number; maxExposurePct: number; dailyLossStopPct: number;
    retireDrawdownPct: number; maxEntriesPerSession: number; entryCooldownMs: number;
    spreadGateBps: number; maxQuoteAgeMs: number; feeRate: number; slippageBps: number;
    stopAtrMult: number; minActionProbability: number; minConviction: number;
  };
}
