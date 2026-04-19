/**
 * frenderer/src/parser.js
 *
 * Phase 2: HTML Parser
 *
 * Consumes the flat token stream from the tokenizer and builds a nested
 * node tree — the in-memory representation of the document.
 *
 * Node shapes:
 *
 *   Document:
 *     { type: 'document', children: Node[] }
 *
 *   Element:
 *     { type: 'element', name: string, attrs: {[key]: string},
 *       children: Node[], parent: Node|null, selfClosing: bool }
 *
 *   Text:
 *     { type: 'text', value: string, parent: Node|null }
 *
 *   Comment:
 *     { type: 'comment', value: string, parent: Node|null }
 *
 *   Doctype:
 *     { type: 'doctype', value: string }
 *
 * Handles:
 *   - Implicit <html>, <head>, <body> insertion (like real browsers)
 *   - Auto-closing of certain tags (<p> closes before another <p>, etc.)
 *   - Proper head vs body element routing
 *   - Orphaned end tags (ignored gracefully)
 *   - Void / self-closing elements (never pushed onto stack)
 *   - Raw text elements (<script>, <style>) — content is a single text child
 */

"use strict";

const { VOID_ELEMENTS } = require("./tokenizer");

// Elements that belong in <head>
const HEAD_ELEMENTS = new Set([
  "base",
  "link",
  "meta",
  "noscript",
  "script",
  "style",
  "template",
  "title",
]);

// Elements that auto-close when they see a sibling of the same (or related) type
// Maps tag name → set of tags that force it closed
const AUTO_CLOSE = {
  p: new Set([
    "p",
    "div",
    "ul",
    "ol",
    "table",
    "blockquote",
    "pre",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "form",
    "hr",
  ]),
  li: new Set(["li"]),
  dt: new Set(["dt", "dd"]),
  dd: new Set(["dt", "dd"]),
  tr: new Set(["tr"]),
  td: new Set(["td", "th"]),
  th: new Set(["td", "th"]),
  thead: new Set(["tbody", "tfoot"]),
  tbody: new Set(["tbody", "tfoot", "thead"]),
  tfoot: new Set(["tbody", "thead"]),
  option: new Set(["option", "optgroup"]),
};

// ─── Node factories ───────────────────────────────────────────────────────────

function makeDocument() {
  return { type: "document", children: [] };
}

function makeElement(name, attrs, selfClosing = false) {
  return {
    type: "element",
    name,
    attrs,
    children: [],
    parent: null,
    selfClosing,
  };
}

function makeText(value) {
  return { type: "text", value, parent: null };
}

function makeComment(value) {
  return { type: "comment", value, parent: null };
}

function makeDoctype(value) {
  return { type: "doctype", value };
}

// ─── Tree helpers ─────────────────────────────────────────────────────────────

function appendChild(parent, child) {
  child.parent = parent;
  parent.children.push(child);
}

// ─── Parser ───────────────────────────────────────────────────────────────────

/**
 * Parse a flat token array into a document node tree.
 * @param {Array<Object>} tokens  — output of tokenize()
 * @returns {Object}              — document node
 */
