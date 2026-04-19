/**
 * frenderer/src/cleaner.js
 *
 * Post-render HTML cleaner.
 * Strips noise from the serialized output — Tailwind classnames, aria labels,
 * data attributes, inline styles, script/style tags, etc.
 *
 * Operates on the raw HTML string (not the DOM tree) via targeted regex passes.
 * Fast, zero-dependency, runs after serialize() in the worker.
 *
 * Options (all default false unless --clean shorthand is used):
 *   class    — remove all class/className attributes
 *   aria     — remove all aria-* attributes
 *   data     — remove all data-* attributes
 *   style    — remove inline style attributes
 *   id       — remove id attributes
 *   scripts  — remove <script>...</script> blocks entirely
 *   styles   — remove <style>...</style> blocks + <link rel="stylesheet">
 *   comments — remove <!-- ... --> comments
 *   whitespace — collapse runs of whitespace / blank lines
 */

"use strict";

// ─── Individual strippers ─────────────────────────────────────────────────────

// Remove an attribute by name or pattern from all tags.
// Handles: attr="val", attr='val', attr=val, standalone attr (boolean)
function stripAttr(html, attrPattern) {
  // Match the attribute with optional value, surrounded by whitespace
  // Pattern: whitespace + attrname + optional(=value)
  return html.replace(new RegExp(`\\s+${attrPattern}(?:=(?:"[^"]*"|'[^']*'|[^\\s>]*))?`, "gi"), "");
}

// Remove all attributes matching a prefix (e.g. "aria-", "data-")
function stripAttrPrefix(html, prefix) {
  return html.replace(
    new RegExp(`\\s+${prefix}[\\w-]+(?:=(?:"[^"]*"|'[^']*'|[^\\s>]*))?`, "gi"),
    "",
  );
}

// Remove entire tag blocks including content: <tag ...>...</tag>
// Handles multiline, nested-safe for non-recursive tags (script, style)
function stripTagBlock(html, tagName) {
  return html.replace(new RegExp(`<${tagName}[^>]*>[\\s\\S]*?<\\/${tagName}>`, "gi"), "");
}

// Remove <!-- ... --> comments (including IE conditionals)
function stripComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, "");
}

// Collapse whitespace: trim blank lines, normalize indentation
function collapseWhitespace(html) {
  return html
    .replace(/\r\n/g, "\n") // normalize line endings
    .replace(/[ \t]+$/gm, "") // trailing whitespace on each line
    .replace(/\n{3,}/g, "\n\n") // max 2 consecutive blank lines
    .replace(/>\s{2,}</g, ">\n<") // collapse whitespace between tags
    .trim();
}

// Strip srcset entirely
function stripSrcset(html) {
  return stripAttr(html, "srcset");
}

// Decode Next.js (and similar) image optimizer URLs back to the original
// /_next/image?url=%2Flogo.jpg&w=64&q=75  →  /logo.jpg
function decodeImageUrls(html) {
  return html.replace(
    /src="(\/_next\/image\?url=([^"&]+)[^"]*)"/gi,
    (_, _full, encoded) => `src="${decodeURIComponent(encoded)}"`,
  );
}

// Strip layout-only img attributes
function stripImgNoise(html) {
  let out = html;
  out = stripAttr(out, "loading");
  out = stripAttr(out, "decoding");
  out = stripAttr(out, "width");
  out = stripAttr(out, "height");
  out = stripAttr(out, "fetchpriority");
  out = stripAttr(out, "sizes");
  return out;
}

// Replace <svg ...>...</svg> with a placeholder
function stripSvgs(html, placeholder = "") {
  return html.replace(/<svg[\s\S]*?<\/svg>/gi, placeholder);
}

// Trim long decimals to 2 decimal places
// e.g. 1.23456789 → 1.23, 0.987654321 → 0.99
function trimDecimals(html) {
  return html.replace(/style="([^"]*)"/gi, (_, styleContent) => {
    const trimmed = styleContent.replace(/\d+\.\d{3,}/g, (num) => parseFloat(num).toFixed(2));
    return `style="${trimmed}"`;
  });
}

// Strip ALL attributes from every tag, leaving bare elements
function stripAllAttributes(html) {
  return html.replace(/<([a-zA-Z][a-zA-Z0-9-]*)(?:\s[^>]*)?(\/?)>/g, "<$1$2>");
}

// Extract only text content, stripping all tags entirely
function extractText(html) {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/(script|style)>/gi, "") // remove script/style with content
    .replace(/<[^>]+>/g, " ") // replace tags with a space
    .replace(/&amp;/g, "&") // decode common HTML entities
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s{2,}/g, "\n") // collapse whitespace into newlines
    .replace(/\n{3,}/g, "\n\n") // max 2 consecutive blank lines
    .trim();
}

// ─── Clean option presets ─────────────────────────────────────────────────────

/**
 * Default --clean preset: strips the stuff that's always noise for scraping.
 * Leaves id, inline style, and comments intact.
 */
