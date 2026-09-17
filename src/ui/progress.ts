/**
 * The progress screen: are you actually getting better?
 *
 * The most useful thing on this page is "your top 3 things to work on" in
 * plain language, so it leads. The charts are supporting evidence, not the
 * headline.
 */
import { VERDICT_STYLE } from '../game/classify.js';
import type { StoredGame, StoredMove } from '../history/db.js';
import { labelFor, type SkillProfile } from '../history/profile.js';
import { accuracyChart, rankedBars, statTile, type BarDatum } from './charts.js';

export interface ProgressCallbacks {
  onClose(): void;
  onReplay(gameId: string): void;
}

export function renderProgress(
  container: HTMLElement,
  profile: SkillProfile,
  games: readonly StoredGame[],
  moves: readonly StoredMove[],
  callbacks: ProgressCallbacks,
): void {
  container.replaceChildren();
  container.className = 'progress';

  // --- Header ------------------------------------------------------------
  const header = document.createElement('header');
  header.className = 'progress-header';

  const title = document.createElement('h2');
  title.className = 'progress-title';
  title.textContent = 'Your progress';

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'btn btn-ghost';
  close.textContent = 'Back to the board';
  close.addEventListener('click', callbacks.onClose);

  header.append(title, close);
  container.append(header);

  if (games.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'progress-empty';
    empty.textContent =
      'No finished games yet. Play one and this page will start tracking how you are doing.';
    container.append(empty);
    return;
  }

  // --- Headline tiles ----------------------------------------------------
  const tiles = document.createElement('div');
  tiles.className = 'stat-row';

  const lastAccuracy = profile.accuracyTrend.at(-1) ?? 0;
  const previous = profile.accuracyTrend.at(-2);
  const delta =
    previous === undefined ? undefined : `${lastAccuracy >= previous ? '▲' : '▼'} vs last game`;

  tiles.append(
    statTile('Games played', String(profile.gamesPlayed)),
    statTile('Last accuracy', `${lastAccuracy}%`, delta),
    statTile('Average accuracy', `${profile.avgAccuracy}%`),
    statTile('Best streak', String(bestCleanStreak(games))),
  );
  container.append(tiles);

  // --- What to work on ---------------------------------------------------
  const advice = document.createElement('section');
  advice.className = 'progress-advice';

  const adviceTitle = document.createElement('h3');
  adviceTitle.className = 'progress-subtitle';
  adviceTitle.textContent = 'Your top 3 things to work on';
  advice.append(adviceTitle);

  const list = document.createElement('ol');
  list.className = 'advice-list';

  const items = profile.weaknesses.slice(0, 3);
  if (items.length === 0) {
    const item = document.createElement('li');
    item.textContent =
      profile.gamesPlayed < 3
        ? 'Play a couple more games — there is not enough history yet to spot a pattern.'
        : 'No single pattern stands out. Try a higher level for a sterner test.';
    list.append(item);
  } else {
    for (const rule of items) {
      const stat = profile.ruleStats[rule];
      const item = document.createElement('li');
      item.textContent = stat
        ? `${capitalise(labelFor(rule))} — ${stat.count} times across your games${
            stat.trend < 0 ? ', but improving' : ''
          }.`
        : capitalise(labelFor(rule));
      list.append(item);
    }
  }

  advice.append(list);
  container.append(advice);

  // --- Charts ------------------------------------------------------------
  const charts = document.createElement('div');
  charts.className = 'progress-charts';

  charts.append(
    accuracyChart(
      games.map((game, index) => ({ label: `Game ${index + 1}`, value: game.accuracy })),
      'Accuracy over time',
    ),
  );

  const mistakes: BarDatum[] = Object.values(profile.ruleStats)
    .sort((a, b) => b.count - a.count)
    .slice(0, 6)
    .map((stat) => ({
      label: capitalise(labelFor(stat.rule)),
      value: stat.count,
      ...(stat.trend < 0 ? { note: '▼' } : stat.trend > 0 ? { note: '▲' } : {}),
    }));
  charts.append(rankedBars(mistakes, 'Where the mistakes come from', ''));

  const phases: BarDatum[] = (['opening', 'middlegame', 'endgame'] as const)
    .filter((phase) => profile.byPhase[phase].moves > 0)
    .map((phase) => ({
      label: capitalise(phase),
      value: profile.byPhase[phase].avgCpLoss,
    }));
  charts.append(rankedBars(phases, 'Average loss per move, by phase', ''));

  container.append(charts);

  // --- Game list ---------------------------------------------------------
  const gamesSection = document.createElement('section');
  gamesSection.className = 'progress-games';

  const gamesTitle = document.createElement('h3');
  gamesTitle.className = 'progress-subtitle';
  gamesTitle.textContent = 'Your games';
  gamesSection.append(gamesTitle);

  const gameList = document.createElement('ul');
  gameList.className = 'game-list';

  for (const game of [...games].reverse()) {
    const item = document.createElement('li');

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'game-row';
    button.dataset['gameId'] = game.id;
    button.addEventListener('click', () => callbacks.onReplay(game.id));

    const when = document.createElement('span');
    when.className = 'game-when';
    when.textContent = new Date(game.startedAt).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    });

    const detail = document.createElement('span');
    detail.className = 'game-detail';
    detail.textContent = `${game.openingName ?? 'Unnamed opening'} · level ${game.level}`;

    const score = document.createElement('span');
    score.className = 'game-accuracy';
    score.textContent = `${game.accuracy}%`;

    const blunders = countBlunders(moves, game.id);
    const chip = document.createElement('span');
    chip.className = 'game-blunders';
    chip.textContent =
      blunders === 0 ? 'clean' : `${blunders} ${VERDICT_STYLE.blunder.glyph}`;

    button.append(when, detail, score, chip);
    item.append(button);
    gameList.append(item);
  }

  gamesSection.append(gameList);
  container.append(gamesSection);
}

/** Longest run of recent games without a blunder. */
function bestCleanStreak(games: readonly StoredGame[]): number {
  let best = 0;
  let current = 0;
  for (const game of games) {
    if (game.avgCpLoss < 80) {
      current++;
      best = Math.max(best, current);
    } else {
      current = 0;
    }
  }
  return best;
}

function countBlunders(moves: readonly StoredMove[], gameId: string): number {
  return moves.filter((m) => m.gameId === gameId && m.verdict === 'blunder').length;
}

function capitalise(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}
