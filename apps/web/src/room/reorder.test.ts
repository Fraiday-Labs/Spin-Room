import { describe, expect, it } from 'vitest';
import { dropIndex, moveItem } from './reorder';

describe('moveItem', () => {
  it('moves down and up without touching the input', () => {
    const xs = ['a', 'b', 'c', 'd'];
    expect(moveItem(xs, 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveItem(xs, 3, 1)).toEqual(['a', 'd', 'b', 'c']);
    expect(moveItem(xs, 1, 1)).toEqual(xs);
    expect(xs).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('dropIndex', () => {
  // Four 40 px rows: middles at 20, 60, 100, 140.
  const mids = [20, 60, 100, 140];

  it('stays put until the pointer passes a neighbour’s middle', () => {
    expect(dropIndex(mids, 1, 50)).toBe(1);
    expect(dropIndex(mids, 1, 70)).toBe(1);
    expect(dropIndex(mids, 1, 101)).toBe(2);
    expect(dropIndex(mids, 1, 19)).toBe(0);
  });

  it('clamps to the ends of the list', () => {
    expect(dropIndex(mids, 0, 999)).toBe(3);
    expect(dropIndex(mids, 3, -50)).toBe(0);
  });
});
