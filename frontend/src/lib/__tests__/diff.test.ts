import { describe, it, expect } from 'vitest';
import {
  diffWords,
  diffStats,
  buildMergeZones,
  buildThreeWayZones,
  assembleThreeWayBody,
  threeWayFmDiffKeys,
  mergeThreeWayFrontmatter,
  ThreeWaySource,
  ThreeWayZone,
  DiffSeg,
} from '../diff';

describe('diffWords', () => {
  it('returns all eq segments for identical strings', () => {
    const segs = diffWords('hello world', 'hello world');
    expect(segs.every((s) => s.type === 'eq')).toBe(true);
    expect(segs.map((s) => s.text).join('')).toBe('hello world');
  });

  it('returns del + add for completely different strings', () => {
    const segs = diffWords('foo', 'bar');
    const types = segs.map((s) => s.type);
    expect(types).toContain('del');
    expect(types).toContain('add');
    expect(segs.find((s) => s.type === 'del')!.text).toBe('foo');
    expect(segs.find((s) => s.type === 'add')!.text).toBe('bar');
  });

  it('detects word-level changes mid-sentence', () => {
    const segs = diffWords('the quick brown fox', 'the slow brown fox');
    const types = segs.map((s) => s.type);
    expect(types).toContain('del');
    expect(types).toContain('add');
    const del = segs.find((s) => s.type === 'del')!;
    const add = segs.find((s) => s.type === 'add')!;
    expect(del.text).toContain('quick');
    expect(add.text).toContain('slow');
  });

  it('handles empty first input', () => {
    const segs = diffWords('', 'hello');
    expect(segs).toEqual([{ type: 'add', text: 'hello' }]);
  });

  it('handles empty second input', () => {
    const segs = diffWords('hello', '');
    expect(segs).toEqual([{ type: 'del', text: 'hello' }]);
  });

  it('handles both inputs empty', () => {
    const segs = diffWords('', '');
    expect(segs).toEqual([]);
  });

  it('preserves whitespace as separate tokens', () => {
    const segs = diffWords('a  b', 'a  b');
    const joined = segs.map((s) => s.text).join('');
    expect(joined).toBe('a  b');
  });

  it('merges consecutive same-type segments', () => {
    const segs = diffWords('aaa bbb', 'ccc ddd');
    // All original words become del, all new become add, but whitespace
    // tokens interleave — pushSeg only merges truly adjacent same-type.
    // Verify the reconstructed text is correct regardless of segment count.
    const delText = segs.filter((s) => s.type === 'del').map((s) => s.text).join('');
    const addText = segs.filter((s) => s.type === 'add').map((s) => s.text).join('');
    expect(delText).toContain('aaa');
    expect(delText).toContain('bbb');
    expect(addText).toContain('ccc');
    expect(addText).toContain('ddd');
  });

  it('handles additions at the end', () => {
    const segs = diffWords('hello', 'hello world');
    const addSeg = segs.find((s) => s.type === 'add');
    expect(addSeg).toBeDefined();
    expect(addSeg!.text).toContain('world');
  });

  it('handles deletions at the start', () => {
    const segs = diffWords('extra hello', 'hello');
    const delSeg = segs.find((s) => s.type === 'del');
    expect(delSeg).toBeDefined();
    expect(delSeg!.text).toContain('extra');
  });
});

describe('diffStats', () => {
  it('counts added and removed words', () => {
    const segs: DiffSeg[] = [
      { type: 'eq', text: 'the ' },
      { type: 'del', text: 'quick brown' },
      { type: 'add', text: 'slow' },
      { type: 'eq', text: ' fox' },
    ];
    const stats = diffStats(segs);
    expect(stats.added).toBe(1);
    expect(stats.removed).toBe(2);
  });

  it('returns zeros for all-eq segments', () => {
    const segs: DiffSeg[] = [{ type: 'eq', text: 'nothing changed' }];
    const stats = diffStats(segs);
    expect(stats.added).toBe(0);
    expect(stats.removed).toBe(0);
  });

  it('skips whitespace-only segments in counts', () => {
    const segs: DiffSeg[] = [
      { type: 'add', text: '   ' },
      { type: 'del', text: '\n' },
    ];
    const stats = diffStats(segs);
    expect(stats.added).toBe(0);
    expect(stats.removed).toBe(0);
  });

  it('handles empty segment list', () => {
    const stats = diffStats([]);
    expect(stats.added).toBe(0);
    expect(stats.removed).toBe(0);
  });
});

