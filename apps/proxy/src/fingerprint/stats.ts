import { avg } from "../utils.js";

/** 线性核 MMD² 的简易有偏估计（样本很小时仅作相对指标，非严格 p 值） */
export function linearKernelMmd2Squared(samplesX: number[][], samplesY: number[][]): number {
  if (samplesX.length === 0 || samplesY.length === 0) {
    return 0;
  }

  const dot = (a: number[], b: number[]): number => {
    let sum = 0;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i += 1) {
      sum += (a[i] ?? 0) * (b[i] ?? 0);
    }
    return sum;
  };

  const meanKernel = (a: number[][], b: number[][]): number => {
    if (a.length === 0 || b.length === 0) {
      return 0;
    }

    let total = 0;
    for (const rowA of a) {
      for (const rowB of b) {
        total += dot(rowA, rowB);
      }
    }

    return total / (a.length * b.length);
  };

  const kxx = meanKernel(samplesX, samplesX);
  const kyy = meanKernel(samplesY, samplesY);
  const kxy = meanKernel(samplesX, samplesY);
  return Math.max(0, kxx + kyy - 2 * kxy);
}

export function meanVector(rows: number[][]): number[] {
  if (rows.length === 0) {
    return [];
  }

  const dim = rows[0]?.length ?? 0;
  const acc = new Array(dim).fill(0);
  for (const row of rows) {
    for (let i = 0; i < dim; i += 1) {
      acc[i] += row[i] ?? 0;
    }
  }

  return acc.map((value) => value / rows.length);
}

export function euclidean(a: number[], b: number[]): number {
  let sum = 0;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    sum += d * d;
  }

  return Math.sqrt(sum);
}

/** 双尾秩和检验的正态近似 z（样本较小时仅作启发式） */
export function mannWhitneyZApprox(a: number[], b: number[]): number | null {
  if (a.length < 3 || b.length < 3) {
    return null;
  }

  const ranked = [...a.map((value) => ({ value, group: 0 as const })), ...b.map((value) => ({ value, group: 1 as const }))].sort(
    (left, right) => left.value - right.value
  );

  const n1 = a.length;
  const n2 = b.length;
  let rank = 1;
  let wa = 0;

  for (let i = 0; i < ranked.length; ) {
    let j = i;
    while (j < ranked.length && ranked[j]!.value === ranked[i]!.value) {
      j += 1;
    }

    const meanRank = (rank + (rank + (j - i) - 1)) / 2;
    for (let k = i; k < j; k += 1) {
      if (ranked[k]!.group === 0) {
        wa += meanRank;
      }
    }

    rank += j - i;
    i = j;
  }

  const u1 = wa - (n1 * (n1 + 1)) / 2;
  const meanU = (n1 * n2) / 2;
  const stdU = Math.sqrt((n1 * n2 * (n1 + n2 + 1)) / 12);
  if (stdU === 0) {
    return null;
  }

  const z = (u1 - meanU) / stdU;
  return z;
}

export function coefficientOfVariation(values: number[]): number | null {
  if (values.length < 4) {
    return null;
  }

  const mean = avg(values);
  if (mean === 0) {
    return null;
  }

  const variance = avg(values.map((value) => (value - mean) ** 2));
  return Math.sqrt(variance) / Math.abs(mean);
}
