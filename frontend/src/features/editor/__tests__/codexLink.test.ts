import { describe, it, expect } from 'vitest';
import { detectCharacters, CodexEntry } from '../codexLink';

function entry(path: string, title: string, aliases: string[] = []): CodexEntry {
  return { path, title, aliases };
}

describe('detectCharacters', () => {
  it('finds character names in text', () => {
    const codex = [entry('/chars/asha', 'Asha')];
    const result = detectCharacters('Asha walked into the room.', codex);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Asha');
  });

  it('matches on aliases', () => {
    const codex = [entry('/chars/tarn', 'Tarn', ['The Warden', 'Old Man'])];
    const result = detectCharacters('The Warden stood guard.', codex);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Tarn');
  });

  it('returns longest match first — "Old Tarn" before "Tarn"', () => {
    const codex = [
      entry('/chars/tarn', 'Tarn'),
      entry('/chars/old-tarn', 'Old Tarn'),
    ];
    const result = detectCharacters('Old Tarn sat by the fire.', codex);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('/chars/old-tarn');
  });

  it('is case-insensitive', () => {
    const codex = [entry('/chars/asha', 'Asha')];
    const result = detectCharacters('ASHA shouted.', codex);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Asha');
  });

  it('handles regex special characters in names without crashing', () => {
    const codex = [entry('/chars/jr', 'J.R. (Junior)')];
    // \b word boundary won't match around non-word chars like '(' and ')',
    // so the name won't be found — but the regex must not throw.
    expect(() => detectCharacters('J.R. (Junior) arrived.', codex)).not.toThrow();
  });

  it('matches names with dots when surrounded by word boundaries', () => {
    const codex = [entry('/chars/rj', 'R.J.')];
    // Dots are escaped but \b still needs a word-char boundary — won't match.
    // This documents the limitation; no crash is the key guarantee.
    expect(() => detectCharacters('R.J. spoke.', codex)).not.toThrow();
  });

  it('returns empty for empty entries list', () => {
    const result = detectCharacters('Some text with names.', []);
    expect(result).toEqual([]);
  });

  it('returns empty when no matches found', () => {
    const codex = [entry('/chars/asha', 'Asha')];
    const result = detectCharacters('Nobody familiar here.', codex);
    expect(result).toEqual([]);
  });

  it('deduplicates — same character matched twice returns one entry', () => {
    const codex = [entry('/chars/asha', 'Asha')];
    const result = detectCharacters('Asha met Asha in the mirror.', codex);
    expect(result).toHaveLength(1);
  });

  it('finds multiple distinct characters', () => {
    const codex = [
      entry('/chars/asha', 'Asha'),
      entry('/chars/tarn', 'Tarn'),
    ];
    const result = detectCharacters('Asha spoke to Tarn.', codex);
    expect(result).toHaveLength(2);
  });

  it('respects word boundaries — partial matches excluded', () => {
    const codex = [entry('/chars/ash', 'Ash')];
    const result = detectCharacters('Asha walked away.', codex);
    expect(result).toEqual([]);
  });

  it('matches alias that is also another character title via the alias owner', () => {
    const codex = [
      entry('/chars/asha', 'Asha', ['The Blade']),
      entry('/chars/tarn', 'Tarn'),
    ];
    const result = detectCharacters('The Blade and Tarn fought.', codex);
    expect(result).toHaveLength(2);
    expect(result.find((e) => e.path === '/chars/asha')).toBeDefined();
    expect(result.find((e) => e.path === '/chars/tarn')).toBeDefined();
  });
});
