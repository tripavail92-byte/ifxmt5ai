export type StructureBar = {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v?: number;
};

export type StructureAnalysis = {
  candleTime: number;
  closePrice: number;
  pivotWindow: number;
  swingHighTime: number | null;
  swingHigh: number | null;
  swingLowTime: number | null;
  swingLow: number | null;
  breakUp: boolean;
  breakDn: boolean;
};

function isPivotHigh(bars: StructureBar[], idx: number, window: number) {
  const h = bars[idx]?.h;
  if (typeof h !== "number") return false;
  for (let j = idx - window; j <= idx + window; j += 1) {
    if (j === idx) continue;
    if ((bars[j]?.h ?? Number.NEGATIVE_INFINITY) >= h) return false;
  }
  return true;
}

function isPivotLow(bars: StructureBar[], idx: number, window: number) {
  const l = bars[idx]?.l;
  if (typeof l !== "number") return false;
  for (let j = idx - window; j <= idx + window; j += 1) {
    if (j === idx) continue;
    if ((bars[j]?.l ?? Number.POSITIVE_INFINITY) <= l) return false;
  }
  return true;
}

function latestConfirmedSwingLevels(bars: StructureBar[], window: number) {
  if (window < 1) window = 1;
  if (bars.length < 2 * window + 3) {
    return { swingHigh: null as { time: number; price: number } | null, swingLow: null as { time: number; price: number } | null };
  }

  const startIdx = window;
  const lastIdx = bars.length - 1 - window;
  let swingHigh: { time: number; price: number } | null = null;
  let swingLow: { time: number; price: number } | null = null;

  for (let i = startIdx; i <= lastIdx; i += 1) {
    if (isPivotHigh(bars, i, window)) {
      swingHigh = { time: bars[i].t, price: bars[i].h };
    }
    if (isPivotLow(bars, i, window)) {
      swingLow = { time: bars[i].t, price: bars[i].l };
    }
  }

  return { swingHigh, swingLow };
}

export function analyzeStructure(bars: StructureBar[], pivotWindow = 2): StructureAnalysis | null {
  if (!bars.length) return null;
  const window = Math.max(1, Math.floor(pivotWindow || 1));
  const ordered = [...bars].sort((a, b) => a.t - b.t);
  const last = ordered[ordered.length - 1];
  const { swingHigh, swingLow } = latestConfirmedSwingLevels(ordered, window);

  return {
    candleTime: last.t,
    closePrice: last.c,
    pivotWindow: window,
    swingHighTime: swingHigh?.time ?? null,
    swingHigh: swingHigh?.price ?? null,
    swingLowTime: swingLow?.time ?? null,
    swingLow: swingLow?.price ?? null,
    breakUp: swingHigh ? last.c > swingHigh.price : false,
    breakDn: swingLow ? last.c < swingLow.price : false,
  };
}

export function pivotWindowFromAiSensitivity(aiSensitivity: number) {
  const rounded = Number.isFinite(aiSensitivity) ? Math.round(aiSensitivity) : 5;
  return Math.min(10, Math.max(1, rounded));
}

export function deriveDynamicStop(params: {
  bars: StructureBar[];
  side: "buy" | "sell";
  aiSensitivity: number;
  priceIncrement: number;
}) {
  const pivotWindow = pivotWindowFromAiSensitivity(params.aiSensitivity);
  const analysis = analyzeStructure(params.bars, pivotWindow);
  if (!analysis) {
    return { analysis: null, stop: null as number | null, referenceLevel: null as number | null };
  }

  const buffer = Math.max(params.priceIncrement, 0);
  if (params.side === "buy") {
    if (analysis.swingLow == null) {
      return { analysis, stop: null as number | null, referenceLevel: null as number | null };
    }
    return {
      analysis,
      referenceLevel: analysis.swingLow,
      stop: analysis.swingLow - buffer,
    };
  }

  if (analysis.swingHigh == null) {
    return { analysis, stop: null as number | null, referenceLevel: null as number | null };
  }
  return {
    analysis,
    referenceLevel: analysis.swingHigh,
    stop: analysis.swingHigh + buffer,
  };
}
