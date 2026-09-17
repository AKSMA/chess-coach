/**
 * Chart primitives, as inline SVG.
 *
 * Every chart here is single-series, so none of them need a categorical
 * palette: magnitude and trend both take one hue, which is the safe default.
 * Colours come from the `--chart-*` tokens so light and dark are stepped
 * separately rather than flipped.
 *
 * Each chart carries a table view for assistive tech and for anyone who wants
 * the numbers — identity is never left to colour alone.
 */

const NS = 'http://www.w3.org/2000/svg';

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
  return element;
}

export interface LinePoint {
  label: string;
  value: number;
}

/**
 * Accuracy over time.
 *
 * A single series, so there is no legend — the caption names it. The last
 * point is direct-labelled rather than labelling every point.
 */
export function accuracyChart(points: LinePoint[], caption: string): HTMLElement {
  const figure = document.createElement('figure');
  figure.className = 'chart';

  const heading = document.createElement('figcaption');
  heading.className = 'chart-caption';
  heading.textContent = caption;
  figure.append(heading);

  if (points.length < 2) {
    const empty = document.createElement('p');
    empty.className = 'chart-empty';
    empty.textContent = 'Play a few games and your accuracy trend will appear here.';
    figure.append(empty);
    return figure;
  }

  const width = 320;
  const height = 120;
  const padding = { top: 10, right: 12, bottom: 18, left: 26 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  // Accuracy is a percentage, so the scale is fixed rather than data-driven —
  // a rescaled y-axis makes a flat run look like wild swings.
  const minValue = 0;
  const maxValue = 100;
  const x = (i: number) => padding.left + (i / (points.length - 1)) * plotWidth;
  const y = (v: number) =>
    padding.top + plotHeight - ((v - minValue) / (maxValue - minValue)) * plotHeight;

  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`,
    class: 'chart-svg',
    role: 'img',
    'aria-label': caption,
  });

  // Recessive gridlines at 0/50/100.
  for (const value of [0, 50, 100]) {
    svg.append(
      svgEl('line', {
        x1: padding.left,
        x2: width - padding.right,
        y1: y(value),
        y2: y(value),
        stroke: 'var(--chart-grid)',
        'stroke-width': 1,
      }),
    );
    const label = svgEl('text', {
      x: padding.left - 6,
      y: y(value) + 3,
      class: 'chart-axis-label',
      'text-anchor': 'end',
    });
    label.textContent = String(value);
    svg.append(label);
  }

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(p.value)}`).join(' ');
  const area = `${line} L${x(points.length - 1)},${y(minValue)} L${x(0)},${y(minValue)} Z`;

  svg.append(svgEl('path', { d: area, fill: 'var(--chart-fill)' }));
  svg.append(
    svgEl('path', {
      d: line,
      fill: 'none',
      stroke: 'var(--chart-line)',
      'stroke-width': 2,
      'stroke-linejoin': 'round',
      'stroke-linecap': 'round',
    }),
  );

  // Only the final point gets a marker and a label.
  const last = points[points.length - 1]!;
  svg.append(
    svgEl('circle', {
      cx: x(points.length - 1),
      cy: y(last.value),
      r: 4,
      fill: 'var(--chart-line)',
      stroke: 'var(--chart-surface)',
      'stroke-width': 2,
    }),
  );

  figure.append(svg);
  figure.append(tableView(['Game', 'Accuracy'], points.map((p) => [p.label, `${p.value}%`])));
  return figure;
}

export interface BarDatum {
  label: string;
  value: number;
  /** Optional trailing note, e.g. a trend arrow. */
  note?: string;
}

/**
 * Ranked horizontal bars — the right form for "which of these is biggest"
 * when the labels are long, which rule names always are.
 */
export function rankedBars(data: BarDatum[], caption: string, unit = ''): HTMLElement {
  const figure = document.createElement('figure');
  figure.className = 'chart';

  const heading = document.createElement('figcaption');
  heading.className = 'chart-caption';
  heading.textContent = caption;
  figure.append(heading);

  if (data.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'chart-empty';
    empty.textContent = 'Nothing to show yet.';
    figure.append(empty);
    return figure;
  }

  const max = Math.max(...data.map((d) => d.value), 1);
  const list = document.createElement('div');
  list.className = 'bars';

  for (const datum of data) {
    const row = document.createElement('div');
    row.className = 'bar-row';

    const label = document.createElement('span');
    label.className = 'bar-label';
    label.textContent = datum.label;

    const track = document.createElement('span');
    track.className = 'bar-track';

    const fill = document.createElement('span');
    fill.className = 'bar-fill';
    fill.style.width = `${Math.max(2, (datum.value / max) * 100)}%`;

    const value = document.createElement('span');
    value.className = 'bar-value';
    value.textContent = `${datum.value}${unit}${datum.note ? ` ${datum.note}` : ''}`;

    track.append(fill);
    row.append(label, track, value);
    list.append(row);
  }

  figure.append(list);
  return figure;
}

/** A single headline number with a label. Not a one-bar bar chart. */
export function statTile(label: string, value: string, note?: string): HTMLElement {
  const tile = document.createElement('div');
  tile.className = 'stat-tile';

  const key = document.createElement('span');
  key.className = 'stat-label';
  key.textContent = label;

  const figure = document.createElement('strong');
  figure.className = 'stat-value';
  figure.textContent = value;

  tile.append(key, figure);

  if (note) {
    const hint = document.createElement('span');
    hint.className = 'stat-note';
    hint.textContent = note;
    tile.append(hint);
  }

  return tile;
}

/** The numbers behind a chart, for screen readers and for checking. */
function tableView(headers: string[], rows: string[][]): HTMLElement {
  const details = document.createElement('details');
  details.className = 'chart-table';

  const summary = document.createElement('summary');
  summary.textContent = 'Show the numbers';
  details.append(summary);

  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const header of headers) {
    const th = document.createElement('th');
    th.textContent = header;
    headRow.append(th);
  }
  thead.append(headRow);

  const tbody = document.createElement('tbody');
  for (const row of rows) {
    const tr = document.createElement('tr');
    for (const cell of row) {
      const td = document.createElement('td');
      td.textContent = cell;
      tr.append(td);
    }
    tbody.append(tr);
  }

  table.append(thead, tbody);
  details.append(table);
  return details;
}
