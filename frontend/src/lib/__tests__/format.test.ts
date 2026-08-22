import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { relativeTime } from '../format';

describe('relativeTime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns "just now" for a timestamp seconds ago', () => {
    expect(relativeTime(Date.now() - 30 * 1000)).toBe('just now');
  });

  it('returns "just now" right at the 59s boundary', () => {
    expect(relativeTime(Date.now() - 59 * 1000)).toBe('just now');
  });

  it('returns minutes ago once past 60s', () => {
    expect(relativeTime(Date.now() - 60 * 1000)).toBe('1m ago');
    expect(relativeTime(Date.now() - 5 * 60 * 1000)).toBe('5m ago');
  });

  it('returns hours ago once past an hour', () => {
    expect(relativeTime(Date.now() - 3 * 3600 * 1000)).toBe('3h ago');
  });

  it('returns days ago once past a day', () => {
    expect(relativeTime(Date.now() - 2 * 86400 * 1000)).toBe('2d ago');
  });

  it('handles a timestamp in the future without crashing', () => {
    expect(relativeTime(Date.now() + 1000)).toBe('just now');
  });
});
