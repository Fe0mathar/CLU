export interface NumericNormalizationProfile {
  readonly kind: 'numeric';
  readonly direction: 'higher_is_better' | 'lower_is_better';
  readonly grayArea: number;
  readonly meaningful: number;
  readonly exceptional: number;
}

export interface CategoricalNormalizationProfile {
  readonly kind: 'categorical';
  readonly values: Readonly<Record<string, number>>;
}

export type NormalizationProfile = NumericNormalizationProfile | CategoricalNormalizationProfile;

export function clampNormalized(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-100, Math.min(100, value));
}

export function normalizeNumericDelta(delta: number, profile: NumericNormalizationProfile): number {
  const directed = profile.direction === 'higher_is_better' ? delta : -delta;
  const magnitude = Math.abs(directed);
  if (magnitude <= profile.grayArea) return 0;
  if (magnitude >= profile.exceptional) return Math.sign(directed) * 100;

  if (magnitude >= profile.meaningful) {
    const denominator = Math.max(profile.exceptional - profile.meaningful, Number.EPSILON);
    const position = (magnitude - profile.meaningful) / denominator;
    return clampNormalized(Math.sign(directed) * (60 + position * 40));
  }

  const denominator = Math.max(profile.meaningful - profile.grayArea, Number.EPSILON);
  const position = (magnitude - profile.grayArea) / denominator;
  return clampNormalized(Math.sign(directed) * position * 60);
}

export function normalizeCategorical(value: string, profile: CategoricalNormalizationProfile): number | null {
  const mapped = profile.values[value];
  return mapped === undefined ? null : clampNormalized(mapped);
}

export function evidenceAdjustedContribution(input: {
  readonly magnitude: number;
  readonly confidence: number;
  readonly freshness: number;
  readonly coverage: number;
}): number {
  return clampNormalized(
    input.magnitude
      * Math.max(0, Math.min(1, input.confidence))
      * Math.max(0, Math.min(1, input.freshness))
      * Math.max(0, Math.min(1, input.coverage)),
  );
}
