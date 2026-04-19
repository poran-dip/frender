/**
 * frenderer/src/tokenizer.js
 *
 * Phase 1: HTML Tokenizer
 *
 * Reads raw HTML character by character using a state machine and emits
 * a flat array of tokens. No recursion, no regex — just a switch on state.
 *
 * Token types:
 *   { type: 'doctype',       value: string }
 *   { type: 'start_tag',     name: string, attrs: {[key]: string}, selfClosing: bool }
 *   { type: 'end_tag',       name: string }
 *   { type: 'text',          value: string }
 *   { type: 'comment',       value: string }
 *
 * Handles:
 *   - Quoted and unquoted attribute values
 *   - Self-closing tags (<br />, <img />)
 *   - Void elements (treated as self-closing even without /)
 *   - Raw text elements (<script>, <style>) — no tag parsing inside them
 *   - HTML comments <!-- -->
 *   - Doctype declarations
 *   - Malformed HTML (best-effort, won't throw)
 */

"use strict";

// Elements whose content is raw text — we don't tokenize inside them
const RAW_TEXT_ELEMENTS = new Set(["script", "style", "textarea", "title"]);

// Void elements — never have children, self-close implicitly
const VOID_ELEMENTS = new Set([
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

// Tokenizer states
const S = {
  TEXT: "TEXT",
  TAG_OPEN: "TAG_OPEN",
  END_TAG_OPEN: "END_TAG_OPEN",
  TAG_NAME: "TAG_NAME",
  END_TAG_NAME: "END_TAG_NAME",
  BEFORE_ATTR_NAME: "BEFORE_ATTR_NAME",
  ATTR_NAME: "ATTR_NAME",
  AFTER_ATTR_NAME: "AFTER_ATTR_NAME",
  BEFORE_ATTR_VALUE: "BEFORE_ATTR_VALUE",
  ATTR_VALUE_DOUBLE: "ATTR_VALUE_DOUBLE",
  ATTR_VALUE_SINGLE: "ATTR_VALUE_SINGLE",
  ATTR_VALUE_UNQUOTED: "ATTR_VALUE_UNQUOTED",
  SELF_CLOSING: "SELF_CLOSING",
  COMMENT_START: "COMMENT_START",
  COMMENT: "COMMENT",
  COMMENT_END_DASH: "COMMENT_END_DASH",
  COMMENT_END: "COMMENT_END",
  DOCTYPE: "DOCTYPE",
  RAW_TEXT: "RAW_TEXT",
};

/**
 * Tokenize an HTML string into a flat array of tokens.
 * @param {string} input
 * @returns {Array<Object>}
 */
function tokenize(input) {
  const tokens = [];
  let state = S.TEXT;
  let i = 0;
  const len = input.length;

  // Buffers
  let text = "";
  let tagName = "";
  let attrName = "";
  let attrValue = "";
  let attrs = {};
  let selfClosing = false;
  let comment = "";
  let rawTextTag = ""; // which raw-text element we're inside

  function flushText() {
    if (text) {
      tokens.push({ type: "text", value: text });
      text = "";
    }
  }

  function flushAttr() {
    if (attrName) {
      attrs[attrName.toLowerCase()] = attrValue;
      attrName = "";
      attrValue = "";
    }
  }

  function emitStartTag() {
    flushAttr();
    const name = tagName.toLowerCase();
    const isSelfClosing = selfClosing || VOID_ELEMENTS.has(name);
    tokens.push({ type: "start_tag", name, attrs, selfClosing: isSelfClosing });
    // Reset
    tagName = "";
    attrs = {};
    selfClosing = false;
    return { name, isSelfClosing };
  }

  while (i < len) {
    const ch = input[i];

    switch (state) {
      // ── TEXT ──────────────────────────────────────────────────────────────
      case S.TEXT:
        if (ch === "<") {
          flushText();
          state = S.TAG_OPEN;
        } else {
          text += ch;
        }
        break;

      // ── TAG OPEN: we saw '<' ──────────────────────────────────────────────
      case S.TAG_OPEN:
        if (ch === "/") {
          state = S.END_TAG_OPEN;
        } else if (ch === "!") {
          // Could be comment <!-- or doctype <!DOCTYPE
          // Peek ahead
          const next = input.slice(i + 1, i + 3);
          if (next === "--") {
            i += 2; // skip '--'
            state = S.COMMENT;
            comment = "";
          } else if (input.slice(i + 1, i + 8).toUpperCase() === "DOCTYPE") {
            i += 7;
            state = S.DOCTYPE;
            text = "";
          } else {
            // Unknown <! — treat as text
            text += "<!";
            state = S.TEXT;
          }
        } else if (ch === "?") {
          // XML processing instruction — skip to >
          while (i < len && input[i] !== ">") i++;
          state = S.TEXT;
        } else if (isLetter(ch)) {
          tagName = ch;
          state = S.TAG_NAME;
        } else {
          // Bare '<' — not a tag, treat as text
          text += `<${ch}`;
          state = S.TEXT;
        }
        break;

      // ── END TAG: </tagname> ───────────────────────────────────────────────
      case S.END_TAG_OPEN:
        if (isLetter(ch)) {
          tagName = ch;
          state = S.END_TAG_NAME;
        } else {
          text += `</${ch}`;
          state = S.TEXT;
        }
        break;

      case S.END_TAG_NAME:
        if (ch === ">") {
          tokens.push({ type: "end_tag", name: tagName.toLowerCase() });
          tagName = "";
          state = S.TEXT;
        } else if (isWhitespace(ch)) {
          // ignore whitespace before >
        } else {
          tagName += ch;
        }
        break;

      // ── START TAG NAME ────────────────────────────────────────────────────
      case S.TAG_NAME:
        if (isWhitespace(ch)) {
          state = S.BEFORE_ATTR_NAME;
        } else if (ch === "/") {
          selfClosing = true;
          state = S.SELF_CLOSING;
        } else if (ch === ">") {
          const { name, isSelfClosing } = emitStartTag();
          if (!isSelfClosing && RAW_TEXT_ELEMENTS.has(name)) {
            rawTextTag = name;
            text = "";
            state = S.RAW_TEXT;
          } else {
            state = S.TEXT;
          }
        } else {
          tagName += ch;
        }
        break;

      // ── ATTRIBUTES ────────────────────────────────────────────────────────
      case S.BEFORE_ATTR_NAME:
        if (ch === ">") {
          const { name, isSelfClosing } = emitStartTag();
          if (!isSelfClosing && RAW_TEXT_ELEMENTS.has(name)) {
            rawTextTag = name;
            text = "";
            state = S.RAW_TEXT;
          } else {
            state = S.TEXT;
          }
        } else if (ch === "/") {
          selfClosing = true;
          state = S.SELF_CLOSING;
        } else if (!isWhitespace(ch)) {
          attrName = ch;
          state = S.ATTR_NAME;
        }
        break;

      case S.ATTR_NAME:
        if (ch === "=") {
          state = S.BEFORE_ATTR_VALUE;
        } else if (isWhitespace(ch)) {
          state = S.AFTER_ATTR_NAME;
        } else if (ch === ">") {
          flushAttr();
          const { name, isSelfClosing } = emitStartTag();
          if (!isSelfClosing && RAW_TEXT_ELEMENTS.has(name)) {
            rawTextTag = name;
            text = "";
            state = S.RAW_TEXT;
          } else {
            state = S.TEXT;
          }
        } else if (ch === "/") {
          flushAttr();
          selfClosing = true;
          state = S.SELF_CLOSING;
        } else {
          attrName += ch;
        }
        break;

      case S.AFTER_ATTR_NAME:
        if (ch === "=") {
          state = S.BEFORE_ATTR_VALUE;
        } else if (ch === ">") {
          flushAttr();
          const { name, isSelfClosing } = emitStartTag();
          if (!isSelfClosing && RAW_TEXT_ELEMENTS.has(name)) {
            rawTextTag = name;
            text = "";
            state = S.RAW_TEXT;
          } else {
            state = S.TEXT;
          }
        } else if (!isWhitespace(ch)) {
          flushAttr();
          attrName = ch;
          state = S.ATTR_NAME;
        }
        break;

      case S.BEFORE_ATTR_VALUE:
        if (ch === '"') {
          attrValue = "";
          state = S.ATTR_VALUE_DOUBLE;
        } else if (ch === "'") {
          attrValue = "";
          state = S.ATTR_VALUE_SINGLE;
        } else if (!isWhitespace(ch)) {
          attrValue = ch;
          state = S.ATTR_VALUE_UNQUOTED;
        }
        break;

      case S.ATTR_VALUE_DOUBLE:
        if (ch === '"') {
          flushAttr();
          state = S.BEFORE_ATTR_NAME;
        } else {
          attrValue += ch;
        }
        break;

      case S.ATTR_VALUE_SINGLE:
        if (ch === "'") {
          flushAttr();
          state = S.BEFORE_ATTR_NAME;
        } else {
          attrValue += ch;
        }
        break;

      case S.ATTR_VALUE_UNQUOTED:
        if (isWhitespace(ch)) {
          flushAttr();
          state = S.BEFORE_ATTR_NAME;
        } else if (ch === ">") {
          flushAttr();
          const { name, isSelfClosing } = emitStartTag();
          if (!isSelfClosing && RAW_TEXT_ELEMENTS.has(name)) {
            rawTextTag = name;
            text = "";
            state = S.RAW_TEXT;
          } else {
            state = S.TEXT;
          }
        } else {
          attrValue += ch;
        }
        break;

      // ── SELF-CLOSING: saw '/' inside a tag ───────────────────────────────
      case S.SELF_CLOSING:
        if (ch === ">") {
          emitStartTag(); // selfClosing already set to true
          state = S.TEXT;
        } else {
          // Malformed — treat / as part of attr
          selfClosing = false;
          attrName += "/";
          state = S.ATTR_NAME;
        }
        break;

      // ── COMMENT: <!-- ... --> ─────────────────────────────────────────────
      case S.COMMENT:
        if (ch === "-" && input[i + 1] === "-") {
          state = S.COMMENT_END_DASH;
          i++; // skip second '-'
        } else {
          comment += ch;
        }
        break;

      case S.COMMENT_END_DASH:
        if (ch === ">") {
          tokens.push({ type: "comment", value: comment });
          comment = "";
          state = S.TEXT;
        } else if (ch === "-") {
          // still in end sequence
        } else {
          comment += `--${ch}`;
          state = S.COMMENT;
        }
        break;

      // ── DOCTYPE ───────────────────────────────────────────────────────────
      case S.DOCTYPE:
        if (ch === ">") {
          tokens.push({ type: "doctype", value: text.trim() });
          text = "";
          state = S.TEXT;
        } else {
          text += ch;
        }
        break;

      // ── RAW TEXT: inside <script>, <style>, etc. ──────────────────────────
      // Don't parse tags inside — just look for </tagname>
      case S.RAW_TEXT: {
        const closeTag = `</${rawTextTag}`;
        if (ch === "<" && input.slice(i, i + closeTag.length).toLowerCase() === closeTag) {
          // Emit accumulated raw text
          if (text) {
            tokens.push({ type: "text", value: text });
            text = "";
          }
          // Emit the end tag
          tokens.push({ type: "end_tag", name: rawTextTag });
          // Skip past </tagname>
          i += closeTag.length;
          // Skip optional whitespace and '>'
          while (i < len && input[i] !== ">") i++;
          rawTextTag = "";
          state = S.TEXT;
        } else {
          text += ch;
        }
        break;
      }

      default:
        state = S.TEXT;
    }

    i++;
  }

  // Flush any remaining text
  flushText();

  return tokens;
}

// ─── Character helpers ────────────────────────────────────────────────────────

function isWhitespace(ch) {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f";
}

function isLetter(ch) {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z");
}

module.exports = { tokenize, VOID_ELEMENTS, RAW_TEXT_ELEMENTS };
