// inline-css.mjs — the shared CSS-inlining transform, used by the Pages build
// and by the Go static server's twin (internal/server/static.go inlineStyles).
//
// Why: a render-blocking <link> costs a full extra round trip before first
// paint. Measured on a throttled 4G profile, inlining the critical shell into
// <head> and the deferred half at the end of <body> cut FCP ~40-48% and removed
// 1-2 requests, with total transferred bytes *below* the pre-optimization page.
// The deferred half sits at the end of <body> so it is parsed only after the
// shell can paint, while costing zero requests.
//
// Fails closed: if a page stops using the expected anchors the transform throws,
// because a silently-skipped inline means a silently-regressed first paint.
export const SHELL_LINK = `<link rel="stylesheet" href="/styles.css">`;
export const DEFERRED_LINKS =
  `<link rel="preload" as="style" href="/states.css" onload="this.onload=null;this.rel='stylesheet'">\n` +
  `<noscript><link rel="stylesheet" href="/states.css"></noscript>\n`;

/**
 * Minify enough to matter (comments + whitespace) without a parser dependency.
 *
 * String-literal aware: `content:"Hello, world: friend"` must survive intact, so
 * the punctuation-collapsing passes only run outside quoted text. A blind
 * `\s*([{}:;,])\s*` rewrite also minified inside strings, silently corrupting
 * any `content` value that happened to contain ", " or ": ".
 */
export function minifyCss(css) {
  const out = [];
  let i = 0;
  while (i < css.length) {
    const ch = css[i];
    // Comment.
    if (ch === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      i = end < 0 ? css.length : end + 2;
      continue;
    }
    // Quoted string: copy verbatim to the closing quote.
    if (ch === '"' || ch === "'") {
      const q = ch;
      let j = i + 1;
      while (j < css.length) {
        if (css[j] === "\\") { j += 2; continue; }
        if (css[j] === q) { j++; break; }
        if (css[j] === "\n") break; // unterminated: do not swallow the rest
        j++;
      }
      out.push(css.slice(i, j));
      i = j;
      continue;
    }
    if (/\s/.test(ch)) {
      // Collapse a run of whitespace, and drop it entirely when it only wraps
      // punctuation (`a { color : red }` -> `a{color:red}`).
      let j = i;
      while (j < css.length && /\s/.test(css[j])) j++;
      const next = css[j];
      const prev = out.length ? String(out[out.length - 1]).slice(-1) : "";
      const PUNCT = "{}:;,";
      if (PUNCT.includes(next) || PUNCT.includes(prev)) { i = j; continue; }
      out.push(" ");
      i = j;
      continue;
    }
    if (ch === ";" && css[i + 1] === "}") { i++; continue; } // ;}
    out.push(ch);
    i++;
  }
  return out.join("").trim();
}

/**
 * @param {string} html   page source
 * @param {string} shellCss   styles.css contents
 * @param {string} statesCss  states.css contents
 * @param {string} pageName   for error messages
 */
export function inlineCss(html, shellCss, statesCss, pageName = "page") {
  const fail = m => { throw new Error(`inline-css: ${pageName}: ${m}`); };
  if (!html.includes(SHELL_LINK)) fail(`no ${SHELL_LINK} anchor — has the page stopped linking /styles.css?`);
  if (!html.includes(DEFERRED_LINKS)) fail("no states.css preload+noscript anchor — is the page already inlined, or was the deferred link changed?");
  if (!html.includes("</body>")) fail("no </body> to place the deferred styles before");

  const shell = `<style>${minifyCss(shellCss)}</style>`;
  const deferred = `<style data-deferred>${minifyCss(statesCss)}</style>`;
  // A REPLACER FUNCTION, not a replacement string. String replacements expand
  // $&, $`, $' and $$, so any of those characters in a stylesheet silently
  // rewrote the emitted page: a CSS `content:"$&"` would splice in the matched
  // markup and a `content:"$`"` would splice in the entire <head>.
  // states.css already contains a bare `content:"$"` — one edit away.
  return html
    .replace(SHELL_LINK, () => shell)
    .replace(DEFERRED_LINKS, () => "")
    .replace("</body>", () => `${deferred}\n</body>`);
}
