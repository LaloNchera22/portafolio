export function validatePayCents(value: unknown, enforceMax = true): number | null {
  const payCents = Math.trunc(Number(value));
  if (!Number.isFinite(payCents) || payCents < 100) {
    return null;
  }
  if (enforceMax && payCents > 200000) {
    return null;
  }
  return payCents;
}

export function calculateRcoin(payCents: number): number {
  return Math.floor((payCents * 95) / 100 / 100);
}
