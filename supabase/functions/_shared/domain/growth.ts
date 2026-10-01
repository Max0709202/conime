// Growth helpers. The authoritative calculation is in PostgreSQL (app.apply_exp and
// app.level_rules); these pure functions mirror level-v1 for the seed generator and
// are cross-checked against the database by tests/integration/golden_growth_test.ts.

export const MAX_LEVEL = 100;
export const EVOLUTION_INTERVAL = 5;

/** level-v1: cumulative EXP needed to reach level L. */
export function cumulativeExpForLevel(level: number): number {
  const n = Math.max(1, Math.min(MAX_LEVEL, level)) - 1;
  return 50 * n + 5 * n * n;
}

export function levelForExp(exp: number): number {
  let level = 1;
  while (level < MAX_LEVEL && cumulativeExpForLevel(level + 1) <= exp) level++;
  return level;
}

/** Image stage for a level: 1 below the first boundary, otherwise the last multiple of the interval. */
export function stageForLevel(level: number, interval = EVOLUTION_INTERVAL): number {
  const s = Math.floor(level / interval) * interval;
  return s >= interval ? s : 1;
}

/** The final evolution stage crossed when moving from oldLevel to newLevel, or null (G-04). */
export function crossedEvolutionStage(oldLevel: number, newLevel: number, interval = EVOLUTION_INTERVAL): number | null {
  const oldStage = Math.floor(oldLevel / interval) * interval;
  const newStage = Math.floor(newLevel / interval) * interval;
  return newStage > oldStage && newStage >= interval ? newStage : null;
}
