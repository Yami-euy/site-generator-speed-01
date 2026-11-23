// Fast drop-in for makefun-site 1.0.0.
//
// A from-scratch implementation of the makefun-site spec (README.md): the
// same build, the same answers byte for byte, but a faster engine. The
// pipeline is one fused pass per stage instead of the reference's plugin
// chain: front matter is scanned line by line, Markdown is lexed and
// rendered in a single walk, inline text is escaped once per run instead of
// once per character, template rendering accumulates into an array, and
// slugs are cached per case. No network, no clock, no randomness: the
// output is a function of the input alone.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const SLUG_MAX = 64;

/** Code-unit order, never the locale's. */
function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `text` with & < > " ' escaped, in one native pass; unchanged when nothing needs it. */
function esc(text) {
  return /[&<>"']/.test(text) ? text.replace(/[&<>"']/g, (c) => ESC[c]) : text;
}

/** The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of other characters one "-", none at either end, at most 64 chars, "untitled" when empty. */
function slugify(text) {
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it): slug, slug-2, slug-3 ... */
function uniqSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

/** Days of month `m` of year `y`, Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A quoted or bare string value, or { error }. */
function fmString(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') {
        return { error: 'a quoted string holds a stray quote' };
      } else {
        out += c;
      }
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or { error }. */
function fmValue(key, raw) {
  if (key === 'title' || key === 'summary') {
    const s = fmString(raw);
    return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
  }
  if (key === 'date') {
    const m = FM_DATE.exec(raw);
    const y = m ? Number(m[1]) : 0;
    const mo = m ? Number(m[2]) : 0;
    const d = m ? Number(m[3]) : 0;
    if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
      return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    }
    return { value: raw };
  }
  if (key === 'tags') {
    if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
    const inner = raw.slice(1, -1);
    if (inner.trim() === '') return { value: [] };
    const tags = inner.split(',').map((t) => t.trim());
    if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
    return { value: tags };
  }
  if (key === 'draft') {
    return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
  }
  if (key === 'layout') {
    return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
  }
  if (key === 'slug') {
    return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
  }
  return { error: `unknown key "${key}"` };
}

/** A source's front matter and body: { data, body }, or { error } with the first reason. */
function fmParse(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (/^[ \t]*$/.test(line) || line[0] === '#') continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${i + 1} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = fmValue(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: lines.slice(close + 1).join('\n') };
}

// ---------------------------------------------------------------- Markdown

/** True when the line holds only spaces and tabs (or nothing). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

/** A line with spaces and tabs dropped at both ends. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line[a] === ' ' || line[a] === '\t')) a++;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  return line.slice(a, b);
}

function isLangCh(c) {
  return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '_' || c === '+' || c === '-';
}

/** A fence opening line's language, or null (``` + language + only spaces/tabs after). */
function fenceLang(line) {
  if (!line.startsWith('```')) return null;
  let j = 3;
  while (j < line.length && isLangCh(line[j])) j++;
  const lang = line.slice(3, j);
  while (j < line.length && (line[j] === ' ' || line[j] === '\t')) j++;
  return j === line.length ? lang : null;
}

/** True for a fence closing line (``` + only spaces/tabs after). */
function isFenceClose(line) {
  if (!line.startsWith('```')) return false;
  for (let j = 3; j < line.length; j++) {
    if (line[j] !== ' ' && line[j] !== '\t') return false;
  }
  return true;
}

/** A heading line's level and text, or null (text never empty, at most 6 #). */
function headingOf(line) {
  let h = 0;
  while (h < line.length && line[h] === '#') h++;
  if (h === 0 || h > 6) return null;
  let j = h;
  while (j < line.length && (line[j] === ' ' || line[j] === '\t')) j++;
  if (j === h) return null;
  let end = line.length;
  while (end > j && (line[end - 1] === ' ' || line[end - 1] === '\t')) end--;
  const text = line.slice(j, end);
  if (text === '') return null;
  return { depth: h, text };
}

/** True for a thematic break (--- or *** + only spaces/tabs after). */
function isHr(line) {
  if (!line.startsWith('---') && !line.startsWith('***')) return false;
  for (let j = 3; j < line.length; j++) {
    if (line[j] !== ' ' && line[j] !== '\t') return false;
  }
  return true;
}

