/**
 * ` ```plot ` fence support: parse the fence body into series + axis
 * settings, then render an inline SVG function plot.
 *
 * Each non-empty line is an expression in `x` (a leading `y =`/`f(x) =` is
 * stripped) or a `domain=a:b` / `range=a:b` setting. Evaluation reuses the
 * math evaluator with ordinary signed, multi-digit and right-associated
 * powers plus bare function aliases; `x^12`, `sin(x)`, `e^{-x}` all work.
 *
 * Rules: SPECs/math-workflow/spec.md (FR-8).
 */

import { HIGHLIGHT_PALETTE } from "@/lib/highlight/palette";
import { evaluateExpr, freeVariables, parseExpression, type Expr } from "./evaluate";

const SAMPLE_COUNT = 240;
const WIDTH = 560;
const HEIGHT = 320;
const PAD = { top: 14, right: 14, bottom: 26, left: 44 };

export interface PlotSeries {
  expr: Expr;
  label: string;
}

export interface PlotSpec {
  series: PlotSeries[];
  domain: [number, number];
  range: [number, number] | null;
  /** Lines that didn't parse — rendered inside the widget, never hidden. */
  errors: string[];
}

const SETTING_RE =
  /^(domain|xrange|range|yrange)\s*=\s*(-?(?:\d+\.?\d*|\.\d+))\s*:\s*(-?(?:\d+\.?\d*|\.\d+))\s*$/i;
const LHS_RE = /^(?:y|f\s*\(\s*x\s*\))\s*=\s*/i;

