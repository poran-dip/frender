"use strict";

const { tokenize } = require("../src/tokenizer");
const { parse, findAll, findFirst } = require("../src/parser");

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

function p(html) {
  return parse(tokenize(html));
}

function el(doc, name) {
  return findFirst(doc, (n) => n.name === name);
}

console.log("\nParser Tests\n");

// 1. Document always has html/head/body
{
  console.log("Implicit structure");
  const doc = p("<p>hello</p>");
  assert("html exists", !!el(doc, "html"), true);
  assert("head exists", !!el(doc, "head"), true);
  assert("body exists", !!el(doc, "body"), true);
}

// 2. Nesting
{
  console.log("Nesting");
  const doc = p("<div><p>hi</p></div>");
  const div = el(doc, "div");
  assert("div has p child", div.children[0].name, "p");
  assert("p has text child", div.children[0].children[0].value, "hi");
}

// 3. Attributes
{
  console.log("Attributes");
  const doc = p('<div id="app" class="root"></div>');
  const div = el(doc, "div");
  assert("id attr", div.attrs.id, "app");
  assert("class attr", div.attrs.class, "root");
}

// 4. Void elements have no children pushed onto stack
{
  console.log("Void elements");
  const doc = p('<div><br><img src="x.png"><input type="text"><span>after</span></div>');
  // br, img, input are children of div — not parents of span
  const span = el(doc, "span");
  assert("span is child of div", span.parent.name, "div");
  assert("br is self-closing", el(doc, "br").selfClosing, true);
}

// 5. Auto-close: <p> closes before another <p>
{
  console.log("Auto-close <p>");
  const doc = p("<div><p>first<p>second</div>");
  const div = el(doc, "div");
  const ps = div.children.filter((c) => c.name === "p");
  assert("two sibling p tags", ps.length, 2);
  assert("first p text", ps[0].children[0].value, "first");
  assert("second p text", ps[1].children[0].value, "second");
}

// 6. Script goes to head (before body content)
{
  console.log("Head element routing");
  const doc = p("<html><head><script>var x=1</script></head><body><div></div></body></html>");
  const head = el(doc, "head");
  const script = head.children.find((c) => c.name === "script");
  assert("script in head", !!script, true);
}

// 7. Comments preserved
{
  console.log("Comments");
  const doc = p("<div><!-- a comment --></div>");
  const div = el(doc, "div");
  assert("comment node", div.children[0].type, "comment");
  assert("comment value", div.children[0].value, " a comment ");
}

// 8. Doctype
{
  console.log("Doctype");
  const doc = p("<!DOCTYPE html><html><body></body></html>");
  assert("doctype in document", doc.children[0].type, "doctype");
}

// 9. Orphaned end tags ignored
{
  console.log("Orphaned end tags");
  const doc = p("<div>hello</div></p></span>");
  const div = el(doc, "div");
  assert("div text intact", div.children[0].value, "hello");
  assert("no phantom p", !el(doc, "p"), true);
}

// 10. findAll utility
{
  console.log("findAll utility");
  const doc = p("<ul><li>a</li><li>b</li><li>c</li></ul>");
  const items = findAll(doc, (n) => n.name === "li");
  assert("finds all 3 li", items.length, 3);
}

// 11. Deep nesting
{
  console.log("Deep nesting");
  const doc = p("<div><section><article><p><strong>deep</strong></p></article></section></div>");
  const strong = el(doc, "strong");
  assert("strong text", strong.children[0].value, "deep");
  assert("strong parent", strong.parent.name, "p");
  assert("p parent", strong.parent.parent.name, "article");
}

// 12. Full SPA shell
{
  console.log("SPA shell (empty root div)");
  const doc = p(
    '<!DOCTYPE html><html><head><title>App</title><script src="bundle.js"></script></head><body><div id="root"></div></body></html>',
  );
  const root = findFirst(doc, (n) => n.name === "div" && n.attrs.id === "root");
  assert("root div found", !!root, true);
  assert("root div is empty", root.children.length, 0);
  const title = el(doc, "title");
  assert("title in head", title.parent.name, "head");
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
