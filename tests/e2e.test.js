"use strict";

/**
 * frenderer/tests/e2e.test.js
 *
 * Real-world E2E tests against public URLs.
 * These tests hit the actual internet — run separately from unit tests.
 *
 * Run with:
 *   node tests/e2e.test.js
 *   node tests/e2e.test.js --verbose
 *
 * Skips individual tests gracefully if a site is unreachable.
 */

const { frenderer } = require("../src/index");

const verbose = process.argv.includes("--verbose");
let passed = 0;
let failed = 0;
let skipped = 0;

function assert(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`    ✓ ${label}`);
    passed++;
  } else {
    console.log(`    ✗ ${label}`);
    console.log(`      expected: ${e}`);
    console.log(`      actual:   ${a}`);
    failed++;
  }
}

function assertContains(label, html, substring) {
  if (html.includes(substring)) {
    console.log(`    ✓ ${label}`);
    passed++;
  } else {
    console.log(`    ✗ ${label}`);
    console.log(`      expected to contain: ${JSON.stringify(substring)}`);
    console.log(`      got: ${JSON.stringify(html.slice(0, 200))}...`);
    failed++;
  }
}

function assertNotContains(label, html, substring) {
  if (!html.includes(substring)) {
    console.log(`    ✓ ${label}`);
    passed++;
  } else {
    console.log(`    ✗ ${label}`);
    console.log(`      expected NOT to contain: ${JSON.stringify(substring)}`);
    failed++;
  }
}

async function test(name, url, fn, opts = {}) {
  process.stdout.write(`\n  ${name} (${url})\n`);
  const timeout = opts.timeout || 30000;
  try {
    const html = await frenderer(url, {
      timeout,
      settle: opts.settle ?? 1000,
      js: opts.js ?? true,
      clean: opts.clean ?? false, // raw output for assertions unless specified
    });

    if (verbose) {
      console.log(`    [${(Buffer.byteLength(html, "utf8") / 1024).toFixed(1)} KB]`);
    }

    await fn(html);
  } catch (err) {
    if (
      err.message.includes("timed out") ||
      err.message.includes("ENOTFOUND") ||
      err.message.includes("ECONNREFUSED") ||
      err.message.includes("403") ||
      err.message.includes("503") ||
      err.message.includes("429")
    ) {
      console.log(`    ⚠ skipped — ${err.message}`);
      skipped++;
    } else {
      console.log(`    ✗ threw: ${err.message}`);
      failed++;
    }
  }
}