/** A list marker line: { ordered, start, text }, or null. */
function listMarker(line) {
  if (line.length >= 2 && (line[0] === '-' || line[0] === '*') && line[1] === ' ') {
    return { ordered: false, start: 1, text: line.slice(2) };
  }
  let d = 0;
  while (d < line.length && line[d] >= '0' && line[d] <= '9') d++;
  if (d >= 1 && d <= 9 && line[d] === '.' && line[d + 1] === ' ') {
    return { ordered: true, start: Number(line.slice(0, d)), text: line.slice(d + 2) };
  }
  return null;
}

/** True for a list item's continuation line (2+ spaces, then a non-space). */
function isContinued(line) {
  let s = 0;
  while (s < line.length && line[s] === ' ') s++;
  return s >= 2 && s < line.length;
}

/** Whether `line` ends a paragraph: blank, fence, heading or break. */
function endsPara(line) {
  return isBlank(line) || fenceLang(line) !== null || headingOf(line) !== null || isHr(line);
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** First index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnesc(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** First single * from `from` (one whose run is not **), outside an escape, or -1. */
function findStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s` rendered inline; `link(target)` resolves a link's href. A native scan
 * jumps straight to the next construct character (backslash, backtick, star
 * or open bracket); the plain text between constructs is escaped once, in
 * bulk, instead of once per character.
 */
function inlineMd(s, link) {
  const next = /[\\`*\[]/g;
  let out = '';
  let run = 0;
  let m;
  while ((m = next.exec(s)) !== null) {
    const j = m.index;
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      if (j > run) out += esc(s.slice(run, j));
      out += s[j + 1];
      run = j + 2;
      next.lastIndex = run;
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        if (j > run) out += esc(s.slice(run, j));
        out += '<code>' + esc(s.slice(j + 1, k)) + '</code>';
        run = k + 1;
        next.lastIndex = run;
      }
      continue;
    }
    if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findUnesc(s, '**', j + 2);
        if (k > j + 2) {
          if (j > run) out += esc(s.slice(run, j));
          out += '<strong>' + inlineMd(s.slice(j + 2, k), link) + '</strong>';
          run = k + 2;
          next.lastIndex = run;
        } else {
          // A failed ** is two literal stars: the scan must step past both,
          // or the second one would be re-read as a single-star opener.
          next.lastIndex = j + 2;
        }
        continue;
      }
      const k = findStar(s, j + 1);
      if (k > j + 1) {
        if (j > run) out += esc(s.slice(run, j));
        out += '<em>' + inlineMd(s.slice(j + 1, k), link) + '</em>';
        run = k + 1;
        next.lastIndex = run;
      }
      continue;
    }
    // c === '['
    const k = findUnesc(s, ']', j + 1);
    const q = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
    const target = q === -1 ? '' : s.slice(k + 2, q);
    if (target !== '' && !/\s/.test(target)) {
      if (j > run) out += esc(s.slice(run, j));
      out += '<a href="' + esc(link(target)) + '">' + inlineMd(s.slice(j + 1, k), link) + '</a>';
      run = q + 1;
      next.lastIndex = run;
    }
  }
  if (s.length > run) out += esc(s.slice(run));
  return out;
}

/**
 * `src` rendered in one walk: its HTML (each block followed by "\n"), its
 * table of contents (level 2 and 3 headings: level, id, inline HTML) and its
 * excerpt (the first paragraph's inline HTML, or "").
 */
