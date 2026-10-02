# Follow TeX token rules for superscripts

Status: Done.

Spec: [Code review fixes](../review-fixes/spec.md). Review finding 16.

## Plan

Read evaluator Parser power/fnCall/groupOrAtom, plot caller, evaluation/plot tests and FR-6/FR-8. Pinned KaTeX Parser.ts handleSupSubscript/parseGroup confirms a script uses one nucleus or a brace group. Add explicit tex/plot syntax to parseExpression, default tex; plot.ts requests plot. TeX exponent parsing reads a single digit, single letter without consuming its following subscript, supported bare control nucleus (pi/fraction), or complete brace group. Unsupported bare signs/parentheses/function operators report open, and a repeated superscript remains trailing input. Function-name powers use the same exponent rule. QA and browser probes confirmed bare root/grouping commands must instead be braced. TeX groupOrAtom shares strict single-token argument handling so fraction children cannot greedily consume parentheses or subscripts; plot mode retains existing argument parsing. Separate command contexts: direct bare scripts allow pi/fraction nuclei; strict unbraced fraction/root arguments allow only supported argument-complete tokens such as pi, not another fraction/root command. Braced children parse normally. This satisfies QA's conditional plan approval. Add bound/subscript parsing rejection and function-power regressions. Plot mode retains signed, multi-digit and right-associated powers. Bare multi-letter function/pi aliases belong to plot mode; TeX atom names consume one letter, preventing annotations for rendered separate-letter expressions. The existing bare-function numeric assertion changes to explicit TeX control commands, with separate plot alias checks.

Tests cover 2^12 versus 2^{12}, decimal tails, x^ab versus grouped exponents, nested supported control nuclei, malformed/unsupported script tokens and retained plot powers. Add real pinned-KaTeX syntax checks where useful. Update FR-6/FR-8, worksheet and changelog; QA reviews plan and implementation. No view/layout or parser fallback behavior changes.

## Report

Implemented separate parser modes, command/argument contexts and plot-only aliases. Initial eight token regressions and three alias regressions reproduced wrong values; QA identified invalid bare-root fixture and nested fraction context and these were corrected against pinned KaTeX. Positive numeric fixtures validate with the renderer. Evaluator/plot/command suites pass 91 tests; targeted checks pass. QA approved with no findings. Full frontend suite passes 1,607 tests; vp check reports no errors and ten existing warnings. Browser checks confirm TeX 2^12 evaluates 4 while 2^{12} evaluates 4096, bare invalid roots/aliases stay open, and plots retain 4096/512/bare-function values. No remaining work for this finding.
