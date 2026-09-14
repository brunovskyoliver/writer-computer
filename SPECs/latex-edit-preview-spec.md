# LaTeX editing preview

Keep a live rendered preview above a selected display math block while its original source stays editable. Reuse the math renderer and selection-driven folding. Inline math keeps its existing interaction. Verify the reported expression `\sin\left( \frac{\pi}{2} \right)*\cosh(y)=2` without rewriting its meaning or source.

The screenshot exposed blank lines within the delimiters. Add root-level display block parsing across blank lines, retaining inline parsing in nested Markdown containers. Support a closing delimiter at the end of the formula line. Unclosed blocks stay visible as source.
