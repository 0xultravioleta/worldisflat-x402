// A small DOM for running public/app.js in Node (test/page-app.test.ts): the page's HTML parsed into elements, and only
// what app.js uses: querySelector(All) with tag, #id, .class, [attr], [attr="v"] and descendant selectors, textContent,
// hidden / open / disabled / title, dataset, value, classList.toggle, focus, the selection and click(). Anything it does
// not know (a selector, an entity, markup it cannot parse) throws: a change to app.js or index.html that needs more fails
// here loudly instead of passing on a page that was never filled.

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
// elements whose content is text up to their closing tag; textarea and title still decode entities
const RAW = new Set(["script", "style", "textarea", "title"]);
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (_, e: string) => {
    if (e[0] === "#") return String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    const c = ENTITIES[e];
    if (c === undefined) throw new Error(`fake DOM: unknown entity &${e};`);
    return c;
  });
}

/** dataset key -> attribute: "fooBar" -> "data-foo-bar" */
const dataAttr = (k: string) => `data-${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;

export class FakeText {
  parent: FakeElement | null = null;
  constructor(public data: string) {}
  get textContent(): string {
    return this.data;
  }
}

type Child = FakeElement | FakeText;

interface Compound {
  tag?: string;
  id?: string;
  classes: string[];
  attrs: [string, string | undefined][];
}

function parseSelector(sel: string): Compound[] {
  const parts = sel.trim().split(/\s+/);
  return parts.map((p) => {
    const m = /^([a-z][a-z0-9-]*)?((?:#[\w-]+|\.[\w-]+|\[[\w-]+(?:="[^"]*")?\])*)$/i.exec(p);
    if (!p || !m || (!m[1] && !m[2])) throw new Error(`fake DOM: selector not supported: ${sel}`);
    const c: Compound = { tag: m[1]?.toLowerCase(), classes: [], attrs: [] };
    for (const [, id, cls, attr, val] of m[2].matchAll(/#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g)) {
      if (id) c.id = id;
      else if (cls) c.classes.push(cls);
      else c.attrs.push([attr.toLowerCase(), val]);
    }
    return c;
  });
}

function matchOne(n: FakeElement, c: Compound): boolean {
  if (c.tag && n.localName !== c.tag) return false;
  if (c.id && n.getAttribute("id") !== c.id) return false;
  const classes = (n.getAttribute("class") ?? "").split(/\s+/);
  if (!c.classes.every((k) => classes.includes(k))) return false;
  return c.attrs.every(([k, v]) => (v === undefined ? n.hasAttribute(k) : n.getAttribute(k) === v));
}

// descendant combinators only: the last compound is the element, the others are ancestors, in order
function matches(n: FakeElement, chain: Compound[]): boolean {
  if (!matchOne(n, chain[chain.length - 1])) return false;
  let i = chain.length - 2;
  for (let a = n.parent; a && i >= 0; a = a.parent) if (matchOne(a, chain[i])) i--;
  return i < 0;
}

export class FakeElement {
  parent: FakeElement | null = null;
  childNodes: Child[] = [];
  readonly attributes = new Map<string, string>();
  onclick: ((e: { currentTarget: FakeElement; target: FakeElement }) => unknown) | null = null;
  selectionStart: number | null = null;
  selectionEnd: number | null = null;
  /** a value set by the script or typed, over the markup's */
  private typed: string | null = null;
  readonly dataset: Record<string, string | undefined>;
  readonly classList: { toggle(c: string, force?: boolean): boolean; contains(c: string): boolean };

  constructor(
    readonly localName: string,
    readonly ownerDocument: FakeDocument,
  ) {
    this.dataset = new Proxy({} as Record<string, string | undefined>, {
      get: (_t, k) => (typeof k === "string" ? this.attributes.get(dataAttr(k)) : undefined),
      set: (_t, k, v) => {
        this.attributes.set(dataAttr(String(k)), String(v));
        return true;
      },
    });
    const list = () => (this.attributes.get("class") ?? "").split(/\s+/).filter(Boolean);
    this.classList = {
      contains: (c) => list().includes(c),
      toggle: (c, force) => {
        const on = force ?? !list().includes(c);
        const rest = list().filter((k) => k !== c);
        this.attributes.set("class", (on ? [...rest, c] : rest).join(" "));
        return on;
      },
    };
  }

  private flag(name: string, on: boolean) {
    if (on) this.attributes.set(name, "");
    else this.attributes.delete(name);
  }
  get hidden(): boolean {
    return this.attributes.has("hidden");
  }
  set hidden(v: boolean) {
    this.flag("hidden", !!v);
  }
  get open(): boolean {
    return this.attributes.has("open");
  }
  set open(v: boolean) {
    this.flag("open", !!v);
  }
  get disabled(): boolean {
    return this.attributes.has("disabled");
  }
  set disabled(v: boolean) {
    this.flag("disabled", !!v);
  }
  get title(): string {
    return this.attributes.get("title") ?? "";
  }
  set title(v: string) {
    this.attributes.set("title", String(v));
  }
  get value(): string {
    if (this.typed !== null) return this.typed;
    return this.localName === "textarea" ? this.textContent : (this.attributes.get("value") ?? "");
  }
  set value(v: string) {
    this.typed = String(v);
  }

  get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join("");
  }
  set textContent(v: string) {
    this.replaceChildren(String(v));
  }
  get children(): FakeElement[] {
    return this.childNodes.filter((c): c is FakeElement => c instanceof FakeElement);
  }

  setAttribute(k: string, v: unknown) {
    this.attributes.set(k.toLowerCase(), String(v));
  }
  getAttribute(k: string): string | null {
    return this.attributes.get(k.toLowerCase()) ?? null;
  }
  hasAttribute(k: string): boolean {
    return this.attributes.has(k.toLowerCase());
  }

  /** nodes move (as in the DOM); anything else is appended as its string, as the DOM does */
  append(...kids: unknown[]) {
    for (const k of kids) {
      const n = k instanceof FakeElement || k instanceof FakeText ? k : new FakeText(String(k));
      if (n.parent) n.parent.childNodes.splice(n.parent.childNodes.indexOf(n), 1);
      n.parent = this;
      this.childNodes.push(n);
    }
  }
  replaceChildren(...kids: unknown[]) {
    for (const c of this.childNodes) c.parent = null;
    this.childNodes = [];
    this.append(...kids);
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }
  setSelectionRange(start: number, end: number) {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
  /** a failed assertion prints the tag, never the whole circular document */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    const id = this.getAttribute("id");
    return `<${this.localName}${id ? `#${id}` : ""}>`;
  }
  /** runs the onclick handler and returns what it returns (app.js's handlers are async: await it) */
  click(): unknown {
    return this.onclick?.({ currentTarget: this, target: this });
  }

  matches(sel: string): boolean {
    return matches(this, parseSelector(sel));
  }
  closest(sel: string): FakeElement | null {
    const chain = parseSelector(sel);
    for (let n: FakeElement | null = this; n; n = n.parent) if (matches(n, chain)) return n;
    return null;
  }
  querySelectorAll(sel: string): FakeElement[] {
    const chain = parseSelector(sel);
    const out: FakeElement[] = [];
    const walk = (n: FakeElement) => {
      for (const c of n.children) {
        if (matches(c, chain)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel: string): FakeElement | null {
    return this.querySelectorAll(sel)[0] ?? null;
  }
}

const TOKEN =
  /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/([a-z][a-z0-9-]*)\s*>|<([a-z][a-z0-9-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>|([^<]+)/giy;
const ATTR = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

export class FakeDocument {
  /** the parsed markup: <html> and anything around it */
  readonly root: FakeElement;
  readonly body: FakeElement;
  activeElement: FakeElement | null;

  constructor(html: string) {
    this.root = new FakeElement("#document", this);
    const stack = [this.root];
    let pos = 0;
    while (pos < html.length) {
      TOKEN.lastIndex = pos;
      const m = TOKEN.exec(html);
      if (!m) throw new Error(`fake DOM: cannot parse the markup at ${pos}: ${JSON.stringify(html.slice(pos, pos + 40))}`);
      pos = TOKEN.lastIndex;
      const top = stack[stack.length - 1];
      const [, close, open, attrs, selfClose, text] = m;
      if (text !== undefined) {
        top.append(new FakeText(decode(text)));
      } else if (close) {
        if (top.localName !== close.toLowerCase()) throw new Error(`fake DOM: </${close}> closes <${top.localName}>`);
        stack.pop();
      } else if (open) {
        const n = new FakeElement(open.toLowerCase(), this);
        for (const [, k, v1, v2, v3] of (attrs ?? "").matchAll(ATTR)) n.setAttribute(k, decode(v1 ?? v2 ?? v3 ?? ""));
        top.append(n);
        if (RAW.has(n.localName)) {
          const end = html.toLowerCase().indexOf(`</${n.localName}`, pos);
          if (end < 0) throw new Error(`fake DOM: <${n.localName}> is never closed`);
          const raw = html.slice(pos, end);
          if (raw) n.append(new FakeText(n.localName === "textarea" || n.localName === "title" ? decode(raw) : raw));
          pos = html.indexOf(">", end) + 1;
        } else if (!VOID.has(n.localName) && !selfClose) {
          stack.push(n);
        }
      }
    }
    if (stack.length !== 1) throw new Error(`fake DOM: <${stack[stack.length - 1].localName}> is never closed`);
    const body = this.root.querySelector("body");
    if (!body) throw new Error("fake DOM: no <body>");
    this.body = body;
    this.activeElement = body;
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "#document";
  }
  createElement(tag: string): FakeElement {
    return new FakeElement(tag.toLowerCase(), this);
  }
  createTextNode(s: string): FakeText {
    return new FakeText(String(s));
  }
  querySelectorAll(sel: string): FakeElement[] {
    return this.root.querySelectorAll(sel);
  }
  querySelector(sel: string): FakeElement | null {
    return this.root.querySelector(sel);
  }
}

/** the text a person sees in `n`: hidden elements left out, whitespace collapsed */
export function visibleText(n: FakeElement | FakeText | null): string {
  if (!n) throw new Error("visibleText: no element");
  const walk = (x: Child): string => (x instanceof FakeText ? x.data : x.hidden ? "" : x.childNodes.map(walk).join(""));
  return walk(n).replace(/\s+/g, " ").trim();
}