describe('buildMergeZones', () => {
  it('groups contiguous changes into a single zone', () => {
    const segs: DiffSeg[] = [
      { type: 'eq', text: 'start ' },
      { type: 'del', text: 'old' },
      { type: 'add', text: 'new' },
      { type: 'eq', text: ' end' },
    ];
    const zones = buildMergeZones(segs);
    expect(zones).toHaveLength(3);
    expect(zones[0]).toEqual({ type: 'equal', text: 'start ', serverText: '', conflictText: '' });
    expect(zones[1]).toEqual({ type: 'change', text: '', serverText: 'old', conflictText: 'new' });
    expect(zones[2]).toEqual({ type: 'equal', text: ' end', serverText: '', conflictText: '' });
  });

  it('handles pure additions (server text empty)', () => {
    const segs: DiffSeg[] = [
      { type: 'eq', text: 'before ' },
      { type: 'add', text: 'inserted' },
      { type: 'eq', text: ' after' },
    ];
    const zones = buildMergeZones(segs);
    expect(zones[1]).toEqual({ type: 'change', text: '', serverText: '', conflictText: 'inserted' });
  });

  it('handles pure deletions (conflict text empty)', () => {
    const segs: DiffSeg[] = [
      { type: 'del', text: 'removed' },
      { type: 'eq', text: ' kept' },
    ];
    const zones = buildMergeZones(segs);
    expect(zones[0]).toEqual({ type: 'change', text: '', serverText: 'removed', conflictText: '' });
  });

  it('returns empty array for empty input', () => {
    expect(buildMergeZones([])).toEqual([]);
  });

  it('merges multiple del/add in one run into one zone', () => {
    const segs: DiffSeg[] = [
      { type: 'del', text: 'a ' },
      { type: 'del', text: 'b' },
      { type: 'add', text: 'x ' },
      { type: 'add', text: 'y' },
    ];
    const zones = buildMergeZones(segs);
    expect(zones).toHaveLength(1);
    expect(zones[0].serverText).toBe('a b');
    expect(zones[0].conflictText).toBe('x y');
  });
});

// Assemble each source by picking that source for every change zone.
function pickAll(zones: ThreeWayZone[], src: ThreeWaySource): string {
  const picks: Record<number, ThreeWaySource> = {};
  zones.forEach((z, i) => {
    if (z.type === 'change') picks[i] = src;
  });
  return assembleThreeWayBody(zones, picks);
}

// Property: the three round-trips must hold for any S/C/E triple.
function expectRoundTrips(server: string, conflict: string, editor: string) {
  const zones = buildThreeWayZones(server, conflict, editor);
  expect(assembleThreeWayBody(zones, {})).toBe(server);
  expect(pickAll(zones, 'server')).toBe(server);
  expect(pickAll(zones, 'conflict')).toBe(conflict);
  expect(pickAll(zones, 'editor')).toBe(editor);
  return zones;
}

