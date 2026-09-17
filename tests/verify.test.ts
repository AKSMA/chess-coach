import { describe, expect, it } from 'vitest';
import { describeRejection, verify } from '../src/coach/verify.js';
import type { ExplainFacts } from '../src/llm/types.js';

/** The Nxe5 blunder from the Giuoco Piano — the running example. */
const facts: ExplainFacts = {
  verdict: 'blunder',
  mover: 'you',
  san: 'Nxe5',
  bestSan: 'O-O',
  refutationSan: ['Nxe5', 'd4'],
  allowedSquares: ['f3', 'e5', 'c6', 'e1', 'g1', 'd4'],
  allowedSan: ['Nxe5', 'O-O', 'd4'],
  allowedPieces: ['knight', 'pawn', 'king'],
  sentences: [
    'You took their pawn on e5 with your knight.',
    'The problem: your knight on e5 can be taken by their knight on c6.',
  ],
  triggeredRules: ['hangs-piece'],
  openingName: 'Italian Game, Giuoco Piano',
  cpLoss: 300,
  habitSummary: null,
};

const good = (verdict: ExplainFacts['verdict'] = 'best'): ExplainFacts => ({
  ...facts,
  verdict,
  triggeredRules: [],
});

describe('verify — accepting good prose', () => {
  it('passes a faithful paraphrase untouched', () => {
    const text =
      'You grabbed the pawn on e5 with your knight, but that knight is now loose. ' +
      'Their knight on c6 can just take it.';
    const result = verify(text, facts);

    expect(result.ok).toBe(true);
    expect(result.text).toBe(text);
  });

  it('allows squares that appear only in the rule sentences', () => {
    const result = verify('Your knight on e5 is hanging to the knight on c6.', facts);
    expect(result.ok).toBe(true);
  });

  it('allows the better move in notation, since it is in the facts', () => {
    const result = verify('Castling with O-O would have been safer for your king.', facts);
    expect(result.ok).toBe(true);
  });

  it('trims surrounding whitespace', () => {
    const result = verify('  Your knight on e5 is loose.  ', facts);
    expect(result.text).toBe('Your knight on e5 is loose.');
  });
});

describe('verify — adversarial rejections', () => {
  it('rejects an invented square', () => {
    const result = verify('Your knight on h7 is hanging.', facts);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invented-square');
    expect(result.detail).toBe('h7');
  });

  it('rejects a move that was never played or suggested', () => {
    const result = verify('You should have tried Qh5 instead.', facts);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invented-move');
    expect(result.detail).toBe('Qh5');
  });

  it('rejects a piece that is not involved — the check squares and SAN both miss', () => {
    // Contains no square and no SAN token, yet claims the wrong material.
    const result = verify('That move loses your queen for nothing.', facts);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invented-piece');
    expect(result.detail).toBe('queen');
  });

  it('rejects praise on a blunder', () => {
    const result = verify('Great move! Your knight lands on e5.', facts);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('contradicts-verdict');
  });

  it('rejects criticism of your own best move', () => {
    const result = verify('That was a blunder.', good('best'));

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('contradicts-verdict');
  });

  it('rejects a rambling ten-sentence reply', () => {
    const text = Array.from({ length: 10 }, (_, i) => `Sentence number ${i} about e5.`).join(' ');
    const result = verify(text, facts);

    expect(result.ok).toBe(false);
    expect(['too-long', 'too-many-sentences']).toContain(result.reason);
  });

  it('rejects an over-long reply even in few sentences', () => {
    const result = verify(`${'Your knight on e5 is loose. '.repeat(40)}`, facts);
    expect(result.ok).toBe(false);
  });

  it('rejects leaked reasoning tags', () => {
    const result = verify('<think>Let me consider e5</think> Your knight is loose.', facts);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('leaked-markup');
  });

  it('rejects a fenced code block', () => {
    const result = verify('```\nYour knight on e5 is loose.\n```', facts);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('leaked-markup');
  });

  it('rejects an empty reply', () => {
    expect(verify('   ', facts).reason).toBe('empty');
  });
});

describe('verify — the fallback is always the rule text', () => {
  it('returns the rule sentences on every rejection', () => {
    const expected = facts.sentences.join(' ');

    for (const bad of [
      '',
      'Your rook on h7 is hanging.',
      'That loses your queen.',
      'Great move!',
      '<think>hmm</think>',
    ]) {
      const result = verify(bad, facts);
      expect(result.ok).toBe(false);
      expect(result.text).toBe(expected);
    }
  });
});

describe('describeRejection', () => {
  it('explains each rejection in plain language', () => {
    expect(describeRejection(verify('Your knight on h7 is loose.', facts))).toMatch(
      /square not in the position/,
    );
    expect(describeRejection(verify('That loses your queen.', facts))).toMatch(
      /piece that isn't involved/,
    );
    expect(describeRejection(verify('Great move!', facts))).toMatch(/contradicts the verdict/);
    expect(describeRejection(verify('Your knight on e5 is loose.', facts))).toBe('accepted');
  });
});
