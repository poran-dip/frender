#!/usr/bin/env node
/**
 * frenderer/src/cli.js
 *
 * Phase 7: CLI
 *
 * Usage:
 *   frenderer <url> [options]
 *
 * Options:
 *   -o, --out <file>        Write output to file instead of stdout
 *   -t, --timeout <ms>      Max ms for the entire render   (default: 30000)
 *   -s, --settle <ms>       Ms to wait after scripts run   (default: 1000)
 *       --no-js             Skip JS execution (static fetch only)
 *       --script-timeout    Per-script execution timeout   (default: 5000)
 *   -H, --header <k:v>      Add a request header (repeatable)
 *   -v, --verbose           Show page console output + script errors
 *   -q, --quiet             Suppress all frenderer output except HTML
 *       --version           Print version and exit
 *   -h, --help              Print this help and exit
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { frenderer } = require("./index");
const { CLEAN_DEFAULTS, prettify } = require("./cleaner");

// ─── Helpers ──────────────────────────────────────────────────────────────────

const PKG = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));

function print(...args) {
  process.stderr.write(`${args.join("·")}\n`);
}
function die(msg, code = 1) {
  print(`\nfrenderer: ${msg}\n`);
  process.exit(code);
}

const HELP = `
frenderer v${PKG.version} — fetch and render JS-heavy pages without a browser

Usage:
  frenderer <url> [options]

Options:
  -o, --out <file>          Write HTML to file (default: stdout)
  -t, --timeout <ms>        Total render timeout in ms      (default: 30000)
  -s, --settle <ms>         Post-script settle time in ms   (default: 1000)
      --no-js               Skip JS — static HTML fetch only
      --script-timeout <ms> Per-script kill timeout in ms   (default: 5000)
  -H, --header <key:value>  Add request header (repeatable)
  -v, --verbose             Show page console.log + script errors
  -q, --quiet               No progress output (stdout = HTML only)
      --version             Print version
  -h, --help                Print this help

Examples:
  frenderer https://example.com
  frenderer https://example.com -o out.html
  frenderer https://example.com --no-js -q
  frenderer https://example.com -s 2000 -H "Cookie: session=abc"
  frenderer https://example.com --verbose 2>errors.log
`.trim();

// ─── Arg parser ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    url: null,
    out: null,
    timeout: 30000,
    settle: 1000,
    js: true,
    scriptTimeout: 5000,
    headers: {},
    verbose: false,
    quiet: false,
    clean: true,
    pretty: false,
  };

  let i = 0;
  while (i < args.length) {
    const a = args[i];
    switch (a) {
      case "-h":
      case "--help":
        print(HELP);
        process.exit(0);
        break;
      case "--version":
        print(`frenderer v${PKG.version}`);
        process.exit(0);
        break;
      case "-v":
      case "--verbose":
        opts.verbose = true;
        break;
      case "--text":
        opts.cleanTextOnly = true;
        break;
      case "-q":
      case "--quiet":
        opts.quiet = true;
        break;
      case "--no-clean":
        opts.clean = false;
        break;
      case "--no-js":
        opts.js = false;
        break;
      case "--attributes":
        opts.cleanAttributes = false;
        break;
      case "-o":
      case "--out":
        opts.out = args[++i];
        break;
      case "-t":
      case "--timeout":
        opts.timeout = parseInt(args[++i], 10);
        if (Number.isNaN(opts.timeout)) die("--timeout must be a number");
        break;
      case "-s":
      case "--settle":
        opts.settle = parseInt(args[++i], 10);
        if (Number.isNaN(opts.settle)) die("--settle must be a number");
        break;
      case "--script-timeout":
        opts.scriptTimeout = parseInt(args[++i], 10);
        if (Number.isNaN(opts.scriptTimeout)) die("--script-timeout must be a number");
        break;
      case "--pretty":
        opts.pretty = true;
        break;
      case "-H":
      case "--header": {
        const raw = args[++i];
        const colon = raw.indexOf(":");
        if (colon === -1) die(`Invalid header "${raw}" — expected "Key: Value"`);
        const key = raw.slice(0, colon).trim();
        const val = raw.slice(colon + 1).trim();
        opts.headers[key] = val;
        break;
      }
      default:
        if (a.startsWith("-")) die(`Unknown option: ${a}\nRun frenderer --help for usage.`);
        if (opts.url) die("Too many arguments — only one URL accepted.");
        opts.url = a;
    }
    i++;
  }

  return opts;
}

// ─── Progress output ──────────────────────────────────────────────────────────

function progress(quiet, ...args) {
  if (!quiet) print(...args);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv);

  if (!opts.url) {
    print(HELP);
    process.exit(1);
  }

  // Validate URL
  try {
    new URL(opts.url);
  } catch {
    die(`Invalid URL: ${opts.url}`);
  }

  // Propagate verbose flag to worker via env
  if (opts.verbose) process.env.frenderer_VERBOSE = "1";

  const startMs = Date.now();
  progress(opts.quiet, `\nfrenderer v${PKG.version}`);
  progress(opts.quiet, `  url      : ${opts.url}`);
  progress(opts.quiet, `  js       : ${opts.js}`);
  progress(opts.quiet, `  settle   : ${opts.settle}ms`);
  progress(opts.quiet, `  timeout  : ${opts.timeout}ms`);
  if (Object.keys(opts.headers).length) {
    progress(opts.quiet, `  headers  : ${JSON.stringify(opts.headers)}`);
  }
  progress(opts.quiet, "");

  try {
    progress(opts.quiet, "  fetching + rendering...");

    const html = await frenderer(opts.url, {
      timeout: opts.timeout,
      settle: opts.settle,
      js: opts.js,
      scriptTimeout: opts.scriptTimeout,
      headers: opts.headers,
      clean: {
        ...CLEAN_DEFAULTS,
        attributes: opts.cleanAttributes ?? true,
        textonly: opts.cleanTextOnly ?? false,
      },
    });

    const elapsed = ((Date.now() - startMs) / 1000).toFixed(2);
    const bytes = Buffer.byteLength(html, "utf8");
    progress(opts.quiet, `  done in ${elapsed}s — ${(bytes / 1024).toFixed(1)} KB\n`);

    let finalHtml = html;

    if (opts.cleanTextOnly) {
      // text mode: extractText already produces readable line-separated output,
      // --pretty here means compress further into clean paragraphs
      finalHtml = opts.pretty
        ? html.replace(/\n{2,}/g, "\n\n").trim() // normalize to max 1 blank line between paragraphs
        : html;
    }

    if (opts.pretty) {
      finalHtml = prettify(html);
    }

    if (opts.out) {
      fs.writeFileSync(opts.out, finalHtml, "utf8");
      progress(opts.quiet, `  saved → ${opts.out}\n`);
    } else {
      process.stdout.write(finalHtml);
      process.stdout.write("\n");
    }
  } catch (err) {
    die(`render failed: ${err.message}`);
  }
}

main();
