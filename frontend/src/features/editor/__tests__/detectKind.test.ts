import { describe, it, expect } from 'vitest';
import { detectKind } from '../detectKind';

describe('detectKind', () => {
  it('detects chapter.md as a chapter', () => {
    expect(detectKind('chapters/01_Chapter_01/chapter.md')).toBe('chapter');
  });

  it('detects a scene file within a chapter directory as a scene', () => {
    expect(detectKind('chapters/01_Chapter_01/01.md')).toBe('scene');
  });

  it('detects a category entry as a reference', () => {
    expect(detectKind('characters/asha.md')).toBe('reference');
  });

  it('detects a references category entry as a reference', () => {
    expect(detectKind('references/some-place.md')).toBe('reference');
  });

  it('treats interlude chapter.md the same as chapter.md', () => {
    expect(detectKind('chapters/05_Interlude_01/chapter.md')).toBe('chapter');
  });

  it('falls back to reference for paths without a chapters/ prefix', () => {
    expect(detectKind('project.yml')).toBe('reference');
  });
});
