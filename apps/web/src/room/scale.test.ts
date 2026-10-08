import { describe, expect, it } from 'vitest';
import { stageScale } from './scale';

describe('stageScale', () => {
  it('fills the area instead of rounding down to a whole number', () => {
    // A laptop window: the old whole-number rule left this at 1×.
    expect(stageScale(727, 402, 1)).toBeCloseTo(402 / 270, 5);
  });

  it('keeps the aspect ratio by fitting the tighter side', () => {
    expect(stageScale(1920, 400, 1)).toBeCloseTo(400 / 270, 5);
    expect(stageScale(600, 1000, 1)).toBeCloseTo(600 / 480, 5);
  });

  it('snaps to whole device pixels when that costs under 3%', () => {
    // fit 2.02 at 1× density → 2 (1% smaller, every art pixel exactly 2 px).
    expect(stageScale(970, 1000, 1)).toBe(2);
    // On a 2× screen 1.49 would snap all the way down to 1, so it fills; 1.51 snaps to 1.5.
    expect(stageScale(480 * 1.49, 1000, 2)).toBeCloseTo(1.49, 5);
    expect(stageScale(480 * 1.51, 1000, 2)).toBe(1.5);
  });

  it('shrinks below native size on small screens, with a floor', () => {
    expect(stageScale(240, 1000, 1)).toBeCloseTo(0.5, 5);
    expect(stageScale(50, 1000, 1)).toBe(0.25);
  });

  it('uses the width alone before the area has a height', () => {
    expect(stageScale(960, 0, 1)).toBe(2);
  });
});