function parse(tokens) {
  const document = makeDocument();

  // Open element stack — tracks nesting
  // We always start by implicitly creating <html>, <head>, <body>
  const htmlEl = makeElement("html", {});
  const headEl = makeElement("head", {});
  const bodyEl = makeElement("body", {});

  appendChild(document, htmlEl);
  appendChild(htmlEl, headEl);
  appendChild(htmlEl, bodyEl);

  // The stack represents the current open element ancestry.
  // We begin with body as the default insertion point.
  const stack = [document, htmlEl, bodyEl];

  // Pointer to current open element (top of stack)
  function current() {
    return stack[stack.length - 1];
  }

  // Whether we've seen an explicit <head> or <body> tag yet
  let inExplicitHead = false;

  // ── Helpers ────────────────────────────────────────────────────────────────

  // Find the nearest ancestor of a given tag name on the stack
  function findOnStack(name) {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].name === name) return i;
    }
    return -1;
  }

  // Auto-close tags that should be closed before inserting newName
  function autoClose(newName) {
    const top = current();
    if (!top?.name) return;
    const closeSet = AUTO_CLOSE[top.name];
    if (closeSet?.has(newName)) {
      stack.pop();
    }
  }

  // ── Main token loop ────────────────────────────────────────────────────────

  for (const token of tokens) {
    switch (token.type) {
      case "doctype": {
        const dt = makeDoctype(token.value);
        dt.parent = document;
        document.children.unshift(dt);
        break;
      }

      case "text": {
        // Skip pure-whitespace text nodes between structural elements
        // (between <html><head><body> etc) to keep tree clean
        const isWhitespaceOnly = /^\s*$/.test(token.value);
        const cur = current();
        if (isWhitespaceOnly && cur.type === "document") break;
        appendChild(cur, makeText(token.value));
        break;
      }

      case "comment": {
        appendChild(current(), makeComment(token.value));
        break;
      }

      case "start_tag": {
        const { name, attrs, selfClosing } = token;

        // ── Special structural tags ──────────────────────────────────────
        if (name === "html") {
          // Merge attrs onto the already-created htmlEl, don't push again
          Object.assign(htmlEl.attrs, attrs);
          break;
        }

        if (name === "head") {
          inExplicitHead = true;
          Object.assign(headEl.attrs, attrs);
          // Trim stack to sit inside html, then push head
          const htmlIdx = findOnStack("html");
          stack.splice(htmlIdx + 1);
          stack.push(headEl);
          break;
        }

        if (name === "body") {
          inExplicitHead = false;
          Object.assign(bodyEl.attrs, attrs);
          // Trim stack to sit inside html, then push body
          const htmlIdx = findOnStack("html");
          stack.splice(htmlIdx + 1);
          stack.push(bodyEl);
          break;
        }

        // ── Auto-closing ─────────────────────────────────────────────────
        autoClose(name);

        // ── Head element routing ─────────────────────────────────────────
        // If we see a head-only element and body hasn't started yet,
        // insert into head
        if (HEAD_ELEMENTS.has(name) && !inExplicitHead) {
          const headIdx = findOnStack("head");
          // Only reroute if body is empty (we're still in head territory)
          if (headIdx !== -1 && bodyEl.children.length === 0) {
            stack.splice(headIdx + 1);
            const el = makeElement(name, attrs, selfClosing);
            appendChild(headEl, el);
            if (!selfClosing && !VOID_ELEMENTS.has(name)) {
              stack.push(el);
            }
            break;
          }
        }

        // ── Normal element ───────────────────────────────────────────────
        const el = makeElement(name, attrs, selfClosing);
        appendChild(current(), el);

        // Void and self-closing elements don't go on the stack
        if (!selfClosing && !VOID_ELEMENTS.has(name)) {
          stack.push(el);
        }
        break;
      }

      case "end_tag": {
        const { name } = token;

        // Ignore end tags for void elements
        if (VOID_ELEMENTS.has(name)) break;

        // Special: </head> — pop back to html level, body becomes current
        if (name === "head") {
          inExplicitHead = false;
          const headIdx = findOnStack("head");
          if (headIdx !== -1) {
            stack.splice(headIdx + 1);
            // Now we're sitting at html level; push body as insertion point
            if (findOnStack("body") === -1) {
              stack.push(bodyEl);
            }
          }
          break;
        }

        // Find the matching open tag on the stack
        const idx = findOnStack(name);
        if (idx === -1) {
          // Orphaned end tag — ignore it
          break;
        }

        // Pop everything up to and including the matched tag
        stack.splice(idx);
        break;
      }
    }
  }

  return document;
}

// ─── Utility: find elements in tree ──────────────────────────────────────────

/**
 * Walk the tree depth-first, calling visitor(node) on every node.
 * Return false from visitor to stop traversal.
 */
function walk(node, visitor) {
  const result = visitor(node);
  if (result === false) return false;
  if (node.children) {
    for (const child of node.children) {
      if (walk(child, visitor) === false) return false;
    }
  }
}

/**
 * Find all element nodes matching a predicate.
 */
function findAll(root, predicate) {
  const results = [];
  walk(root, (node) => {
    if (node.type === "element" && predicate(node)) results.push(node);
  });
  return results;
}

/**
 * Find the first element matching a predicate.
 */
function findFirst(root, predicate) {
  let found = null;
  walk(root, (node) => {
    if (node.type === "element" && predicate(node)) {
      found = node;
      return false; // stop
    }
  });
  return found;
}

module.exports = {
  parse,
  walk,
  findAll,
  findFirst,
  makeElement,
  makeText,
  appendChild,
};