describe('buildThreeWayZones', () => {
  it('returns a single equal zone when all three are identical', () => {
    const zones = buildThreeWayZones('the quick fox', 'the quick fox', 'the quick fox');
    expect(zones).toHaveLength(1);
    expect(zones[0].type).toBe('equal');
    expect(zones[0].text).toBe('the quick fox');
  });

  it('only conflict changed: one change zone, editor mirrors server', () => {
    const zones = expectRoundTrips('the quick fox', 'the slow fox', 'the quick fox');
    const change = zones.filter((z) => z.type === 'change');
    expect(change).toHaveLength(1);
    expect(change[0]).toMatchObject({
      serverText: 'quick',
      conflictText: 'slow',
      editorText: 'quick',
    });
  });

  it('only editor changed: one change zone, conflict mirrors server', () => {
    const zones = expectRoundTrips('the quick fox', 'the quick fox', 'the fast fox');
    const change = zones.filter((z) => z.type === 'change');
    expect(change).toHaveLength(1);
    expect(change[0]).toMatchObject({
      serverText: 'quick',
      conflictText: 'quick',
      editorText: 'fast',
    });
  });

  it('conflict and editor change identically: single agreeing change zone', () => {
    const zones = expectRoundTrips('the quick fox', 'the slow fox', 'the slow fox');
    const change = zones.filter((z) => z.type === 'change');
    expect(change).toHaveLength(1);
    expect(change[0].conflictText).toBe('slow');
    expect(change[0].editorText).toBe('slow');
  });

  it('conflict and editor change the same zone differently', () => {
    const zones = expectRoundTrips('the quick fox', 'the slow fox', 'the fast fox');
    const change = zones.filter((z) => z.type === 'change');
    expect(change).toHaveLength(1);
    expect(change[0]).toMatchObject({
      serverText: 'quick',
      conflictText: 'slow',
      editorText: 'fast',
    });
  });

  it('adjacent but non-overlapping C and E changes produce separate zones', () => {
    const zones = expectRoundTrips(
      'a b c d e',
      'a B c d e',
      'a b c D e',
    );
    const change = zones.filter((z) => z.type === 'change');
    expect(change).toHaveLength(2);
    expect(change[0]).toMatchObject({ serverText: 'b', conflictText: 'B', editorText: 'b' });
    expect(change[1]).toMatchObject({ serverText: 'd', conflictText: 'd', editorText: 'D' });
  });

  it('C insertion at the same S position as an E deletion forms one change zone', () => {
    const zones = expectRoundTrips('a b c', 'a NEW b c', 'a c');
    const change = zones.filter((z) => z.type === 'change');
    expect(change).toHaveLength(1);
    expect(change[0].serverText).toBe('b ');
    expect(change[0].conflictText).toBe('NEW b ');
    expect(change[0].editorText).toBe('');
  });

  it('E-only insertion at the start', () => {
    const zones = expectRoundTrips('hello', 'hello', 'hi hello');
    const change = zones.filter((z) => z.type === 'change');
    expect(change).toHaveLength(1);
    expect(change[0]).toMatchObject({
      serverText: '',
      conflictText: '',
      editorText: 'hi ',
    });
  });

  it('E-only insertion at the end', () => {
    const zones = expectRoundTrips('hello', 'hello', 'hello world');
    const change = zones.filter((z) => z.type === 'change');
    expect(change).toHaveLength(1);
    expect(change[0]).toMatchObject({
      serverText: '',
      conflictText: '',
      editorText: ' world',
    });
  });

  it('colliding C and E insertions at the same position form one zone', () => {
    const zones = expectRoundTrips('a b', 'a X b', 'a Y b');
    const change = zones.filter((z) => z.type === 'change');
    expect(change).toHaveLength(1);
    expect(change[0].serverText).toBe('');
    expect(change[0].conflictText).toContain('X');
    expect(change[0].editorText).toContain('Y');
  });

  it('empty editor body: whole document is one change zone', () => {
    const zones = expectRoundTrips('a b c', 'a b c', '');
    const change = zones.filter((z) => z.type === 'change');
    expect(change).toHaveLength(1);
    expect(change[0].serverText).toBe('a b c');
    expect(change[0].conflictText).toBe('a b c');
    expect(change[0].editorText).toBe('');
  });

  it('empty server spine: pure additions from both sides', () => {
    expectRoundTrips('', 'conflict text', 'editor text');
  });

  it('all three empty: no zones', () => {
    expect(buildThreeWayZones('', '', '')).toEqual([]);
  });

  it('round-trips across multi-paragraph bodies with mixed edits', () => {
    const server = 'First para here.\n\nSecond para stays.\n\nThird one ends it.';
    const conflict = 'First para changed.\n\nSecond para stays.\n\nThird one ends it.';
    const editor = 'First para here.\n\nSecond para stays.\n\nThird one is edited.';
    expectRoundTrips(server, conflict, editor);
  });

  it('round-trips when both sides delete different runs', () => {
    expectRoundTrips('one two three four five', 'two three four five', 'one two three four');
  });
});

