// A small reader of TypeScript source for the tests that look for a pattern in it (a call that has no time limit).
//
// `codeOnly(text)` returns the text with everything that is not code blanked out (comments, the inside of strings, the
// text of template literals; the expressions inside `${ }` are code and stay), keeping every offset and line where it was,
// so a pattern found in it is code, never a word in a comment or in a sample the test file quotes. `callsOf` finds the
// calls of a name and where each ends. A file the reader loses its way in (a quote it did not close) is reported, not
// silently read as empty.

export interface Scanned {
  code: string;
  /** False when the reader ended inside a string, a comment or a template: what it made of the file cannot be trusted. */
  clean: boolean;
  /** Where it first lost its way (the offset of the string, comment or template it could not close), or -1. */
  lostAt: number;
}

/** After these, a `/` begins a regular expression and not a division. */
const REGEX_AFTER = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);

export function scanCode(text: string): Scanned {
  const out = text.split("");
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n" && out[k] !== "\r") out[k] = " ";
  };
  let clean = true;
  let lostAt = -1;
  const lost = (at: number): void => {
    clean = false;
    if (lostAt < 0) lostAt = at;
  };
  let last = ""; // the last significant character of code seen

  /** Reads code from `i` until the end of the text, or the `}` that closes a template's expression. Returns where it stopped. */
  function code(start: number, inExpression: boolean): number {
    let i = start;
    let depth = 0;
    while (i < text.length) {
      const c = text[i]!;
      const next = text[i + 1];
      if (c === "/" && next === "/") {
        const end = text.indexOf("\n", i);
        const stop = end < 0 ? text.length : end;
        blank(i, stop);
        i = stop;
      } else if (c === "/" && next === "*") {
        const end = text.indexOf("*/", i + 2);
        if (end < 0) {
          lost(i);
          blank(i, text.length);
          return text.length;
        }
        blank(i, end + 2);
        i = end + 2;
      } else if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < text.length && text[j] !== c && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
        if (text[j] !== c) lost(i);
        blank(i, j + 1);
        i = j + 1;
        last = c;
      } else if (c === "`") {
        i = template(i);
        last = "`";
      } else if (c === "/" && (last === "" || REGEX_AFTER.has(last) || /\b(?:return|typeof|case|in|of|else|do|void|throw|new|delete|yield|await)\s*$/.test(text.slice(Math.max(0, i - 12), i)))) {
        // A regular expression literal: to the `/` that closes it (a `/` inside a [class] does not).
        let j = i + 1;
        let inClass = false;
        while (j < text.length && text[j] !== "\n") {
          const d = text[j]!;
          if (d === "\\") j += 2;
          else if (d === "[") (inClass = true), j++;
          else if (d === "]") (inClass = false), j++;
          else if (d === "/" && !inClass) break;
          else j++;
        }
        if (text[j] !== "/") lost(i);
        blank(i, j + 1);
        i = j + 1;
        last = "/";
      } else {
        if (c === "{") depth++;
        else if (c === "}") {
          if (inExpression && depth === 0) return i;
          depth--;
        }
        if (!/\s/.test(c)) last = c;
        i++;
      }
    }
    return i;
  }

  /** Reads a template literal from its opening backtick; returns the index after the closing one. */
  function template(open: number): number {
    let i = open + 1;
    let from = open;
    while (i < text.length) {
      const c = text[i]!;
      if (c === "\\") i += 2;
      else if (c === "`") {
        blank(from, i + 1);
        return i + 1;
      } else if (c === "$" && text[i + 1] === "{") {
        blank(from, i + 2);
        const end = code(i + 2, true);
        if (text[end] !== "}") {
          lost(i);
          return text.length;
        }
        i = end + 1;
        from = end;
      } else i++;
    }
    lost(open);
    blank(from, text.length);
    return text.length;
  }

  code(0, false);
  return { code: out.join(""), clean, lostAt };
}

/** Each call of a name in code (`name(`...`)`), with where it is and its text up to the matching parenthesis. */
export function callsOf(code: string, name: RegExp): Array<{ at: number; call: string }> {
  const found: Array<{ at: number; call: string }> = [];
  for (const m of code.matchAll(name)) {
    let depth = 0;
    let i = m.index! + m[0].length - 1;
    const start = i;
    for (; i < code.length; i++) {
      if (code[i] === "(") depth++;
      else if (code[i] === ")" && --depth === 0) break;
    }
    found.push({ at: m.index!, call: code.slice(start, i + 1) });
  }
  return found;
}

/** Whether the text of a call (from `codeOnly`) names a time limit that is a limit: not 0, undefined, null or false. */
export function hasTimeLimit(call: string): boolean {
  return /\btimeout\s*:\s*(?!(?:0|undefined|null|false)\b)[^\s,})]/.test(call) || /[{,]\s*timeout\s*[,}]/.test(call);
}

export const lineOf = (text: string, at: number): number => text.slice(0, at).split("\n").length;