export function parsePlot(source: string): PlotSpec {
  const spec: PlotSpec = { series: [], domain: [-6, 6], range: null, errors: [] };

  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;

    const setting = SETTING_RE.exec(line);
    if (setting) {
      const a = parseFloat(setting[2]!);
      const b = parseFloat(setting[3]!);
      if (!(a < b)) {
        spec.errors.push(`"${line}" — needs min < max`);
        continue;
      }
      if (/^(domain|xrange)$/i.test(setting[1]!)) spec.domain = [a, b];
      else spec.range = [a, b];
      continue;
    }

    const text = line.replace(LHS_RE, "");
    try {
      const expr = parseExpression(text, "plot");
      const unknown = freeVariables(expr).filter((name) => name !== "x");
      if (unknown.length > 0) {
        spec.errors.push(
          `"${line}" — unknown variable${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`,
        );
        continue;
      }
      spec.series.push({ expr, label: text });
    } catch (err) {
      spec.errors.push(`"${line}" — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return spec;
}

/** Sample one series over the domain; null where the point should not draw
 *  (non-finite, complex, or a full-range jump — asymptotes stay gaps). */
function sampleSeries(series: PlotSeries, domain: [number, number]): Array<number | null> {
  const [a, b] = domain;
  const points: Array<number | null> = [];
  for (let i = 0; i < SAMPLE_COUNT; i += 1) {
    const x = a + ((b - a) * i) / (SAMPLE_COUNT - 1);
    let y: number | null;
    try {
      const v = evaluateExpr(series.expr, { x: { re: x, im: 0 } });
      y = Number.isFinite(v.re) && Math.abs(v.im) < 1e-9 ? v.re : null;
    } catch {
      y = null;
    }
    points.push(y);
  }
  return points;
}

/** y bounds: explicit `range=` wins; otherwise 2nd/98th percentile of the
 *  finite samples so asymptotic spikes can't stretch the plot. */
function autoRange(samples: Array<Array<number | null>>): [number, number] {
  const values: number[] = [];
  for (const points of samples) {
    for (const y of points) if (y !== null) values.push(y);
  }
  if (values.length === 0) return [-1, 1];
  values.sort((p, q) => p - q);
  const lo = values[Math.floor(values.length * 0.02)]!;
  const hi = values[Math.floor(values.length * 0.98)]!;
  if (lo === hi) return [lo - 1, hi + 1];
  const pad = (hi - lo) * 0.08;
  return [lo - pad, hi + pad];
}

const fmt = (n: number) => {
  const r = Math.abs(n) < 1e-10 ? 0 : n;
  return Math.abs(r) >= 100 ? r.toFixed(0) : Number(r.toPrecision(4)).toString();
};

/** Series colours: first is the app accent, the rest cycle the
 *  formula-highlight palette (both theme-legible, per the palette doc). */
function seriesColour(index: number): string {
  if (index === 0) return "var(--accent)";
  return HIGHLIGHT_PALETTE[(index - 1) % HIGHLIGHT_PALETTE.length]!.hex;
}

export interface PlotRender {
  svg?: string;
  errors: string[];
}

export function renderPlotSvg(source: string): PlotRender {
  const spec = parsePlot(source);
  if (spec.series.length === 0) {
    return {
      errors: [...spec.errors, "no expressions — write e.g. `x^2 - 4` on its own line"],
    };
  }

  const samples = spec.series.map((series) => sampleSeries(series, spec.domain));
  const [x0, x1] = spec.domain;
  const [y0, y1] = spec.range ?? autoRange(samples);

  const px = (x: number) => PAD.left + ((x - x0) / (x1 - x0)) * (WIDTH - PAD.left - PAD.right);
  const py = (y: number) =>
    HEIGHT - PAD.bottom - ((y - y0) / (y1 - y0)) * (HEIGHT - PAD.top - PAD.bottom);

  const parts: string[] = [];
  parts.push(
    `<svg viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Function plot">`,
  );

  // Frame.
  parts.push(
    `<rect x="${PAD.left}" y="${PAD.top}" width="${WIDTH - PAD.left - PAD.right}" height="${HEIGHT - PAD.top - PAD.bottom}" fill="none" stroke="var(--line-subtle, #d0d0d0)" stroke-width="1"/>`,
  );

  // Ticks: four per axis, muted mono labels.
  const tickText = (x: number, y: number, text: string, anchor = "middle") =>
    `<text x="${fmt(x)}" y="${fmt(y)}" text-anchor="${anchor}" font-size="10" fill="var(--pm-muted-color, #888)" font-family="var(--pm-code-font, monospace)">${text}</text>`;

  for (let i = 0; i <= 4; i += 1) {
    const x = x0 + ((x1 - x0) * i) / 4;
    parts.push(
      `<line x1="${fmt(px(x))}" y1="${HEIGHT - PAD.bottom}" x2="${fmt(px(x))}" y2="${HEIGHT - PAD.bottom + 4}" stroke="var(--line-subtle, #d0d0d0)"/>`,
      tickText(px(x), HEIGHT - PAD.bottom + 16, fmt(x)),
    );
    const y = y0 + ((y1 - y0) * i) / 4;
    parts.push(
      `<line x1="${PAD.left - 4}" y1="${fmt(py(y))}" x2="${PAD.left}" y2="${fmt(py(y))}" stroke="var(--line-subtle, #d0d0d0)"/>`,
      tickText(PAD.left - 7, py(y) + 3, fmt(y), "end"),
    );
  }

  // Axes through zero when visible.
  if (y0 < 0 && y1 > 0) {
    parts.push(
      `<line x1="${PAD.left}" y1="${fmt(py(0))}" x2="${WIDTH - PAD.right}" y2="${fmt(py(0))}" stroke="var(--pm-muted-color, #888)" stroke-width="1"/>`,
    );
  }
  if (x0 < 0 && x1 > 0) {
    parts.push(
      `<line x1="${fmt(px(0))}" y1="${PAD.top}" x2="${fmt(px(0))}" y2="${HEIGHT - PAD.bottom}" stroke="var(--pm-muted-color, #888)" stroke-width="1"/>`,
    );
  }

  // Series paths. A jump larger than the full y-range in one sample step is
  // an asymptote crossing, not a feature — break the path there.
  const jumpLimit = (y1 - y0) * 0.5;
  spec.series.forEach((series, si) => {
    const points = samples[si]!;
    let d = "";
    let prev: number | null = null;
    for (let i = 0; i < SAMPLE_COUNT; i += 1) {
      const y = points[i];
      const x = x0 + ((x1 - x0) * i) / (SAMPLE_COUNT - 1);
      if (y === null || y < y0 - (y1 - y0) || y > y1 + (y1 - y0)) {
        prev = null;
        continue;
      }
      if (prev !== null && Math.abs(y - prev) > jumpLimit) {
        prev = null;
        continue;
      }
      const cy = Math.max(PAD.top, Math.min(HEIGHT - PAD.bottom, py(y)));
      d += `${d === "" || prev === null ? "M" : "L"}${fmt(px(x))},${fmt(cy)}`;
      prev = y;
    }
    if (d !== "") {
      parts.push(
        `<path d="${d}" fill="none" stroke="${seriesColour(si)}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"><title>${series.label.replace(/[<>&"]/g, "")}</title></path>`,
      );
    }
  });

  parts.push("</svg>");
  return { svg: parts.join(""), errors: spec.errors };
}