describe('assembleThreeWayBody', () => {
  const zones = buildThreeWayZones('the quick fox', 'the slow fox', 'the fast fox');

  it('defaults missing picks to server', () => {
    expect(assembleThreeWayBody(zones, {})).toBe('the quick fox');
  });

  it('mixes per-zone picks across sources', () => {
    const changeIdx = zones.findIndex((z) => z.type === 'change');
    expect(assembleThreeWayBody(zones, { [changeIdx]: 'editor' })).toBe('the fast fox');
    expect(assembleThreeWayBody(zones, { [changeIdx]: 'conflict' })).toBe('the slow fox');
  });
});

describe('threeWayFmDiffKeys', () => {
  it('lists keys where any pair differs, sorted', () => {
    const s = { status: 'draft', pov: 'Asha', act: 1 };
    const c = { status: 'revision', pov: 'Asha', act: 1 };
    const e = { status: 'draft', pov: 'Tarn', act: 1 };
    expect(threeWayFmDiffKeys(s, c, e)).toEqual(['pov', 'status']);
  });

  it('includes a field present only in editor', () => {
    const s = { status: 'draft' };
    const c = { status: 'draft' };
    const e = { status: 'draft', beat: 'climax' };
    expect(threeWayFmDiffKeys(s, c, e)).toEqual(['beat']);
  });

  it('includes a field differing in all three', () => {
    const s = { status: 'draft' };
    const c = { status: 'revision' };
    const e = { status: 'final' };
    expect(threeWayFmDiffKeys(s, c, e)).toEqual(['status']);
  });

  it('excludes keys equal across all three', () => {
    const s = { status: 'draft', tags: ['a'] };
    const c = { status: 'draft', tags: ['a'] };
    const e = { status: 'draft', tags: ['a'] };
    expect(threeWayFmDiffKeys(s, c, e)).toEqual([]);
  });
});

describe('mergeThreeWayFrontmatter', () => {
  const s = { status: 'draft', pov: 'Asha' };
  const c = { status: 'revision', pov: 'Asha' };
  const e = { status: 'final', pov: 'Tarn', beat: 'climax' };
  const keys = threeWayFmDiffKeys(s, c, e);

  it('defaults each field to server', () => {
    const merged = mergeThreeWayFrontmatter(s, c, e, keys, {});
    expect(merged.status).toBe('draft');
    expect(merged.pov).toBe('Asha');
    expect('beat' in merged).toBe(false);
  });

  it('picks each source per field', () => {
    const merged = mergeThreeWayFrontmatter(s, c, e, keys, {
      status: 'conflict',
      pov: 'editor',
      beat: 'editor',
    });
    expect(merged.status).toBe('revision');
    expect(merged.pov).toBe('Tarn');
    expect(merged.beat).toBe('climax');
  });

  it('deletes a field when the picked source lacks it', () => {
    const merged = mergeThreeWayFrontmatter(s, c, e, keys, { beat: 'server' });
    expect('beat' in merged).toBe(false);
  });

  it('adds an editor-only field when editor is picked', () => {
    const merged = mergeThreeWayFrontmatter({}, {}, { pov: 'Tarn' }, ['pov'], {
      pov: 'editor',
    });
    expect(merged.pov).toBe('Tarn');
  });
});
