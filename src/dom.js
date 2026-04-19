/**
 * frenderer/src/dom.js
 *
 * Phase 3: DOM API Layer
 *
 * Wraps the raw parser tree with browser-compatible interfaces.
 * When page scripts run in the vm sandbox, they call these methods —
 * which actually mutate our in-memory tree.
 *
 * Implements (enough to boot React, Vue, Alpine, vanilla JS):
 *
 *   Node         — base: nodeType, nodeName, parentNode, childNodes,
 *                  appendChild, removeChild, replaceChild, insertBefore,
 *                  cloneNode, contains, textContent (get/set)
 *
 *   Element      — id, className, classList, tagName, innerHTML (get/set),
 *                  getAttribute, setAttribute, removeAttribute, hasAttribute,
 *                  querySelector, querySelectorAll, closest,
 *                  children, firstElementChild, lastElementChild,
 *                  nextElementSibling, previousElementSibling,
 *                  matches, dataset, style (stub), addEventListener,
 *                  removeEventListener, dispatchEvent
 *
 *   Document     — createElement, createTextNode, createComment,
 *                  createDocumentFragment, getElementById,
 *                  getElementsByTagName, getElementsByClassName,
 *                  querySelector, querySelectorAll, head, body,
 *                  documentElement, title (get/set)
 *
 *   CSS selector engine — tag, #id, .class, [attr], [attr=val],
 *                         descendant ( ), child (>), sibling (+, ~),
 *                         :first-child, :last-child, :nth-child,
 *                         :not(), compound selectors
 */

"use strict";

const { tokenize } = require("./tokenizer");
const { parse, walk, findAll, findFirst, makeElement } = require("./parser");

// ─── Node type constants (mirrors browser) ────────────────────────────────────
const NodeType = {
  ELEMENT_NODE: 1,
  TEXT_NODE: 3,
  COMMENT_NODE: 8,
  DOCUMENT_NODE: 9,
  DOCUMENT_FRAGMENT_NODE: 11,
};

// ─── Selector engine ──────────────────────────────────────────────────────────

/**
 * Minimal CSS selector engine.
 * Supports: tag, #id, .class, [attr], [attr=val], [attr^=], [attr$=], [attr*=]
 * Combinators: descendant ' ', child '>', adjacent '+', sibling '~'
 * Pseudo: :first-child, :last-child, :nth-child(n), :not(sel), :empty
 * Compound: div.class#id[attr]
 */

function parseSimpleSelector(sel) {
  // Returns a predicate function (node) => bool for a single compound selector
  // e.g. "div.foo#bar[data-x=1]"
  const checks = [];

  let s = sel.trim();

  // Tag
  const tagMatch = s.match(/^([a-zA-Z][a-zA-Z0-9]*)/);
  if (tagMatch) {
    const tag = tagMatch[1].toLowerCase();
    checks.push((n) => n.name === tag);
    s = s.slice(tagMatch[0].length);
  }

  // Loop through remaining qualifiers
  while (s.length > 0) {
    if (s[0] === "#") {
      // ID
      const m = s.match(/^#([\w-]+)/);
      if (m) {
        const id = m[1];
        checks.push((n) => n.attrs && n.attrs.id === id);
        s = s.slice(m[0].length);
      } else break;
    } else if (s[0] === ".") {
      // Class
      const m = s.match(/^\.([\w-]+)/);
      if (m) {
        const cls = m[1];
        checks.push((n) => {
          if (!n.attrs?.class) return false;
          return n.attrs.class.split(/\s+/).includes(cls);
        });
        s = s.slice(m[0].length);
      } else break;
    } else if (s[0] === "[") {
      // Attribute
      const m = s.match(/^\[([^\]]+)\]/);
      if (m) {
        const inner = m[1];
        const attrEq = inner.match(/^([\w-]+)\s*=\s*["']?([^"'\]]*)["']?$/);
        const attrPre = inner.match(/^([\w-]+)\s*\^=\s*["']?([^"'\]]*)["']?$/);
        const attrSuf = inner.match(/^([\w-]+)\s*\$=\s*["']?([^"'\]]*)["']?$/);
        const attrSub = inner.match(/^([\w-]+)\s*\*=\s*["']?([^"'\]]*)["']?$/);
        const attrExist = inner.match(/^([\w-]+)$/);
        if (attrEq) {
          const [, a, v] = attrEq;
          checks.push((n) => n.attrs && n.attrs[a] === v);
        } else if (attrPre) {
          const [, a, v] = attrPre;
          checks.push((n) => n.attrs && (n.attrs[a] || "").startsWith(v));
        } else if (attrSuf) {
          const [, a, v] = attrSuf;
          checks.push((n) => n.attrs && (n.attrs[a] || "").endsWith(v));
        } else if (attrSub) {
          const [, a, v] = attrSub;
          checks.push((n) => n.attrs && (n.attrs[a] || "").includes(v));
        } else if (attrExist) {
          const [, a] = attrExist;
          checks.push((n) => n.attrs && n.attrs[a] !== undefined);
        }
        s = s.slice(m[0].length);
      } else break;
    } else if (s[0] === ":") {
      // Pseudo-class
      const notM = s.match(/^:not\(([^)]+)\)/);
      const nthM = s.match(/^:nth-child\((\d+)\)/);
      if (notM) {
        const inner = notM[1];
        const innerPred = parseSimpleSelector(inner);
        checks.push((n) => !innerPred(n));
        s = s.slice(notM[0].length);
      } else if (s.startsWith(":first-child")) {
        checks.push((n) => {
          if (!n.parent) return false;
          const siblings = n.parent.children.filter((c) => c.type === "element");
          return siblings[0] === n;
        });
        s = s.slice(":first-child".length);
      } else if (s.startsWith(":last-child")) {
        checks.push((n) => {
          if (!n.parent) return false;
          const siblings = n.parent.children.filter((c) => c.type === "element");
          return siblings[siblings.length - 1] === n;
        });
        s = s.slice(":last-child".length);
      } else if (nthM) {
        const nth = parseInt(nthM[1], 10);
        checks.push((n) => {
          if (!n.parent) return false;
          const siblings = n.parent.children.filter((c) => c.type === "element");
          return siblings.indexOf(n) === nth - 1;
        });
        s = s.slice(nthM[0].length);
      } else if (s.startsWith(":empty")) {
        checks.push(
          (n) =>
            !n.children ||
            n.children.filter((c) => c.type === "element" || (c.type === "text" && c.value.trim()))
              .length === 0,
        );
        s = s.slice(":empty".length);
      } else {
        break; // unknown pseudo — skip
      }
    } else {
      break;
    }
  }

  if (checks.length === 0) {
    // Universal selector or unknown — match all elements
    return (n) => n.type === "element";
  }

  return (n) => n.type === "element" && checks.every((fn) => fn(n));
}

