/**
 * Returns a value randomized within ±variancePercent of the base value.
 * E.g., randomize(100, 20) returns a value between 80 and 120.
 */
export function randomize(base: number, variancePercent: number): number {
  const factor = 1 + (Math.random() * 2 - 1) * (variancePercent / 100);
  return base * factor;
}

/**
 * Returns a random integer between min (inclusive) and max (inclusive).
 */
export function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Picks a random element from an array.
 */
export function randomPick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Shuffles an array in place (Fisher-Yates).
 */
export function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Sleep for a given number of milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sample from a normal distribution using the Box-Muller transform.
 * Returns a single value with the given mean and standard deviation.
 *
 * Used by delta-neutral for trade-size variation.
 */
export function gaussian(mean: number, stddev: number): number {
  // Avoid log(0) — Math.random() is [0,1), so u1 can be 0 in theory.
  let u1 = Math.random();
  while (u1 === 0) u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + stddev * z;
}

/**
 * Sample from an exponential distribution with the given mean.
 * Used by delta-neutral for inter-trade interval timing (Poisson arrivals).
 */
export function exponential(mean: number): number {
  let u = Math.random();
  while (u === 0) u = Math.random();
  return -mean * Math.log(u);
}
