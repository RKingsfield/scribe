/**
 * Word-level diff via an O(m·n) LCS dynamic-programming table.
 *
 * Tokens are words separated by whitespace; whitespace is preserved as its
 * own token so paragraph breaks survive. Output is a list of segments
 * tagged 'eq' / 'add' / 'del' suitable for rendering inline. Myers'
 * O((m+n)D) algorithm is the noted future swap if inputs ever get large.
 */

import { countWords } from './words';

export type DiffSeg = { type: 'eq' | 'add' | 'del'; text: string };

function tokenize(text: string): string[] {
  // split on whitespace boundaries but keep the whitespace as its own tokens
  const out: string[] = [];
  const re = /(\s+)|([^\s]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push(m[0]);
  }
  return out;
}

export function diffWords(a: string, b: string): DiffSeg[] {
  const at = tokenize(a);
  const bt = tokenize(b);
  const m = at.length;
  const n = bt.length;
  // LCS table (number-of-matching-tokens dynamic-programming).
  // For typical paragraph-sized inputs (~few hundred tokens) the m*n cost is
  // negligible; if a future selection ever blows past 10k tokens we can
  // swap in Myers' O((m+n)D) algorithm.
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0),
  );
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (at[i] === bt[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const segs: DiffSeg[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (at[i] === bt[j]) {
      pushSeg(segs, 'eq', at[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      pushSeg(segs, 'del', at[i]);
      i++;
    } else {
      pushSeg(segs, 'add', bt[j]);
      j++;
    }
  }
  while (i < m) pushSeg(segs, 'del', at[i++]);
  while (j < n) pushSeg(segs, 'add', bt[j++]);
  return segs;
}

function pushSeg(segs: DiffSeg[], type: DiffSeg['type'], text: string) {
  if (segs.length > 0 && segs[segs.length - 1].type === type) {
    segs[segs.length - 1].text += text;
  } else {
    segs.push({ type, text });
  }
}

export interface DiffStats {
  added: number;
  removed: number;
}

export interface MergeZone {
  type: 'equal' | 'change';
  text: string;
  serverText: string;
  conflictText: string;
}

export function buildMergeZones(segs: DiffSeg[]): MergeZone[] {
  const zones: MergeZone[] = [];
  let i = 0;
  while (i < segs.length) {
    if (segs[i].type === 'eq') {
      zones.push({ type: 'equal', text: segs[i].text, serverText: '', conflictText: '' });
      i++;
    } else {
      let serverText = '';
      let conflictText = '';
      while (i < segs.length && segs[i].type !== 'eq') {
        if (segs[i].type === 'del') serverText += segs[i].text;
        else conflictText += segs[i].text;
        i++;
      }
      zones.push({ type: 'change', text: '', serverText, conflictText });
    }
  }
  return zones;
}

export type ThreeWaySource = 'server' | 'conflict' | 'editor';

export interface ThreeWayZone {
  type: 'equal' | 'change';
  text: string;
  serverText: string;
  conflictText: string;
  editorText: string;
}

// Project a two-way S->X diff onto S's token-index space: for each S token,
// whether X changed it; for each gap (position before token i, plus trailing
// gap m), the X text inserted there. Reconstructs X as
//   ins[0] + (chg[i] ? '' : sTokens[i]) + ins[i+1] + ...
function projectOntoS(
  sTokens: string[],
  x: string,
): { chg: boolean[]; ins: string[] } {
  const m = sTokens.length;
  const chg = new Array<boolean>(m).fill(false);
  const ins = new Array<string>(m + 1).fill('');
  let i = 0;
  for (const seg of diffWords(sTokens.join(''), x)) {
    if (seg.type === 'add') {
      ins[i] += seg.text;
    } else {
      const count = tokenize(seg.text).length;
      if (seg.type === 'del') {
        for (let k = 0; k < count; k++) chg[i + k] = true;
      }
      i += count;
    }
  }
  return { chg, ins };
}

// Three-way merge zones aligned on the server canonical S. Runs the word-level
// LCS for S<->C and S<->E, projects both onto S's token spine, and partitions
// S into maximal equal / change runs. Insertions anchor to the S position they
// precede; colliding C and E insertions at one position form a single change
// zone. Round-trips by construction: all-'server' picks reproduce S,
// all-'conflict' reproduce C, all-'editor' reproduce E.
export function buildThreeWayZones(
  server: string,
  conflict: string,
  editor: string,
): ThreeWayZone[] {
  const sTokens = tokenize(server);
  const m = sTokens.length;
  const c = projectOntoS(sTokens, conflict);
  const e = projectOntoS(sTokens, editor);

  const zones: ThreeWayZone[] = [];
  let cur: ThreeWayZone | null = null;
  const close = () => {
    if (cur) zones.push(cur);
    cur = null;
  };
  const ensureChange = (): ThreeWayZone => {
    if (!cur || cur.type !== 'change') {
      close();
      const z: ThreeWayZone = {
        type: 'change',
        text: '',
        serverText: '',
        conflictText: '',
        editorText: '',
      };
      cur = z;
      return z;
    }
    return cur;
  };

  for (let g = 0; g <= m; g++) {
    if (c.ins[g] !== '' || e.ins[g] !== '') {
      const tokenActive = g < m && (c.chg[g] || e.chg[g]);
      if (cur && cur.type === 'change') {
        cur.conflictText += c.ins[g];
        cur.editorText += e.ins[g];
      } else if (tokenActive) {
        const z = ensureChange();
        z.conflictText += c.ins[g];
        z.editorText += e.ins[g];
      } else {
        // Isolated insertion between equal tokens: its own change zone.
        close();
        zones.push({
          type: 'change',
          text: '',
          serverText: '',
          conflictText: c.ins[g],
          editorText: e.ins[g],
        });
      }
    }
    if (g < m) {
      const tok = sTokens[g];
      if (c.chg[g] || e.chg[g]) {
        const z = ensureChange();
        z.serverText += tok;
        z.conflictText += c.chg[g] ? '' : tok;
        z.editorText += e.chg[g] ? '' : tok;
      } else if (cur && cur.type === 'equal') {
        cur.text += tok;
      } else {
        close();
        cur = {
          type: 'equal',
          text: tok,
          serverText: '',
          conflictText: '',
          editorText: '',
        };
      }
    }
  }
  close();
  return zones;
}

export function assembleThreeWayBody(
  zones: ThreeWayZone[],
  picks: Record<number, ThreeWaySource>,
): string {
  return zones
    .map((z, i) => {
      if (z.type === 'equal') return z.text;
      const pick = picks[i] ?? 'server';
      if (pick === 'conflict') return z.conflictText;
      if (pick === 'editor') return z.editorText;
      return z.serverText;
    })
    .join('');
}

export function threeWayFmDiffKeys(
  s: Record<string, unknown>,
  c: Record<string, unknown>,
  e: Record<string, unknown>,
): string[] {
  const allKeys = new Set([
    ...Object.keys(s),
    ...Object.keys(c),
    ...Object.keys(e),
  ]);
  return [...allKeys]
    .filter((k) => {
      const sv = JSON.stringify(s[k]);
      const cv = JSON.stringify(c[k]);
      const ev = JSON.stringify(e[k]);
      return sv !== cv || sv !== ev || cv !== ev;
    })
    .sort();
}

export function mergeThreeWayFrontmatter(
  s: Record<string, unknown>,
  c: Record<string, unknown>,
  e: Record<string, unknown>,
  diffKeys: string[],
  fmPicks: Record<string, ThreeWaySource>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...s };
  for (const k of diffKeys) {
    const pick = fmPicks[k] ?? 'server';
    const source = pick === 'conflict' ? c : pick === 'editor' ? e : s;
    if (k in source) merged[k] = source[k];
    else delete merged[k];
  }
  return merged;
}

export function diffStats(segs: DiffSeg[]): DiffStats {
  let added = 0;
  let removed = 0;
  for (const s of segs) {
    if (s.type === 'add') added += s.text.trim().length > 0 ? countWords(s.text) : 0;
    else if (s.type === 'del') removed += s.text.trim().length > 0 ? countWords(s.text) : 0;
  }
  return { added, removed };
}
