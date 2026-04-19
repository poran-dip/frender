"use strict";

const { tokenize } = require("../src/tokenizer");

let passed = 0;
let failed = 0;

function assert(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}`);
    console.log(`    expected: ${e}`);
    console.log(`    actual:   ${a}`);
    failed++;
  }
}

console.log("\nTokenizer Tests\n");

// 1. Basic text
{
  console.log("Basic text");
  const t = tokenize("hello world");
  assert("single text token", t, [{ type: "text", value: "hello world" }]);
}

// 2. Simple tag
{
  console.log("Simple tag");
  const t = tokenize("<div></div>");
  assert("start + end tag", t, [
    { type: "start_tag", name: "div", attrs: {}, selfClosing: false },
    { type: "end_tag", name: "div" },
  ]);
}

// 3. Attributes
{
  console.log("Attributes");
  const t = tokenize("<a href=\"https://example.com\" class='link' data-x=foo>text</a>");
  assert("double-quoted attr", t[0].attrs.href, "https://example.com");
  assert("single-quoted attr", t[0].attrs.class, "link");
  assert("unquoted attr", t[0].attrs["data-x"], "foo");
}

// 4. Self-closing void elements
{
  console.log("Void elements");
  const t = tokenize('<br><img src="x.png" /><input type="text">');
  assert("br is self-closing", t[0].selfClosing, true);
  assert("img is self-closing", t[1].selfClosing, true);
  assert("input is self-closing", t[2].selfClosing, true);
}

// 5. Comment
{
  console.log("Comment");
  const t = tokenize("<!-- hello world -->");
  assert("comment token", t[0], { type: "comment", value: " hello world " });
}

// 6. Doctype
{
  console.log("Doctype");
  const t = tokenize("<!DOCTYPE html>");
  assert("doctype token", t[0], { type: "doctype", value: "html" });
}

// 7. Raw text: script tag (don't parse inner HTML)
{
  console.log("Raw text (script)");
  const t = tokenize("<script>if (a < b && c > d) { }</script>");
  assert("script start tag", t[0].name, "script");
  assert("script inner text preserved", t[1].value, "if (a < b && c > d) { }");
  assert("script end tag", t[2], { type: "end_tag", name: "script" });
}

// 8. Nested tags + text
{
  console.log("Nested tags");
  const t = tokenize("<div><p>Hello <strong>world</strong></p></div>");
  assert("token count", t.length, 8);
  assert("first tag", t[0].name, "div");
  assert("text content", t[2].value, "Hello ");
}

// 9. Malformed: bare < treated as text
{
  console.log("Malformed HTML");
  const t = tokenize("a < b");
  assert("bare < is text", t.map((x) => x.value).join(""), "a < b");
}

// 10. Full mini-document
{
  console.log("Mini document");
  const html = `<!DOCTYPE html><html><head><title>Test</title></head><body><div id="root"></div></body></html>`;
  const t = tokenize(html);
  const types = t.map((x) => x.type);
  assert("has doctype", types[0], "doctype");
  assert("has div", t.find((x) => x.name === "div")?.attrs?.id, "root");
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