const CLEAN_DEFAULTS = {
  class: true, // Tailwind / CSS framework classnames
  aria: true, // aria-label, aria-hidden, aria-expanded...
  data: true, // data-reactroot, data-v-xxxxx, data-testid...
  style: false, // inline styles (sometimes carry layout info)
  id: false, // ids are often structurally meaningful
  scripts: true, // <script> blocks (already executed)
  styles: true, // <style> blocks + <link rel=stylesheet>
  comments: true, // HTML comments
  svg: true, // SVG icons
  srcset: true, // remove srcset, keep only src
  imgattrs: true, // strip width/height/loading/decoding/sizes
  imgurls: true, // decode Next.js/Vercel/Imgix optimizer URLs to originals
  decimals: true, // long verbose decimals
  whitespace: true, // collapse blank lines
  attributes: false, // when true, strips ALL attributes — overrides all individual attr options
  textonly: false,
};

// ─── Main cleaner ─────────────────────────────────────────────────────────────

/**
 * Clean rendered HTML by stripping noise attributes and tags.
 *
 * @param {string} html     — serialized HTML from serialize()
 * @param {Object} opts     — clean options (see CLEAN_DEFAULTS)
 * @returns {string}        — cleaned HTML
 */
function clean(html, opts = {}) {
  const o = { ...CLEAN_DEFAULTS, ...opts };
  let out = html;

  if (o.textonly) return extractText(out); // early return, nothing after this matters

  // Tag blocks first (before attribute stripping, cleaner regex surface)
  if (o.scripts) out = stripTagBlock(out, "script");
  if (o.styles) {
    out = stripTagBlock(out, "style");
    // <link rel="stylesheet"> and <link rel="preload" as="style">
    out = out.replace(/<link[^>]+rel=["']?(?:stylesheet|preload)["']?[^>]*>/gi, "");
    // <link> tags with as="style"
    out = out.replace(/<link[^>]+as=["']?style["']?[^>]*>/gi, "");
  }

  // Comments
  if (o.comments) out = stripComments(out);

  // Attributes
  if (o.attributes) out = stripAllAttributes(out);
  if (o.class) out = stripAttr(out, "class");
  if (o.aria) out = stripAttrPrefix(out, "aria-");
  if (o.data) out = stripAttrPrefix(out, "data-");
  if (o.style) out = stripAttr(out, "style");
  if (o.id) out = stripAttr(out, "id");

  // Images
  if (o.svg) out = stripSvgs(out);
  if (o.srcset) out = stripSrcset(out);
  if (o.imgattrs) out = stripImgNoise(out);
  if (o.imgurls) out = decodeImageUrls(out);

  // Decimals
  if (o.decimals) out = trimDecimals(out);

  // Whitespace
  if (o.whitespace) out = collapseWhitespace(out);

  return out;
}

/**
 * Parse clean option flags from CLI string args.
 * "--clean" alone → all defaults on
 * "--clean class,aria,scripts" → only those enabled
 * "--no-clean-id" style handled at CLI level
 *
 * @param {string|boolean} val — true | "class,aria,data" | "all"
 * @returns {Object|false}
 */
function parseCleanOpts(val) {
  if (!val) return false;
  // Already a plain object (passed directly from CLI code)
  if (typeof val === "object") return { ...CLEAN_DEFAULTS, ...val };
  if (val === true || val === "all") return { ...CLEAN_DEFAULTS };
  // comma-separated string: "class,aria,data"
  const keys = val
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const opts = Object.fromEntries(Object.keys(CLEAN_DEFAULTS).map((k) => [k, false]));
  for (const key of keys) {
    if (key in opts) opts[key] = true;
    else process.stderr.write(`[frenderer] unknown clean option: ${key}\n`);
  }
  return opts;
}

/**
 * Pretty-print HTML with proper indentation.
 * Used when outputting to .txt or when --pretty is passed.
 */
function prettify(html, indentChar = "  ") {
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
  const INLINE = new Set([
    "a",
    "abbr",
    "b",
    "bdi",
    "bdo",
    "br",
    "cite",
    "code",
    "data",
    "dfn",
    "em",
    "i",
    "kbd",
    "mark",
    "q",
    "s",
    "small",
    "span",
    "strong",
    "sub",
    "sup",
    "time",
    "u",
    "var",
    "wbr",
  ]);
  const PRE = new Set(["pre", "script", "style", "textarea"]);

  let depth = 0;
  let inPre = false;
  const indent = () => indentChar.repeat(depth);

  return (
    html
      // Split on tag boundaries, keeping the delimiters
      .split(/(<[^>]+>)/g)
      .reduce((out, token) => {
        if (!token) return out;

        // Raw text between tags
        if (!token.startsWith("<")) {
          const text = token.replace(/\s+/g, " ").trim();
          if (!text) return out;
          return out + (inPre ? token : `${indent()}${text}\n`);
        }

        const tagName = (token.match(/^<\/?([a-zA-Z][a-zA-Z0-9-]*)/) || [])[1]?.toLowerCase();
        if (!tagName) return out + token;

        const isClose = token.startsWith("</");
        const isSelf = VOID.has(tagName) || token.endsWith("/>");
        const isInline = INLINE.has(tagName);
        const isPre = PRE.has(tagName);

        if (isPre && !isClose) inPre = true;
        if (isPre && isClose) inPre = false;

        if (inPre) return out + token;

        if (isClose) {
          depth = Math.max(0, depth - 1);
          return·`${out}${indent()}${token}\n`;
        }

        const line = `${indent()}${token}\n`;
        if (!isSelf && !isInline) depth++;
        return out + line;
      }, "")
      .trim()
  );
}

module.exports = { clean, parseCleanOpts, CLEAN_DEFAULTS, prettify };
