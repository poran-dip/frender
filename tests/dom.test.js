"use strict";

const { tokenize } = require("../src/tokenizer");
const { parse } = require("../src/parser");
const { createDOM } = require("../src/dom");

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

function dom(html) {
  return createDOM(parse(tokenize(html)));
}

console.log("\nDOM API Tests\n");

// 1. document.getElementById
{
  console.log("getElementById");
  const { document } = dom('<div id="root"><span id="child">hi</span></div>');
  assert("finds root", document.getElementById("root").tagName, "DIV");
  assert("finds child", document.getElementById("child").tagName, "SPAN");
  assert("missing returns null", document.getElementById("nope"), null);
}

// 2. querySelector
{
  console.log("querySelector");
  const { document } = dom(
    '<div class="container"><p class="text">hello</p><p class="text active">world</p></div>',
  );
  assert("by tag", document.querySelector("div").tagName, "DIV");
  assert("by class", document.querySelector(".text").textContent, "hello");
  assert("compound", document.querySelector(".text.active").textContent, "world");
  assert("missing", document.querySelector(".nope"), null);
}

// 3. querySelectorAll
{
  console.log("querySelectorAll");
  const { document } = dom('<ul><li>a</li><li class="x">b</li><li>c</li></ul>');
  assert("all li", document.querySelectorAll("li").length, 3);
  assert("by class", document.querySelectorAll(".x").length, 1);
}

// 4. Attribute get/set
{
  console.log("getAttribute / setAttribute");
  const { document } = dom('<a href="https://example.com" data-id="42">link</a>');
  const a = document.querySelector("a");
  assert("getAttribute", a.getAttribute("href"), "https://example.com");
  a.setAttribute("href", "https://new.com");
  assert("setAttribute", a.getAttribute("href"), "https://new.com");
  assert("hasAttribute true", a.hasAttribute("data-id"), true);
  a.removeAttribute("data-id");
  assert("removeAttribute", a.hasAttribute("data-id"), false);
}

// 5. classList
{
  console.log("classList");
  const { document } = dom('<div class="foo bar"></div>');
  const div = document.querySelector("div");
  assert("contains", div.classList.contains("foo"), true);
  div.classList.add("baz");
  assert("add", div.classList.contains("baz"), true);
  div.classList.remove("foo");
  assert("remove", div.classList.contains("foo"), false);
  div.classList.toggle("bar");
  assert("toggle off", div.classList.contains("bar"), false);
  div.classList.toggle("bar");
  assert("toggle on", div.classList.contains("bar"), true);
}

// 6. createElement + appendChild
{
  console.log("createElement + appendChild");
  const { document } = dom('<div id="root"></div>');
  const root = document.getElementById("root");
  const p = document.createElement("p");
  p.textContent = "injected";
  root.appendChild(p);
  assert("child appended", root.children.length, 1);
  assert("child content", root.querySelector("p").textContent, "injected");
}

// 7. innerHTML get/set
{
  console.log("innerHTML");
  const { document } = dom('<div id="root"></div>');
  const root = document.getElementById("root");
  root.innerHTML = '<span class="inner">hello</span><span>world</span>';
  assert("innerHTML children", root.children.length, 2);
  assert("innerHTML querySelector", root.querySelector(".inner").textContent, "hello");
  assert("innerHTML get", root.innerHTML.includes("<span"), true);
}

// 8. textContent set
{
  console.log("textContent set");
  const { document } = dom('<p id="p">old text</p>');
  const p = document.getElementById("p");
  p.textContent = "new text";
  assert("textContent updated", p.textContent, "new text");
}

// 9. removeChild + insertBefore
{
  console.log("removeChild + insertBefore");
  const { document } = dom('<ul><li id="a">a</li><li id="b">b</li></ul>');
  const ul = document.querySelector("ul");
  const a = document.getElementById("a");
  const b = document.getElementById("b");
  const c = document.createElement("li");
  c.textContent = "c";
  ul.insertBefore(c, b);
  assert("insertBefore order", ul.children.map((x) => x.textContent).join(","), "a,c,b");
  ul.removeChild(a);
  assert("removeChild", ul.children.length, 2);
  assert("remaining order", ul.children.map((x) => x.textContent).join(","), "c,b");
}

// 10. dataset
{
  console.log("dataset");
  const { document } = dom('<div data-user-id="42" data-role="admin"></div>');
  const div = document.querySelector("div");
  assert("dataset read camelCase", div.dataset.userId, "42");
  assert("dataset read role", div.dataset.role, "admin");
  div.dataset.score = "100";
  assert("dataset write", div.getAttribute("data-score"), "100");
}

// 11. DOM mutation reflected in serialize()
{
  console.log("serialize reflects mutations");
  const { document, serialize } = dom(
    '<!DOCTYPE html><html><head><title>Test</title></head><body><div id="root"></div></body></html>',
  );
  const root = document.getElementById("root");
  root.innerHTML = "<h1>Hello frenderer</h1>";
  const out = serialize();
  assert("h1 in output", out.includes("<h1>Hello frenderer</h1>"), true);
  assert("structure intact", out.includes("<title>Test</title>"), true);
}

// 12. Selector combinators
{
  console.log("Selector combinators");
  const { document } = dom('<div><section><p id="target">hi</p></section></div>');
  assert("descendant", document.querySelector("div p")?.id, "target");
  assert("child direct", document.querySelector("section > p")?.id, "target");
  assert("child miss", document.querySelector("div > p"), null);
}

// 13. :first-child, :last-child
{
  console.log("Pseudo-classes");
  const { document } = dom("<ul><li>a</li><li>b</li><li>c</li></ul>");
  assert(":first-child", document.querySelector("li:first-child").textContent, "a");
  assert(":last-child", document.querySelector("li:last-child").textContent, "c");
}

// 14. closest()
{
  console.log("closest");
  const { document } = dom('<div class="outer"><section><span id="s">x</span></section></div>');
  const span = document.getElementById("s");
  assert("closest div", span.closest("div").className, "outer");
  assert("closest section", span.closest("section").tagName, "SECTION");
  assert("closest miss", span.closest(".nope"), null);
}

// 15. document.title
{
  console.log("document.title");
  const { document } = dom("<html><head><title>My Page</title></head><body></body></html>");
  assert("get title", document.title, "My Page");
  document.title = "Updated";
  assert("set title", document.title, "Updated");
}

// 16. SPA simulation: render into #root
{
  console.log("SPA simulation");
  const { document, serialize } = dom(
    '<!DOCTYPE html><html><head></head><body><div id="root"></div></body></html>',
  );
  // Simulate what React/Vue would do
  const root = document.getElementById("root");
  const app = document.createElement("div");
  app.className = "app";
  const h1 = document.createElement("h1");
  h1.textContent = "Hello World";
  const p = document.createElement("p");
  p.setAttribute("data-rendered", "true");
  p.textContent = "Rendered by frenderer";
  app.appendChild(h1);
  app.appendChild(p);
  root.appendChild(app);
  const out = serialize();
  assert("app div in output", out.includes('class="app"'), true);
  assert("h1 in output", out.includes("<h1>Hello World</h1>"), true);
  assert("data attr in output", out.includes('data-rendered="true"'), true);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
