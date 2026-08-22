import { describe, it, expect } from 'vitest';
import { countWords } from '../words';

describe('countWords', () => {
  it('counts words in normal text', () => {
    expect(countWords('The quick brown fox')).toBe(4);
  });

  it('returns 0 for an empty string', () => {
    expect(countWords('')).toBe(0);
  });

  it('returns 0 for whitespace-only text', () => {
    expect(countWords('   \n\t  ')).toBe(0);
  });

  it('collapses runs of whitespace between words', () => {
    expect(countWords('one   two\nthree')).toBe(3);
  });

  it('trims leading and trailing whitespace before counting', () => {
    expect(countWords('  hello world  ')).toBe(2);
  });

  it('counts a single word', () => {
    expect(countWords('word')).toBe(1);
  });
});