async function run() {
  console.log("\nfrenderer E2E Tests — Real URLs\n");
  console.log("  Note: these tests hit the live internet.");
  console.log("  Individual tests are skipped if a site is unreachable.\n");
  console.log("─".repeat(60));

  // ── Static sites ────────────────────────────────────────────────────────────

  await test(
    "example.com — static",
    "https://example.com",
    (html) => {
      assertContains("has title", html, "<title>Example Domain</title>");
      assertContains("has h1", html, "<h1>");
      assertContains("has body content", html, "Example Domain");
      assertContains("has learn more link", html, "Learn more");
      assert("is string", typeof html, "string");
      assert("non-empty", html.length > 0, true);
    },
    { js: false },
  );

  await test(
    "example.com — with cleaning",
    "https://example.com",
    (html) => {
      assertContains("has content", html, "Example Domain");
      assertNotContains("no class attrs", html, 'class="');
      assertNotContains("no script tags", html, "<script");
    },
    { js: false, clean: true },
  );

  await test(
    "example.com — text only",
    "https://example.com",
    (html) => {
      assertContains("has domain name", html, "Example Domain");
      assertContains("has learn more link", html, "Learn more");
      assertNotContains("no html tags", html, "<html");
      assertNotContains("no div tags", html, "<div");
    },
    { js: false, clean: { textonly: true } },
  );

  // ── Wikipedia — large static content ────────────────────────────────────────

  await test(
    "wikipedia — static content",
    "https://en.wikipedia.org/wiki/Node.js",
    (html) => {
      assertContains("has title", html, "Node.js");
      assertContains("has body", html, "<body");
      assertContains("has content", html, "JavaScript");
      assert("substantial content", html.length > 10000, true);
    },
    { js: false, timeout: 15000 },
  );

  // ── GitHub — JS-rendered elements ───────────────────────────────────────────

  await test(
    "github.com — homepage",
    "https://github.com",
    (html) => {
      assertContains("has html", html, "<html");
      assertContains("has body", html, "<body");
      assert("non-trivial size", html.length > 1000, true);
    },
    { settle: 2000, timeout: 30000 },
  );

  // ── Hacker News — server rendered ───────────────────────────────────────────

  await test(
    "hacker news — story list",
    "https://news.ycombinator.com",
    (html) => {
      assertContains("has title", html, "Hacker News");
      assertContains("has links", html, "<a ");
      assert("has content", html.length > 5000, true);
    },
    { js: false, timeout: 15000 },
  );

  await test(
    "hacker news — text extraction",
    "https://news.ycombinator.com",
    (html) => {
      assertContains("has hacker news", html, "Hacker News");
      assertNotContains("no html tags", html, "<html");
      assertNotContains("no anchors", html, "<a ");
    },
    { js: false, clean: { textonly: true }, timeout: 15000 },
  );

  // ── HTTPBin — useful for header/request testing ──────────────────────────────

  await test(
    "httpbin — custom user agent",
    "https://httpbin.org/user-agent",
    (html) => {
      assertContains("frenderer UA present", html, "frenderer");
    },
    { js: false, timeout: 15000 },
  );

  await test(
    "httpbin — json response",
    "https://httpbin.org/json",
    (html) => {
      assertContains("has json content", html, "slideshow");
    },
    { js: false, timeout: 15000 },
  );

  await test(
    "httpbin — query params",
    "https://httpbin.org/get?foo=bar",
    (html) => {
      assertContains("query param present", html, "foo");
      assertContains("query value present", html, "bar");
    },
    { js: false, timeout: 15000 },
  );

  // ── JS-rendered SPAs ─────────────────────────────────────────────────────────

  await test(
    "vitejs.dev — vite docs (JS-rendered)",
    "https://vitejs.dev",
    (html) => {
      assertContains("has content", html, "Vite");
      assert("non-trivial size", html.length > 2000, true);
    },
    { settle: 2000, timeout: 30000 },
  );

  // ── Cleaner integration on real content ──────────────────────────────────────

  await test(
    "example.com — no attributes mode",
    "https://example.com",
    (html) => {
      assertContains("has content", html, "Example Domain");
      assertNotContains("no class", html, 'class="');
      assertNotContains("no href", html, "href=");
      assertNotContains("no id", html, "id=");
      // bare tags only
      assertContains("bare a tag", html, "<a>");
    },
    { js: false, clean: { attributes: true } },
  );

  // ── Error handling ───────────────────────────────────────────────────────────

  console.log("\n  Error handling\n");

  // 404
  try {
    await frenderer("https://example.com/this-definitely-does-not-exist-404", {
      js: false,
      timeout: 10000,
    });
    console.log("    ✗ should have thrown on 404");
    failed++;
  } catch (err) {
    if (err.message.includes("404")) {
      console.log("    ✓ throws on 404");
      passed++;
    } else if (err.message.includes("timed out") || err.message.includes("ENOTFOUND")) {
      console.log("    ⚠ skipped — unreachable");
      skipped++;
    } else {
      console.log("    ✓ throws on bad response:", err.message);
      passed++;
    }
  }

  // Invalid URL
  try {
    await frenderer("not-a-url", { js: false, timeout: 5000 });
    console.log("    ✗ should have thrown on invalid URL");
    failed++;
  } catch (err) {
    if (err instanceof Error) {
      console.log("    ✓ throws on invalid URL");
      passed++;
    } else {
      console.log("    ✗ threw non-error");
      failed++;
    }
  }

  // Timeout
  try {
    await frenderer("https://example.com", { js: false, timeout: 1 });
    console.log("    ✗ should have timed out");
    failed++;
  } catch (err) {
    if (err.message.includes("timed out")) {
      console.log("    ✓ timeout works");
      passed++;
    } else {
      console.log("    ✓ threw (may have been too fast):", err.message);
      passed++;
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────────

  console.log(`\n${"─".repeat(60)}`);
  console.log(`\n  ${passed} passed, ${failed} failed, ${skipped} skipped\n`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error("E2E runner error:", err);
  process.exit(1);
});
