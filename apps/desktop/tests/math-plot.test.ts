import { describe, expect, it } from "vite-plus/test";
import { evaluateExpr } from "../src/lib/math/evaluate";
import { parsePlot, renderPlotSvg } from "../src/lib/math/plot";

describe("parsePlot", () => {
  it("parses expressions and strips y=/f(x)= prefixes", () => {
    const spec = parsePlot("x^2 - 4\ny = sin(x)\nf(x) = e^{-x}");
    expect(spec.series).toHaveLength(3);
    expect(spec.errors).toHaveLength(0);
  });

  it("keeps ordinary multi-digit, signed and right-associated plot powers", () => {
    const spec = parsePlot("x^12\n2^3^2\n2^-2");
    expect(spec.errors).toEqual([]);
    const values = spec.series.map((s) => evaluateExpr(s.expr, { x: { re: 2, im: 0 } }).re);
    expect(values).toEqual([4096, 512, 0.25]);
  });

  it("retains bare function and pi aliases in plot syntax", () => {
    const spec = parsePlot("sin(0)+cos(0)\npi");
    expect(spec.errors).toEqual([]);
    expect(spec.series.map((s) => evaluateExpr(s.expr, {}).re)).toEqual([1, Math.PI]);
  });

  it("parses domain and range settings", () => {
    const spec = parsePlot("x\ndomain = -2:8\nrange=-3:3");
    expect(spec.domain).toEqual([-2, 8]);
    expect(spec.range).toEqual([-3, 3]);
  });

  it("reports unknown variables and unparseable lines", () => {
    const spec = parsePlot("x*z\n\\text{hi}\nx + 1");
    expect(spec.series).toHaveLength(1);
    expect(spec.errors).toHaveLength(2);
    expect(spec.errors[0]).toContain("z");
  });

  it("parses vertical lines and one x,y field", () => {
    const spec = parsePlot(
      "x = 1\nx = pi/2\nT(x,y) = 20*sinh(pi*y)*sin(pi*x)/sinh(pi)\nx*y\nx = y",
    );
    expect(spec.vlines.map((l) => l.x)).toEqual([1, Math.PI / 2]);
    expect(spec.field?.label).toContain("T(x,y)");
    expect(spec.series).toHaveLength(0);
    expect(spec.errors).toHaveLength(2);
  });

  it("rejects inverted bounds", () => {
    const spec = parsePlot("x\ndomain = 5:-5");
    expect(spec.errors[0]).toContain("min < max");
  });
});

describe("renderPlotSvg", () => {
  it("produces an svg with one path per series", () => {
    const out = renderPlotSvg("x^2 - 4\nsin(x)");
    expect(out.svg).toContain("<svg");
    expect(out.svg?.match(/<path/g)).toHaveLength(2);
    expect(out.svg).toContain("var(--accent)");
    expect(out.errors).toEqual([]);
  });

  it("draws vertical lines and a heatmap without any curve", () => {
    const out = renderPlotSvg("T(x,y) = 20*sinh(pi*y)*sin(pi*x)/sinh(pi)\nx = 0.5\ndomain=0:1");
    expect(out.errors).toEqual([]);
    expect(out.svg?.match(/<rect [^>]*fill-opacity/g)).toHaveLength(80 * 46);
    expect(out.svg).toContain("<title>x = 0.5</title>");
    expect(out.svg).toContain("… 19.32");
  });

  it("breaks the polyline at asymptotes instead of walling", () => {
    const out = renderPlotSvg("1/x\ndomain=-6:6");
    // Multiple M commands = the path has gaps where the asymptote crosses.
    const moves = out.svg?.match(/M/g) ?? [];
    expect(moves.length).toBeGreaterThan(1);
  });

  it("renders an error result when nothing parses", () => {
    const out = renderPlotSvg("x*z");
    expect(out.svg).toBeUndefined();
    expect(out.errors.length).toBeGreaterThan(0);
  });
});