/**
 * Parse a full selector string (with combinators) into a list of
 * { combinator, predicate } steps. We evaluate right-to-left.
 *
 * Combinators:
 *   ''   = descendant
 *   '>'  = direct child
 *   '+'  = adjacent sibling
 *   '~'  = general sibling
 */
function parseSelector(selector) {
  // Split on commas first (handles "a, b, c")
  const groups = splitSelectorGroups(selector);
  return groups.map((group) => parseSelectorGroup(group.trim()));
}

function splitSelectorGroups(selector) {
  // Split by comma, but not inside brackets
  const groups = [];
  let depth = 0,
    current = "";
  for (const ch of selector) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      groups.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  groups.push(current);
  return groups;
}

function parseSelectorGroup(group) {
  // Returns array of { combinator, predicate } — last item is the target
  const parts = [];
  // Tokenize by combinator characters (but preserve inside brackets/parens)
  const tokens = [];
  let cur = "";
  let depth = 0;
  for (let i = 0; i < group.length; i++) {
    const ch = group[i];
    if (ch === "(" || ch === "[") {
      depth++;
      cur += ch;
    } else if (ch === ")" || ch === "]") {
      depth--;
      cur += ch;
    } else if (depth === 0 && (ch === ">" || ch === "+" || ch === "~")) {
      if (cur.trim()) tokens.push({ type: "simple", value: cur.trim() });
      tokens.push({ type: "combinator", value: ch });
      cur = "";
    } else if (depth === 0 && ch === " " && cur.trim()) {
      // Could be descendant combinator or just whitespace
      // Look ahead: if next non-space is a combinator, skip
      let j = i + 1;
      while (j < group.length && group[j] === " ") j++;
      if (j < group.length && !"> + ~".split(" ").includes(group[j])) {
        tokens.push({ type: "simple", value: cur.trim() });
        tokens.push({ type: "combinator", value: " " });
        cur = "";
        i = j - 1;
      } else {
        cur += ch;
      }
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) tokens.push({ type: "simple", value: cur.trim() });

  // Build parts array
  let combinator = " "; // default: descendant (for first item it's irrelevant)
  for (const tok of tokens) {
    if (tok.type === "combinator") {
      combinator = tok.value;
    } else {
      parts.push({ combinator, predicate: parseSimpleSelector(tok.value) });
      combinator = " ";
    }
  }
  return parts;
}

/**
 * Test whether a node matches a parsed selector group (array of parts).
 * We match right-to-left against the DOM ancestry.
 */
function matchesGroup(node, parts) {
  if (!parts.length) return false;
  let current = node;
  for (let i = parts.length - 1; i >= 0; i--) {
    const { predicate } = parts[i];
    if (!current || current.type !== "element") return false;
    if (!predicate(current)) return false;
    if (i === 0) return true;
    const parentCombinator = parts[i].combinator;
    if (parentCombinator === ">") {
      current = current.parent;
    } else if (parentCombinator === " ") {
      // Any ancestor must match parts[i-1]
      current = current.parent;
      // Walk up ancestry until we find a match for parts[i-1]
      while (current && current.type === "element") {
        if (matchesGroup(current, parts.slice(0, i))) return true;
        current = current.parent;
      }
      return false;
    } else if (parentCombinator === "+") {
      // Adjacent sibling
      if (!current.parent) return false;
      const siblings = current.parent.children.filter((c) => c.type === "element");
      const idx = siblings.indexOf(current);
      current = idx > 0 ? siblings[idx - 1] : null;
    } else if (parentCombinator === "~") {
      // General sibling — any preceding sibling
      if (!current.parent) return false;
      const siblings = current.parent.children.filter((c) => c.type === "element");
      const idx = siblings.indexOf(current);
      const preceding = siblings.slice(0, idx);
      return preceding.some((sib) => matchesGroup(sib, parts.slice(0, i)));
    }
  }
  return true;
}

/**
 * Test whether a node matches a full selector string (any group).
 */
function matchesSelector(node, selector) {
  if (node.type !== "element") return false;
  try {
    const groups = parseSelector(selector);
    return groups.some((group) => matchesGroup(node, group));
  } catch {
    return false;
  }
}

/**
 * Find all elements under root matching selector.
 */
function querySelectorAll(root, selector) {
  const results = [];
  const groups = parseSelector(selector);
  walk(root, (node) => {
    if (node.type === "element" && node !== root) {
      if (groups.some((g) => matchesGroup(node, g))) results.push(node);
    }
  });
  return results;
}

/**
 * Find first element under root matching selector.
 */
function querySelector(root, selector) {
  return querySelectorAll(root, selector)[0] || null;
}

// ─── Text content helpers ─────────────────────────────────────────────────────

function getTextContent(node) {
  if (node.type === "text") return node.value;
  if (!node.children) return "";
  return node.children.map(getTextContent).join("");
}

function setTextContent(node, text) {
  node.children = [{ type: "text", value: String(text), parent: node }];
}

// ─── innerHTML serializer (mini, enough for get/set) ──────────────────────────

function serializeNode(node) {
  if (node.type === "text") return node.value;
  if (node.type === "comment") return `<!--${node.value}-->`;
  if (node.type === "element") {
    const attrs = Object.entries(node.attrs || {})
      .map(([k, v]) => (v === "" ? k : `${k}="${v.replace(/"/g, "&quot;")}"`))
      .join(" ");
    const open = attrs ? `<${node.name} ${attrs}>` : `<${node.name}>`;
    const VOID = new Set([
      "area",
      "base",
      "br",
      "col",
      "embed",
      "hr",
      "img",
      "input",
      "link",
      "meta",
      "param",
      "source",
      "track",
      "wbr",
    ]);
    if (VOID.has(node.name)) return open;
    const inner = (node.children || []).map(serializeNode).join("");
    return `${open}${inner}</${node.name}>`;
  }
  if (node.type === "document" || node.type === "fragment") {
    return (node.children || []).map(serializeNode).join("");
  }
  return "";
}

function setInnerHTML(node, html) {
  const tokens = tokenize(html);
  const fragment = parse(tokens);
  // Grab body children (parser always wraps in html/head/body)
  const body = findFirst(fragment, (n) => n.name === "body");
  const children = body ? body.children : fragment.children;
  node.children = children.map((c) => {
    c.parent = node;
    return c;
  });
}

// ─── classList implementation ─────────────────────────────────────────────────

function makeClassList(node) {
  const get = () => (node.attrs.class || "").split(/\s+/).filter(Boolean);
  return {
    get length() {
      return get().length;
    },
    contains: (cls) => get().includes(cls),
    add: (...classes) => {
      const cur = get();
      classes.forEach((c) => {
        if (!cur.includes(c)) cur.push(c);
      });
      node.attrs.class = cur.join(" ");
    },
    remove: (...classes) => {
      const cur = get().filter((c) => !classes.includes(c));
      node.attrs.class = cur.join(" ");
    },
    toggle: (cls, force) => {
      const cur = get();
      const has = cur.includes(cls);
      if (force === true || (!has && force === undefined)) {
        if (!has) {
          cur.push(cls);
          node.attrs.class = cur.join(" ");
        }
        return true;
      } else {
        node.attrs.class = cur.filter((c) => c !== cls).join(" ");
        return false;
      }
    },
    replace: (old, next) => {
      const cur = get();
      const idx = cur.indexOf(old);
      if (idx !== -1) {
        cur[idx] = next;
        node.attrs.class = cur.join(" ");
        return true;
      }
      return false;
    },
    toString: () => node.attrs.class || "",
    [Symbol.iterator]: function* () {
      yield* get();
    },
  };
}

// ─── dataset implementation ───────────────────────────────────────────────────

function makeDataset(node) {
  // dataset.fooBar ↔ data-foo-bar attribute
  const toAttr = (key) => `data-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
  const fromAttr = (attr) => attr.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  return new Proxy(
    {},
    {
      get(_, key) {
        return node.attrs[toAttr(key)];
      },
      set(_, key, val) {
        node.attrs[toAttr(key)] = String(val);
        return true;
      },
      deleteProperty(_, key) {
        delete node.attrs[toAttr(key)];
        return true;
      },
      ownKeys() {
        return Object.keys(node.attrs)
          .filter((k) => k.startsWith("data-"))
          .map(fromAttr);
      },
      has(_, key) {
        return toAttr(key) in node.attrs;
      },
    },
  );
}

// ─── Style stub ───────────────────────────────────────────────────────────────

function makeStyle(node) {
  // Parses inline style attr; writes back on set
  const parse = () => {
    const result = {};
    const raw = node.attrs.style || "";
    raw.split(";").forEach((decl) => {
      const [prop, ...rest] = decl.split(":");
      if (prop && rest.length) result[prop.trim()] = rest.join(":").trim();
    });
    return result;
  };
  const serialize = (obj) => {
    return Object.entries(obj)
      .map(([k, v]) => `${k}: ${v}`)
      .join("; ");
  };
  return new Proxy(
    {},
    {
      get(_, key) {
        return parse()[key] || "";
      },
      set(_, key, val) {
        const s = parse();
        if (val === "" || val == null) delete s[key];
        else s[key] = val;
        node.attrs.style = serialize(s);
        return true;
      },
    },
  );
}

// ─── Event system (stub — enough for addEventListener patterns) ───────────────

function makeEventTarget() {
  const listeners = {};
  return {
    addEventListener(type, fn) {
      if (!listeners[type]) listeners[type] = [];
      listeners[type].push(fn);
    },
    removeEventListener(type, fn) {
      if (!listeners[type]) return;
      listeners[type] = listeners[type].filter((f) => f !== fn);
    },
    dispatchEvent(event) {
      const type = event.type || event;
      const fns = listeners[type] || [];
      fns.forEach((fn) => {
        try {
          fn(event);
        } catch {}
      });
      return true;
    },
  };
}

// ─── Node wrapper ─────────────────────────────────────────────────────────────

/**
 * Wrap a raw tree node with a DOM-compatible interface.
 * We use a Proxy so property access on the wrapper also works on the raw node,
 * allowing the serializer to read raw tree data directly.
 */
function wrapNode(raw, docWrapper) {
  if (!raw) return null;
  if (raw._domWrapper) return raw._domWrapper; // cache

  const events = makeEventTarget();

  const wrapper = {
    // ── Identity ─────────────────────────────────────────────────────────
    _raw: raw,
    get nodeType() {
      if (raw.type === "element") return NodeType.ELEMENT_NODE;
      if (raw.type === "text") return NodeType.TEXT_NODE;
      if (raw.type === "comment") return NodeType.COMMENT_NODE;
      if (raw.type === "document") return NodeType.DOCUMENT_NODE;
      if (raw.type === "fragment") return NodeType.DOCUMENT_FRAGMENT_NODE;
      return 0;
    },
    get nodeName() {
      if (raw.type === "element") return raw.name.toUpperCase();
      if (raw.type === "text") return "#text";
      if (raw.type === "comment") return "#comment";
      return "#document";
    },
    get tagName() {
      return raw.name ? raw.name.toUpperCase() : undefined;
    },
    get localName() {
      return raw.name || undefined;
    },

    // ── Tree navigation ───────────────────────────────────────────────────
    get parentNode() {
      return raw.parent ? wrapNode(raw.parent, docWrapper) : null;
    },
    get parentElement() {
      return raw.parent && raw.parent.type === "element" ? wrapNode(raw.parent, docWrapper) : null;
    },
    get childNodes() {
      return Object.assign(
        (raw.children || []).map((c) => wrapNode(c, docWrapper)),
        { item: (i) => wrapNode((raw.children || [])[i], docWrapper) || null },
      );
    },
    get children() {
      const els = (raw.children || []).filter((c) => c.type === "element");
      return Object.assign(
        els.map((c) => wrapNode(c, docWrapper)),
        {
          item: (i) => wrapNode(els[i], docWrapper) || null,
        },
      );
    },
    get firstChild() {
      return raw.children?.[0] ? wrapNode(raw.children[0], docWrapper) : null;
    },
    get lastChild() {
      const c = raw.children;
      return c?.length ? wrapNode(c[c.length - 1], docWrapper) : null;
    },
    get firstElementChild() {
      const el = (raw.children || []).find((c) => c.type === "element");
      return el ? wrapNode(el, docWrapper) : null;
    },
    get lastElementChild() {
      const els = (raw.children || []).filter((c) => c.type === "element");
      return els.length ? wrapNode(els[els.length - 1], docWrapper) : null;
    },
    get nextSibling() {
      if (!raw.parent) return null;
      const siblings = raw.parent.children;
      const idx = siblings.indexOf(raw);
      return idx !== -1 && siblings[idx + 1] ? wrapNode(siblings[idx + 1], docWrapper) : null;
    },
    get previousSibling() {
      if (!raw.parent) return null;
      const siblings = raw.parent.children;
      const idx = siblings.indexOf(raw);
      return idx > 0 ? wrapNode(siblings[idx - 1], docWrapper) : null;
    },
    get nextElementSibling() {
      if (!raw.parent) return null;
      const siblings = raw.parent.children.filter((c) => c.type === "element");
      const idx = siblings.indexOf(raw);
      return idx !== -1 && siblings[idx + 1] ? wrapNode(siblings[idx + 1], docWrapper) : null;
    },
    get previousElementSibling() {
      if (!raw.parent) return null;
      const siblings = raw.parent.children.filter((c) => c.type === "element");
      const idx = siblings.indexOf(raw);
      return idx > 0 ? wrapNode(siblings[idx - 1], docWrapper) : null;
    },
    get ownerDocument() {
      return docWrapper;
    },

    // ── Content ───────────────────────────────────────────────────────────
    get textContent() {
      return getTextContent(raw);
    },
    set textContent(v) {
      setTextContent(raw, v);
    },
    get nodeValue() {
      return raw.type === "text" || raw.type === "comment" ? raw.value : null;
    },
    set nodeValue(v) {
      if (raw.type === "text" || raw.type === "comment") raw.value = String(v);
    },
    get data() {
      return raw.value || "";
    },
    set data(v) {
      raw.value = String(v);
    },

    // innerHTML / outerHTML
    get innerHTML() {
      return (raw.children || []).map(serializeNode).join("");
    },
    set innerHTML(html) {
      setInnerHTML(raw, html);
    },
    get outerHTML() {
      return serializeNode(raw);
    },
    set outerHTML(html) {
      if (!raw.parent) return;
      const tokens = tokenize(html);
      const frag = parse(tokens);
      const body = findFirst(frag, (n) => n.name === "body");
      const newChildren = body ? body.children : frag.children;
      const siblings = raw.parent.children;
      const idx = siblings.indexOf(raw);
      newChildren.forEach((c) => {
        c.parent = raw.parent;
      });
      siblings.splice(idx, 1, ...newChildren);
    },

    // ── Attributes ────────────────────────────────────────────────────────
    get id() {
      return raw.attrs?.id || "";
    },
    set id(v) {
      if (!raw.attrs) raw.attrs = {};
      raw.attrs.id = String(v);
    },
    get className() {
      return raw.attrs?.class || "";
    },
    set className(v) {
      if (!raw.attrs) raw.attrs = {};
      raw.attrs.class = String(v);
    },
    get classList() {
      if (!raw.attrs) raw.attrs = {};
      return makeClassList(raw);
    },
    get dataset() {
      if (!raw.attrs) raw.attrs = {};
      return makeDataset(raw);
    },
    get style() {
      if (!raw.attrs) raw.attrs = {};
      return makeStyle(raw);
    },
    get href() {
      return raw.attrs?.href || "";
    },
    set href(v) {
      if (!raw.attrs) raw.attrs = {};
      raw.attrs.href = String(v);
    },
    get src() {
      return raw.attrs?.src || "";
    },
    set src(v) {
      if (!raw.attrs) raw.attrs = {};
      raw.attrs.src = String(v);
    },
    get value() {
      return raw.attrs?.value || "";
    },
    set value(v) {
      if (!raw.attrs) raw.attrs = {};
      raw.attrs.value = String(v);
    },
    get type() {
      return raw.attrs?.type || "";
    },
    set type(v) {
      if (!raw.attrs) raw.attrs = {};
      raw.attrs.type = String(v);
    },
    get name() {
      return raw.attrs?.name || "";
    },
    set name(v) {
      if (!raw.attrs) raw.attrs = {};
      raw.attrs.name = String(v);
    },
    get checked() {
      return raw.attrs && "checked" in raw.attrs;
    },
    set checked(v) {
      if (!raw.attrs) raw.attrs = {};
      if (v) raw.attrs.checked = "";
      else delete raw.attrs.checked;
    },
    get disabled() {
      return raw.attrs && "disabled" in raw.attrs;
    },
    set disabled(v) {
      if (!raw.attrs) raw.attrs = {};
      if (v) raw.attrs.disabled = "";
      else delete raw.attrs.disabled;
    },

    getAttribute(name) {
      return raw.attrs ? (raw.attrs[name] ?? null) : null;
    },
    setAttribute(name, value) {
      if (!raw.attrs) raw.attrs = {};
      raw.attrs[name] = String(value);
    },
    removeAttribute(name) {
      if (raw.attrs) delete raw.attrs[name];
    },
    hasAttribute(name) {
      return !!(raw.attrs && name in raw.attrs);
    },
    getAttributeNames() {
      return raw.attrs ? Object.keys(raw.attrs) : [];
    },
    toggleAttribute(name, force) {
      if (force === true || (force === undefined && !this.hasAttribute(name))) {
        this.setAttribute(name, "");
        return true;
      } else {
        this.removeAttribute(name);
        return false;
      }
    },

    // ── Tree mutation ─────────────────────────────────────────────────────
    appendChild(child) {
      const c = child._raw || child;
      if (c.parent) {
        const old = c.parent.children;
        c.parent.children = old.filter((x) => x !== c);
      }
      c.parent = raw;
      if (!raw.children) raw.children = [];
      raw.children.push(c);
      return child;
    },
    removeChild(child) {
      const c = child._raw || child;
      if (!raw.children) return child;
      raw.children = raw.children.filter((x) => x !== c);
      c.parent = null;
      return child;
    },
    replaceChild(newChild, oldChild) {
      const nc = newChild._raw || newChild;
      const oc = oldChild._raw || oldChild;
      if (!raw.children) return oldChild;
      const idx = raw.children.indexOf(oc);
      if (idx !== -1) {
        if (nc.parent) nc.parent.children = nc.parent.children.filter((x) => x !== nc);
        nc.parent = raw;
        raw.children[idx] = nc;
        oc.parent = null;
      }
      return oldChild;
    },
    insertBefore(newNode, refNode) {
      const nn = newNode._raw || newNode;
      const rn = refNode ? refNode._raw || refNode : null;
      if (!raw.children) raw.children = [];
      if (nn.parent) nn.parent.children = nn.parent.children.filter((x) => x !== nn);
      nn.parent = raw;
      if (!rn) {
        raw.children.push(nn);
      } else {
        const idx = raw.children.indexOf(rn);
        if (idx !== -1) raw.children.splice(idx, 0, nn);
        else raw.children.push(nn);
      }
      return newNode;
    },
    prepend(...nodes) {
      nodes.reverse().forEach((n) => {
        const nn = typeof n === "string" ? { type: "text", value: n, parent: raw } : n._raw || n;
        if (nn.parent) nn.parent.children = nn.parent.children.filter((x) => x !== nn);
        nn.parent = raw;
        if (!raw.children) raw.children = [];
        raw.children.unshift(nn);
      });
    },
    append(...nodes) {
      nodes.forEach((n) => {
        const nn = typeof n === "string" ? { type: "text", value: n, parent: raw } : n._raw || n;
        if (nn.parent) nn.parent.children = nn.parent.children.filter((x) => x !== nn);
        nn.parent = raw;
        if (!raw.children) raw.children = [];
        raw.children.push(nn);
      });
    },
    before(...nodes) {
      if (!raw.parent) return;
      const idx = raw.parent.children.indexOf(raw);
      nodes.forEach((n, i) => {
        const nn =
          typeof n === "string" ? { type: "text", value: n, parent: raw.parent } : n._raw || n;
        nn.parent = raw.parent;
        raw.parent.children.splice(idx + i, 0, nn);
      });
    },
    after(...nodes) {
      if (!raw.parent) return;
      const idx = raw.parent.children.indexOf(raw) + 1;
      nodes.forEach((n, i) => {
        const nn =
          typeof n === "string" ? { type: "text", value: n, parent: raw.parent } : n._raw || n;
        nn.parent = raw.parent;
        raw.parent.children.splice(idx + i, 0, nn);
      });
    },
    remove() {
      if (!raw.parent) return;
      raw.parent.children = raw.parent.children.filter((x) => x !== raw);
      raw.parent = null;
    },
    cloneNode(deep = false) {
      const clone = JSON.parse(JSON.stringify(raw));
      clone._domWrapper = undefined;
      if (!deep) clone.children = [];
      // Fix parent refs
      walk(clone, (n) => {
        if (n.children)
          n.children.forEach((c) => {
            c.parent = n;
          });
      });
      return wrapNode(clone, docWrapper);
    },
    contains(other) {
      const o = other?._raw || other;
      let cur = o;
      while (cur) {
        if (cur === raw) return true;
        cur = cur.parent;
      }
      return false;
    },
    hasChildNodes() {
      return !!(raw.children && raw.children.length > 0);
    },
    normalize() {
      // Merge adjacent text nodes
      if (!raw.children) return;
      const merged = [];
      for (const c of raw.children) {
        if (c.type === "text" && merged.length && merged[merged.length - 1].type === "text") {
          merged[merged.length - 1].value += c.value;
        } else {
          merged.push(c);
        }
      }
      raw.children = merged;
    },

    // ── Query ─────────────────────────────────────────────────────────────
    querySelector(sel) {
      const found = querySelector(raw, sel);
      return found ? wrapNode(found, docWrapper) : null;
    },
    querySelectorAll(sel) {
      return querySelectorAll(raw, sel).map((n) => wrapNode(n, docWrapper));
    },
    getElementsByTagName(tag) {
      const t = tag === "*" ? null : tag.toLowerCase();
      return findAll(raw, (n) => t === null || n.name === t).map((n) => wrapNode(n, docWrapper));
    },
    getElementsByClassName(cls) {
      const classes = cls.split(/\s+/);
      return findAll(raw, (n) => {
        if (!n.attrs?.class) return false;
        const nodeClasses = n.attrs.class.split(/\s+/);
        return classes.every((c) => nodeClasses.includes(c));
      }).map((n) => wrapNode(n, docWrapper));
    },
    closest(sel) {
      let cur = raw;
      while (cur && cur.type === "element") {
        if (matchesSelector(cur, sel)) return wrapNode(cur, docWrapper);
        cur = cur.parent;
      }
      return null;
    },
    matches(sel) {
      return matchesSelector(raw, sel);
    },

    // ── Events ────────────────────────────────────────────────────────────
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),

    // ── Misc ──────────────────────────────────────────────────────────────
    get hidden() {
      return raw.attrs && "hidden" in raw.attrs;
    },
    set hidden(v) {
      if (!raw.attrs) raw.attrs = {};
      if (v) raw.attrs.hidden = "";
      else delete raw.attrs.hidden;
    },
    get tabIndex() {
      return parseInt(raw.attrs?.tabindex ?? "-1", 10);
    },
    set tabIndex(v) {
      if (!raw.attrs) raw.attrs = {};
      raw.attrs.tabindex = String(v);
    },
    focus() {},
    blur() {},
    click() {
      events.dispatchEvent({ type: "click" });
    },
    scrollIntoView() {},
    getBoundingClientRect() {
      return { top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 };
    },
    getClientRects() {
      return [];
    },
    insertAdjacentHTML(position, html) {
      const tokens = tokenize(html);
      const frag = parse(tokens);
      const body = findFirst(frag, (n) => n.name === "body");
      const nodes = (body ? body.children : frag.children).map((c) => {
        c.parent = null;
        return c;
      });
      if (position === "beforebegin") this.before(...nodes.map(wrapNode));
      else if (position === "afterbegin")
        this.prepend(...nodes.map((n) => wrapNode(n, docWrapper)));
      else if (position === "beforeend") this.append(...nodes.map((n) => wrapNode(n, docWrapper)));
      else if (position === "afterend") this.after(...nodes.map((n) => wrapNode(n, docWrapper)));
    },
    insertAdjacentElement(position, el) {
      if (position === "beforebegin") this.before(el);
      else if (position === "afterbegin") this.prepend(el);
      else if (position === "beforeend") this.append(el);
      else if (position === "afterend") this.after(el);
      return el;
    },
    toString() {
      return `[object HTMLElement]`;
    },
  };

  raw._domWrapper = wrapper;
  return wrapper;
}

// ─── Document wrapper ─────────────────────────────────────────────────────────

/**
 * Create the document object exposed to page scripts.
 * This is the main entry point — scripts access everything through document.
 */
function createDocument(rawDoc) {
  const events = makeEventTarget();
  let docWrapper;

  const htmlEl = findFirst(rawDoc, (n) => n.name === "html");
  const headEl = findFirst(rawDoc, (n) => n.name === "head");
  const bodyEl = findFirst(rawDoc, (n) => n.name === "body");

  docWrapper = {
    _raw: rawDoc,
    nodeType: NodeType.DOCUMENT_NODE,
    nodeName: "#document",

    // ── Key elements ─────────────────────────────────────────────────────
    get documentElement() {
      return htmlEl ? wrapNode(htmlEl, docWrapper) : null;
    },
    get head() {
      return headEl ? wrapNode(headEl, docWrapper) : null;
    },
    get body() {
      return bodyEl ? wrapNode(bodyEl, docWrapper) : null;
    },
    get childNodes() {
      return (rawDoc.children || []).map((c) => wrapNode(c, docWrapper));
    },
    get children() {
      return (rawDoc.children || [])
        .filter((c) => c.type === "element")
        .map((c) => wrapNode(c, docWrapper));
    },

    get title() {
      const titleEl = findFirst(rawDoc, (n) => n.name === "title");
      return titleEl ? getTextContent(titleEl) : "";
    },
    set title(v) {
      let titleEl = findFirst(rawDoc, (n) => n.name === "title");
      if (!titleEl) {
        titleEl = makeElement("title", {});
        if (headEl) headEl.children.unshift(titleEl);
      }
      setTextContent(titleEl, v);
    },

    get cookie() {
      return "";
    },
    set cookie(_) {},
    get readyState() {
      return "complete";
    },
    get compatMode() {
      return "CSS1Compat";
    },
    get characterSet() {
      return "UTF-8";
    },
    get contentType() {
      return "text/html";
    },
    get URL() {
      return "";
    }, // filled in by sandbox with real URL
    get location() {
      return null;
    }, // filled in by sandbox

    // ── Creation ──────────────────────────────────────────────────────────
    createElement(tag) {
      const el = makeElement(tag.toLowerCase(), {});
      return wrapNode(el, docWrapper);
    },
    createElementNS(_ns, tag) {
      return docWrapper.createElement(tag);
    },
    createTextNode(text) {
      return wrapNode(
        { type: "text", value: String(text), parent: null, children: [] },
        docWrapper,
      );
    },
    createComment(text) {
      return wrapNode(
        { type: "comment", value: String(text), parent: null, children: [] },
        docWrapper,
      );
    },
    createDocumentFragment() {
      const frag = { type: "fragment", children: [], parent: null };
      return wrapNode(frag, docWrapper);
    },

    // ── Query ─────────────────────────────────────────────────────────────
    getElementById(id) {
      const found = findFirst(rawDoc, (n) => n.type === "element" && n.attrs?.id === id);
      return found ? wrapNode(found, docWrapper) : null;
    },
    getElementsByTagName(tag) {
      const t = tag === "*" ? null : tag.toLowerCase();
      return findAll(rawDoc, (n) => t === null || n.name === t).map((n) => wrapNode(n, docWrapper));
    },
    getElementsByClassName(cls) {
      const classes = cls.split(/\s+/);
      return findAll(rawDoc, (n) => {
        if (!n.attrs?.class) return false;
        const nc = n.attrs.class.split(/\s+/);
        return classes.every((c) => nc.includes(c));
      }).map((n) => wrapNode(n, docWrapper));
    },
    getElementsByName(name) {
      return findAll(rawDoc, (n) => n.attrs?.name === name).map((n) => wrapNode(n, docWrapper));
    },
    querySelector(sel) {
      const found = querySelector(rawDoc, sel);
      return found ? wrapNode(found, docWrapper) : null;
    },
    querySelectorAll(sel) {
      return querySelectorAll(rawDoc, sel).map((n) => wrapNode(n, docWrapper));
    },

    // ── Events ────────────────────────────────────────────────────────────
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),

    // ── Write (stub — some frameworks call document.write during boot) ────
    write(html) {
      setInnerHTML(
        bodyEl || rawDoc,
        (bodyEl ? bodyEl.children.map(serializeNode).join("") : "") + html,
      );
    },
    writeln(html) {
      docWrapper.write(`${html}\n`);
    },
    open() {},
    close() {},

    // ── Misc ──────────────────────────────────────────────────────────────
    createRange() {
      return {
        setStart() {},
        setEnd() {},
        selectNodeContents() {},
        collapse() {},
        toString() {
          return "";
        },
        getBoundingClientRect() {
          return { top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 };
        },
      };
    },
    createTreeWalker(root) {
      // Minimal TreeWalker
      const nodes = [];
      walk(root._raw || root, (n) => nodes.push(n));
      let idx = 0;
      return {
        nextNode: () => (idx < nodes.length ? wrapNode(nodes[idx++], docWrapper) : null),
      };
    },
    getSelection() {
      return null;
    },
    hasFocus() {
      return false;
    },
    execCommand() {
      return false;
    },
    ownerDocument: null,

    toString() {
      return "[object HTMLDocument]";
    },
  };

  return docWrapper;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Given a raw document tree (from parser), return a DOM-compatible
 * { document, serialize } pair ready to hand to the sandbox.
 */
function createDOM(rawDoc) {
  const document = createDocument(rawDoc);

  function serialize() {
    return serializeNode(rawDoc);
  }

  return { document, serialize };
}

module.exports = {
  createDOM,
  serializeNode,
  matchesSelector,
  querySelector,
  querySelectorAll,
};
