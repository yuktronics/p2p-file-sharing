// minify-js.mjs — conservative JavaScript minifier (node stdlib only).
//
// What it does: strips comments, drops blank lines and indentation, collapses
// runs of spaces around punctuation. What it deliberately does NOT do: join
// lines. Every newline in the source stays a newline in the output, so ASI
// (automatic semicolon insertion) behaves byte-for-byte as the author wrote it.
// That single rule removes the entire class of "minifier changed the grammar"
// bugs: `return\n{`, `x\n++`, template continuations, and `/`-ambiguity after
// a line break can never be affected, because no line break is ever removed.
//
// The subtle part is `/`: comment, division, or regex literal. `//` and `/*`
// always win (an empty regex cannot exist). Otherwise a `/` starts a regex
// iff the previous significant token cannot end an expression — the standard
// heuristic: after `(`, `,`, `=`, `:`, `[`, `!`, `&`, `|`, `?`, `{`, `}`, `;`,
// operators and `return`-like keywords it is a regex; after an identifier,
// number, string, template, `)`, or `]` it is division. The one deliberate
// over-approximation: `}` always counts as regex-starting (true after a block,
// wrong after an object literal used as a dividend — `({} / 2)`). A wrong
// guess there would corrupt code, so the emitter keeps a space after `}`, `)`,
// `]` and word characters whenever the next token starts with `/`: `a / b`
// and `a / /re/` both stay correct at the cost of one byte in a rare case.
//
// Space-dropping is likewise guarded: a space survives between two word
// characters (`a b` must not become `ab`), between `+`+`+` / `-`+`-` (else
// `a + +b` becomes the increment `a++b`), and before `/` as above. A `;`
// directly before `}` is dropped (an empty statement is always removable).
//
// Validation, not hope: signal/web's cancel + integrity harnesses drive the
// REAL app.js through ~96 behavioral scenarios in a fake browser. world.mjs
// accepts P2PFILESHARING_APP_SRC to run them against the minified build output, so
// any misparse fails loudly there instead of in production.
const WORD = /[A-Za-z0-9_$]/;
// Keywords after which a `/` opens a regex (rather than dividing the keyword,
// which is a syntax error anyway, so treating it as regex is always right).
const REGEX_AFTER_WORD = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
  "throw", "case", "do", "else", "yield", "await", "in",
]);
// Punctuation after which `/` opens a regex. `}` is the deliberate
// over-approximation documented above; `)` and `]` are NOT in this set.
const REGEX_AFTER_PUNCT = new Set([
  "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";",
  "+", "-", "*", "%", "<", ">", "^", "~",
]);

