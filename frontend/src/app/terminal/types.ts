export type StopMode = "setup" | "manual" | "ai_dynamic";

export type MT5Position = {
  ticket: number;
  symbol: string;
  type: "buy" | "sell";
  volume: number;
  open_price: number;
  current_price: number;
  sl: number | null;
  tp: number | null;
  profit: number;
  swap: number;
  open_time: number; // unix timestamp
  comment: string;
};

export type TerminalPreferences = {
  riskMode: "percent" | "usd";
  riskPercent: number;
  riskUsd: number;
  maxTradesPerDay: number;
  riskRewardRatio: number;
  // Account-level guardrails — 0 means disabled
  dailyLossLimitUsd: number;
  dailyProfitTargetUsd: number;
  maxPositionSizeLots: number;
  maxDrawdownPercent: number;
  newsFilter: boolean;
  newsBeforeMin: number;
  newsAfterMin: number;
  sessions: {
    london: boolean;
    newYork: boolean;
    asia: boolean;
  };
  showEntryZones: boolean;
  showTPZones: boolean;
  stopMode: StopMode;
  // EA execution settings
  slPadMult: number;
  minConfidence: number;
  exitOnFlip: boolean;
  useDeadSl: boolean;
  slCooldownMin: number;
  // Discord notification flags
  enableDiscord: boolean;
  notifyOnSL: boolean;
  notifyOnTP: boolean;
  notifyDaily: boolean;
  // EA Structure timeframes
  engineTf: string;
  bossTimeframe: string;
  slTimeframe: string;
  beTimeframe: string;
  // Session times
  londonStart: string;
  londonEnd: string;
  nyStart: string;
  nyEnd: string;
  asiaStart: string;
  asiaEnd: string;
  // Trade execution
  baseMagic: number;
  tp1Pct: number;
  usePartial: boolean;
  useBE: boolean;
  breakEvenAfterTp1: boolean;
  closeEod: boolean;
  eodTime: string;
  // Discord
  discordWebhookUrl: string;
  // EA Visuals (SMC structure lines on chart)
  showStruct: boolean;
  smcLookback: number;
};

export type PersistedTerminalSettings = {
  preferences?: Partial<TerminalPreferences> | null;
  termsVersion?: string | null;
  termsAcceptedAt?: string | null;
};