function mdRender(src, link, slug) {
  const lines = src.split('\n');
  const n = lines.length;
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const lang = fenceLang(line);
    if (lang !== null) {
      const body = [];
      i++;
      while (i < n && !isFenceClose(lines[i])) body.push(lines[i++]);
      i++;
      const cls = lang === '' ? '' : ` class="language-${esc(lang)}"`;
      blocks.push(`<pre><code${cls}>${body.length === 0 ? '' : esc(body.join('\n')) + '\n'}</code></pre>`);
      continue;
    }
    const hd = headingOf(line);
    if (hd !== null) {
      const id = uniqSlug(slug(hd.text), ids);
      const html = inlineMd(hd.text, link);
      blocks.push(`<h${hd.depth} id="${id}">${html}</h${hd.depth}>`);
      if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (line[0] === '>') {
      const body = [];
      while (i < n && lines[i][0] === '>') body.push(lines[i++].replace(/^> ?/, ''));
      const inner = [];
      for (const l of body) {
        const t = trimLine(l);
        if (t !== '') inner.push(t);
      }
      blocks.push(inner.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inlineMd(inner.join('\n'), link)}</p>\n</blockquote>`);
      continue;
    }
    const mk = listMarker(line);
    if (mk !== null) {
      const items = [];
      while (i < n) {
        const m2 = listMarker(lines[i]);
        if (m2 !== null && m2.ordered === mk.ordered) {
          items.push([trimLine(m2.text)]);
          i++;
        } else if (isContinued(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else {
          break;
        }
      }
      const tag = mk.ordered ? 'ol' : 'ul';
      const open = mk.ordered && mk.start !== 1 ? `<ol start="${mk.start}">` : `<${tag}>`;
      const lis = [];
      for (const parts of items) lis.push(`<li>${inlineMd(parts.join('\n'), link)}</li>\n`);
      blocks.push(`${open}\n${lis.join('')}</${tag}>`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsPara(lines[i])) body.push(trimLine(lines[i++]));
    const html = inlineMd(body.join('\n'), link);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.length === 0 ? '' : blocks.join('\n') + '\n', toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- Templates

/** A template that does not parse: its name and why. */
class TplErr extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INC_RE = /^include "([a-z0-9-]+)"$/;
const INCLUDE_DEPTH = 8;

/** The path `text` names, split at its dots, or a TplErr. */
function pathParts(name, text) {
  if (!PATH_RE.test(text)) throw new TplErr(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** True when src[a..b) holds only spaces and tabs. */
function isSpaces(src, a, b) {
  for (let k = a; k < b; k++) {
    if (src[k] !== ' ' && src[k] !== '\t') return false;
  }
  return true;
}

/**
 * `src` parsed straight into its node tree (a TplErr when it does not parse).
 * Node kinds: text, var (escaped), raw, for, if (then/els), inc (include).
 * A {% %} tag alone on its line takes the whole line with it, newline included.
 */
function tplParse(name, src) {
  const root = { k: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  let i = 0;
  let text = '';
  const flushText = () => {
    if (text !== '') {
      body.push({ k: 'text', text });
      text = '';
    }
  };
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TplErr(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      flushText();
      body.push({ k: raw ? 'raw' : 'var', path: pathParts(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TplErr(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = isSpaces(src, lineStart, open) && isSpaces(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    flushText();
    const tag = src.slice(open + 2, close).trim();
    const top = stack[stack.length - 1];
    let m;
    if ((m = FOR_RE.exec(tag)) !== null) {
      const node = { k: 'for', name: m[1], path: pathParts(name, m[2]), body: [] };
      body.push(node);
      stack.push(node);
      body = node.body;
    } else if ((m = IF_RE.exec(tag)) !== null) {
      const node = { k: 'if', not: m[1] !== undefined, path: pathParts(name, m[2]), then: [], els: null };
      body.push(node);
      stack.push(node);
      body = node.then;
    } else if (tag === 'else') {
      if (top.k !== 'if' || top.els !== null) throw new TplErr(`template "${name}": an else outside an if`);
      top.els = [];
      body = top.els;
    } else if (tag === 'endfor' || tag === 'endif') {
      if (top.k !== (tag === 'endfor' ? 'for' : 'if')) throw new TplErr(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      stack.pop();
      const parent = stack[stack.length - 1];
      body = parent.k === 'root' ? parent.body : parent.k === 'for' ? parent.body : parent.els ?? parent.then;
    } else if ((m = INC_RE.exec(tag)) !== null) {
      body.push({ k: 'inc', name: m[1] });
    } else {
      throw new TplErr(`template "${name}": {% ${tag} %} is not a tag`);
    }
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  flushText();
  if (stack.length > 1) throw new TplErr(`template "${name}": a ${stack[stack.length - 1].k} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: string itself, a number in JavaScript's digits, true/false, an array's items joined by ", ", else "". */
function valStr(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(valStr).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered into `out` (an array of strings) in `scope`; `tpl` maps names to node trees. */
function tplRender(nodes, scope, tpl, depth, out) {
  for (const n of nodes) {
    if (n.k === 'text') {
      out.push(n.text);
    } else if (n.k === 'var') {
      out.push(esc(valStr(lookup(scope, n.path))));
    } else if (n.k === 'raw') {
      out.push(valStr(lookup(scope, n.path)));
    } else if (n.k === 'if') {
      const v = truthy(lookup(scope, n.path));
      const br = v !== n.not ? n.then : n.els;
      if (br !== null) tplRender(br, scope, tpl, depth, out);
    } else if (n.k === 'for') {
      const xs = lookup(scope, n.path);
      if (!Array.isArray(xs)) continue;
      for (let k = 0; k < xs.length; k++) {
        tplRender(n.body, { vars: { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } }, parent: scope }, tpl, depth, out);
      }
    } else if (n.k === 'inc') {
      const t = tpl.get(n.name);
      if (t !== undefined && depth < INCLUDE_DEPTH) tplRender(t, scope, tpl, depth + 1, out);
    }
  }
}

// ---------------------------------------------------------------- the build

const RESERVED = ['posts', 'tags', 'page'];

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` (a link's path) from the directory `dir`, or null when it climbs out of the root. */
function resolveRel(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.join('/');
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  const m = text.match(/\S+/g);
  return m === null ? 0 : m.length;
}

/**
 * One site's output tree: path -> text. Fresh state per call: nothing is
 * shared with another case, so each case is answered alone.
 */
export function run(input) {
  const slugCache = new Map();
  const slug = (t) => {
    let s = slugCache.get(t);
    if (s === undefined) {
      s = slugify(t);
      slugCache.set(t, s);
    }
    return s;
  };
  const base = input.site.base_url.replace(/\/+$/, '');
  const report = [];
  const broken = new Set();
  const output = {};

  // Templates, in code-unit order of name; one that does not parse is reported and left out.
  const tpl = new Map();
  for (const name of Object.keys(input.templates).sort(cmp)) {
    try {
      tpl.set(name, tplParse(name, input.templates[name]));
    } catch (err) {
      if (err instanceof TplErr) report.push(err.message);
      else throw err;
    }
  }

  // Sources, in code-unit order of path; .md is a source, anything else static.
  const files = [...input.files].sort((a, b) => cmp(a.path, b.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    else statics.push(f);
  }

  // Front matter and the drop rules, in order; the first failing check is reported.
  const kept = [];
  for (const s of sources) {
    const fm = fmParse(s.text);
    if (fm.error !== undefined) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!tpl.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: each slug unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    s.slug = uniqSlug(s.data.slug ?? slug(s.data.title), set);
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown, links resolved to pages and static files.
  const staticPaths = new Set(statics.map((f) => f.path));
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolveRel(dir, rel);
      if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = mdRender(s.body, link, slug);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: posts newest first, equal dates by slug; newer/older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => cmp(y.data.date, x.data.date) || cmp(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags: each post's tags, each slug once, first spelling kept; ordered by count, then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const sl = slug(name);
      if (seen.has(sl)) continue;
      seen.add(sl);
      out.push(name);
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const sl = slug(name);
      let tag = bySlug.get(sl);
      if (tag === undefined) {
        tag = { name, slug: sl, url: `${base}/tags/${sl}/`, posts: [] };
        bySlug.set(sl, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const sl = slug(name);
      return bySlug.get(sl) ?? { name, slug: sl, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || cmp(x.slug, y.slug));

  // Cards, pages and links as templates read them.
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cards = new Map();
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  for (const p of posts) cards.set(p, cardOf(p));
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) });

  // Layouts: every page through its layout, index pages, tag pages, tags page, statics.
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const render = (name, vars) => {
    const nodes = tpl.get(name);
    if (nodes === undefined) return null;
    const out = [];
    tplRender(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, tpl, 0, out);
    return out.join('');
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every line reported above plus each broken link, sorted, then the counts.
  const lines = [...report, ...broken].sort(cmp);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