export function minifyJs(src) {
  const out = [];
  let i = 0;
  // Last significant emitted token, for the `/` decision and space-dropping:
  // { t: "start" } | { t: "word", v: "return" } | { t: "punct", v: ";" }.
  let last = { t: "start" };
  let pendingNewline = false;
  let pendingSpace = false;

  const flushSpace = (nextCh) => {
    if (!pendingSpace && !pendingNewline) return;
    const prevIsWord = last.t === "word";
    const prevCh = last.t === "punct" ? last.v : (prevIsWord ? "a" : "");
    const nextIsWord = nextCh !== undefined && WORD.test(nextCh);
    let keep;
    if (prevIsWord && nextIsWord) keep = true;                    // a b
    else if ((prevCh === "+" || prevCh === "-") && prevCh === nextCh) keep = true; // + + / - -
    else if (nextCh === "/" && (prevIsWord || prevCh === ")" || prevCh === "]" || prevCh === "}")) keep = true;
    else keep = false;
    if (keep) out.push(" ");
    else if (pendingNewline) {
      // A newline collapses to nothing only across a blank line: never emit
      // two in a row, and never drop the newline itself (ASI rule above).
      if (out.length && out[out.length - 1] !== "\n") out.push("\n");
    }
    pendingSpace = pendingNewline = false;
  };

  while (i < src.length) {
    const ch = src[i];
    // Whitespace run.
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n" || ch === "\v" || ch === "\f") {
      if (ch === "\n") pendingNewline = true; else pendingSpace = true;
      i++;
      continue;
    }
    // Comments and regex/division. `//`, `/*` always win (see header).
    if (ch === "/") {
      const nx = src[i + 1];
      if (nx === "/") {
        const end = src.indexOf("\n", i + 2);
        i = end < 0 ? src.length : end; // leave the newline for whitespace handling
        continue;
      }
      if (nx === "*") {
        const end = src.indexOf("*/", i + 2);
        // A block comment can contain newlines: preserve ONE so line-based
        // ASI behavior cannot shift (a comment never joins lines, but keeping
        // the break costs nothing and keeps output line numbers close).
        if (end >= 0 && src.slice(i, end).includes("\n")) pendingNewline = true;
        i = end < 0 ? src.length : end + 2;
        continue;
      }
      const afterWord = last.t === "word" && !REGEX_AFTER_WORD.has(last.v);
      const afterPunctValue = last.t === "punct" && !REGEX_AFTER_PUNCT.has(last.v);
      if (afterWord || afterPunctValue) {
        flushSpace("/"); // division (or /=): never a regex here
        out.push(nx === "=" ? "/=" : "/");
        i += nx === "=" ? 2 : 1;
        last = { t: "punct", v: "/" };
        continue;
      }
      // A regex may itself start with `=` (`/=+/` matches "="), so `/=` is
      // only division-assign when the left side can end an expression.
      // Regex literal: consume with character-class and escape awareness.
      flushSpace("/");
      let j = i + 1, inClass = false;
      let closed = false;
      while (j < src.length) {
        const c = src[j];
        if (c === "\\") { j += 2; continue; }
        if (c === "[") { inClass = true; j++; continue; }
        if (c === "]") { inClass = false; j++; continue; }
        if (c === "/" && !inClass) { closed = true; break; }
        if (c === "\n") break; // unterminated: bail rather than swallow the file
        j++;
      }
      if (!closed) { out.push("/"); i++; last = { t: "punct", v: "/" }; continue; }
      j++; // closing slash
      while (j < src.length && /[a-z]/.test(src[j])) j++; // flags
      out.push(src.slice(i, j));
      i = j;
      last = { t: "punct", v: "/" };
      continue;
    }
    // Strings, verbatim (escapes included).
    if (ch === "'" || ch === '"') {
      flushSpace(ch);
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === ch) { j++; break; }
        if (src[j] === "\n") break;
        j++;
      }
      out.push(src.slice(i, j));
      i = j;
      last = { t: "word" };
      continue;
    }
    // Template literals: verbatim, with ${} nesting.
    if (ch === "`") {
      flushSpace("`");
      let j = i + 1, depth = 0;
      while (j < src.length) {
        const c = src[j];
        if (c === "\\") { j += 2; continue; }
        if (c === "`" && depth === 0) { j++; break; }
        if (c === "$" && src[j + 1] === "{") { depth++; j += 2; continue; }
        if (c === "}" && depth > 0) { depth--; j++; continue; }
        j++;
      }
      out.push(src.slice(i, j));
      i = j;
      last = { t: "word" };
      continue;
    }
    // Word characters accumulate into identifiers/numbers for the keyword check.
    if (WORD.test(ch)) {
      let j = i + 1;
      while (j < src.length && WORD.test(src[j])) j++;
      flushSpace(src[i]);
      out.push(src.slice(i, j));
      last = { t: "word", v: src.slice(i, j) };
      i = j;
      continue;
    }
    // Any other punctuation: `;}` collapses (empty statement, always safe).
    flushSpace(ch);
    if (!(ch === "}" && out.length && out[out.length - 1] === ";")) out.push(ch);
    else out[out.length - 1] = "}";
    last = { t: "punct", v: ch };
    i++;
  }
  return out.join("").trim();
}
