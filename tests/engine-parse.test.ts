import { describe, expect, it } from 'vitest';
import { parseInfoLine, uciLineToSan } from '../src/engine/EngineClient.js';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

describe('parseInfoLine', () => {
  it('reads depth, multipv, score and the variation', () => {
    const line =
      'info depth 12 seldepth 18 multipv 1 score cp 34 nodes 5000 nps 100000 time 50 pv e2e4 e7e5 g1f3';
    const pv = parseInfoLine(line, START, 'w');

    expect(pv).not.toBeNull();
    expect(pv!.depth).toBe(12);
    expect(pv!.multipv).toBe(1);
    expect(pv!.score).toEqual({ kind: 'cp', cp: 34 });
    expect(pv!.uci).toEqual(['e2e4', 'e7e5', 'g1f3']);
    expect(pv!.san).toEqual(['e4', 'e5', 'Nf3']);
  });

  it('normalises the score to white-positive when Black is to move', () => {
    const blackToMove = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
    const line = 'info depth 10 multipv 1 score cp 30 pv e7e5';
    const pv = parseInfoLine(line, blackToMove, 'b');

    // +30 for the side to move (Black) is -30 in the white-positive frame.
    expect(pv!.score).toEqual({ kind: 'cp', cp: -30 });
  });

  it('handles mate scores', () => {
    const line = 'info depth 20 multipv 1 score mate 3 pv e2e4';
    expect(parseInfoLine(line, START, 'w')!.score).toEqual({ kind: 'mate', moves: 3 });
  });

  it('defaults multipv to 1 when the engine omits it', () => {
    const line = 'info depth 8 score cp 12 pv d2d4';
    expect(parseInfoLine(line, START, 'w')!.multipv).toBe(1);
  });

  it('ignores non-PV chatter', () => {
    expect(parseInfoLine('info string NNUE evaluation using nn-9067e33176e8.nnue', START, 'w')).toBeNull();
    expect(parseInfoLine('info depth 1 currmove e2e4 currmovenumber 1', START, 'w')).toBeNull();
    expect(parseInfoLine('bestmove e2e4 ponder e7e5', START, 'w')).toBeNull();
  });

  it('rejects bounded scores, which are search artefacts rather than evaluations', () => {
    const line = 'info depth 14 multipv 1 score cp 120 lowerbound pv e2e4';
    expect(parseInfoLine(line, START, 'w')).toBeNull();
  });
});

describe('uciLineToSan', () => {
  it('converts a variation to readable SAN', () => {
    expect(uciLineToSan(START, ['e2e4', 'e7e5', 'g1f3', 'b8c6'])).toEqual([
      'e4',
      'e5',
      'Nf3',
      'Nc6',
    ]);
  });

  it('renders captures and checks the way a player would write them', () => {
    // 1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5, then the losing 4. Nxe5.
    const fen = 'r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';
    expect(uciLineToSan(fen, ['f3e5', 'c6e5'])).toEqual(['Nxe5', 'Nxe5']);
  });

  it('handles promotion, including under-promotion', () => {
    // Kings placed so the new queen gives no check, isolating the promotion SAN.
    const fen = '8/P7/8/4k3/8/8/8/K7 w - - 0 1';
    expect(uciLineToSan(fen, ['a7a8q'])).toEqual(['a8=Q']);
    expect(uciLineToSan(fen, ['a7a8n'])).toEqual(['a8=N']);
  });

  it('marks checks, since the notation is part of what the player reads', () => {
    const fen = '8/P7/8/8/8/8/8/K6k w - - 0 1';
    expect(uciLineToSan(fen, ['a7a8q'])).toEqual(['a8=Q+']);
  });

  it('handles castling, which UCI writes as a two-square king move', () => {
    const fen = 'rnbqk2r/pppp1ppp/5n2/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';
    expect(uciLineToSan(fen, ['e1g1'])).toEqual(['O-O']);
  });

  it('truncates rather than throwing when the line diverges into illegality', () => {
    expect(uciLineToSan(START, ['e2e4', 'e7e5', 'e2e4'])).toEqual(['e4', 'e5']);
  });

  it('returns an empty line for an immediately illegal move', () => {
    expect(uciLineToSan(START, ['e7e5'])).toEqual([]);
  });
});
