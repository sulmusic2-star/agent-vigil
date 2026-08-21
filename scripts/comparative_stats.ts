export type Interval = { low: number; high: number };

export function wilsonInterval(successes: number, trials: number, z = 1.959963984540054): Interval {
  if (!Number.isInteger(successes) || !Number.isInteger(trials) || successes < 0 || trials < 0 || successes > trials) {
    throw new Error("successes and trials must be non-negative integers with successes <= trials");
  }
  if (trials === 0) return { low: 0, high: 1 };
  const p = successes / trials;
  const z2 = z * z;
  const denominator = 1 + z2 / trials;
  const center = (p + z2 / (2 * trials)) / denominator;
  const half = z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials)) / denominator;
  return { low: Math.max(0, center - half), high: Math.min(1, center + half) };
}

function binomialProbability(k: number, n: number): number {
  if (k < 0 || k > n) return 0;
  // Stable recurrence from P(X=0) for X ~ Binomial(n, 0.5).
  let probability = 2 ** -n;
  for (let index = 0; index < k; index += 1) probability *= (n - index) / (index + 1);
  return probability;
}

export function mcnemarExact(agentOnly: number, comparatorOnly: number): number {
  if (!Number.isInteger(agentOnly) || !Number.isInteger(comparatorOnly) || agentOnly < 0 || comparatorOnly < 0) {
    throw new Error("discordant counts must be non-negative integers");
  }
  const discordant = agentOnly + comparatorOnly;
  if (discordant === 0) return 1;
  const tail = Math.min(agentOnly, comparatorOnly);
  let cdf = 0;
  for (let k = 0; k <= tail; k += 1) cdf += binomialProbability(k, discordant);
  return Math.min(1, 2 * cdf);
}

export function holmAdjust(pValues: number[]): number[] {
  const indexed = pValues.map((p, index) => ({ p, index })).sort((a, b) => a.p - b.p);
  const adjusted = new Array<number>(pValues.length);
  let running = 0;
  for (let rank = 0; rank < indexed.length; rank += 1) {
    const candidate = Math.min(1, indexed[rank].p * (indexed.length - rank));
    running = Math.max(running, candidate);
    adjusted[indexed[rank].index] = running;
  }
  return adjusted;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

export function pairedBootstrapMeanDifference(
  left: number[],
  right: number[],
  options: { resamples?: number; seed?: number } = {},
): { estimate: number; low: number; high: number; resamples: number; seed: number } {
  if (left.length !== right.length || left.length === 0) throw new Error("paired arrays must have the same non-zero length");
  const resamples = options.resamples ?? 10_000;
  const seed = options.seed ?? 20260821;
  if (!Number.isInteger(resamples) || resamples < 100) throw new Error("resamples must be an integer >= 100");
  const differences = left.map((value, index) => value - right[index]);
  const estimate = differences.reduce((sum, value) => sum + value, 0) / differences.length;
  const random = seededRandom(seed);
  const samples = new Array<number>(resamples);
  for (let draw = 0; draw < resamples; draw += 1) {
    let sum = 0;
    for (let index = 0; index < differences.length; index += 1) {
      sum += differences[Math.floor(random() * differences.length)];
    }
    samples[draw] = sum / differences.length;
  }
  samples.sort((a, b) => a - b);
  const quantile = (p: number): number => samples[Math.min(samples.length - 1, Math.max(0, Math.floor(p * samples.length)))];
  return { estimate, low: quantile(0.025), high: quantile(0.975), resamples, seed };
}
