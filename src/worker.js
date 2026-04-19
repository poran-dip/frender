/**
 * frender/src/worker.js
 * Orchestrates all phases inside the isolated worker thread.
 */

"use strict";

const { workerData, parentPort } = require("node:worker_threads");
const fetch = globalThis.fetch;

const { tokenize } = require("./tokenizer");
const { parse, findAll } = require("./parser");
const { createDOM } = require("./dom");
const { buildSandbox, runScript } = require("./sandbox");
const { clean, parseCleanOpts } = require("./cleaner");

const verbose = process.env.FRENDER_VERBOSE === "1";
const log = (...a) => {
  if (verbose) process.stderr.write(`[frender] ${a.join(" ")}\n`);
};

function resolveUrl(src, base) {
  try {
    return new URL(src, base).href;
  } catch {
    return null;
  }
}

async function fetchText(url, headers = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; frender/1.0)",
        Accept: "*/*",
        ...headers,
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

const SKIP_PATTERNS = [
  /google-analytics\.com/,
  /googletagmanager\.com/,
  /analytics\.js/,
  /gtag\//,
  /hotjar\.com/,
  /intercom\.io/,
  /clarity\.ms/,
  /segment\.com/,
  /fullstory\.com/,
  /heap\.io/,
  /mixpanel\.com/,
  /newrelic\.com/,
  /datadog-rum/,
  /sentry\.io/,
  /bugsnag\.com/,
  /logrocket\.com/,
  /facebook\.net\/.*\/fbevents/,
  /doubleclick\.net/,
  /adsbygoogle/,
  /ads\.js/,
];
const shouldSkip = (url) => SKIP_PATTERNS.some((p) => p.test(url));

async function settle(timerQueue, settleMs) {
  const deadline = Date.now() + settleMs;
  let rounds = 0;
  while (Date.now() < deadline && rounds < 20) {
    await Promise.resolve();
    await Promise.resolve();
    timerQueue.drain();
    await Promise.resolve();
    rounds++;
  }
}

async function run() {
  const { url, options } = workerData;
  const t0 = Date.now();

  try {
    // Phase 1+2
    log(`fetching page...`);
    const rawHtml = await fetchText(url, options.headers, options.timeout);
    log(`page fetched in ${Date.now() - t0}ms (${rawHtml.length} bytes)`);

    const tokens = tokenize(rawHtml);
    const tree = parse(tokens);
    const { document, serialize } = createDOM(tree);

    // Phase 4
    const sandboxFetch = (u, opts) => fetch(resolveUrl(u, url) || u, opts);
    const { context, timerQueue } = buildSandbox(document, url, sandboxFetch);

    if (options.js !== false) {
      const scriptNodes = findAll(
        tree,
        (n) =>
          n.name === "script" &&
          (!n.attrs.type || /javascript|module/.test(n.attrs.type)) &&
          !(n.attrs.type || "").startsWith("text/template") &&
          !(n.attrs.type || "").startsWith("text/html"),
      );

      // Separate inline and external scripts (must run inline in document order,
      // but we can fetch all external ones in parallel first)
      const externalSrcs = scriptNodes
        .filter((n) => n.attrs?.src)
        .map((n) => resolveUrl(n.attrs.src, url))
        .filter((u) => u && !shouldSkip(u));

      log(`fetching ${externalSrcs.length} external scripts in parallel...`);
      const tFetch = Date.now();

      // Fetch all external scripts in parallel with individual timeouts
      const fetchTimeoutMs = options.fetchTimeout || 10000;
      const fetched = new Map(
        await Promise.all(
          externalSrcs.map(async (scriptUrl) => {
            const tScript = Date.now();
            try {
              const code = await fetchText(scriptUrl, {}, fetchTimeoutMs);
              log(`  fetched ${scriptUrl} in ${Date.now() - tScript}ms (${code.length} bytes)`);
              return [scriptUrl, code];
            } catch (e) {
              log(`  failed  ${scriptUrl}: ${e.message}`);
              return [scriptUrl, null];
            }
          }),
        ),
      );

      log(`all scripts fetched in ${Date.now() - tFetch}ms`);

      // Execute in original document order
      for (const scriptNode of scriptNodes) {
        const src = scriptNode.attrs?.src;
        if (src) {
          const scriptUrl = resolveUrl(src, url);
          if (!scriptUrl || shouldSkip(scriptUrl)) continue;
          const code = fetched.get(scriptUrl);
          if (!code) continue;
          const tRun = Date.now();
          runScript(code, context, scriptUrl, options.scriptTimeout || 5000);
          log(`  ran     ${scriptUrl} in ${Date.now() - tRun}ms`);
        } else {
          const code = scriptNode.children?.[0]?.value || "";
          if (code.trim()) runScript(code, context, `${url}#inline`, options.scriptTimeout || 5000);
        }
      }

      log(`settling for ${options.settle ?? 1000}ms...`);
      await settle(timerQueue, options.settle ?? 1000);
    }

    const html = serialize();
    const finalHtml =
      options.clean !== false ? clean(html, parseCleanOpts(options.clean ?? true)) : html;
    log(`total: ${Date.now() - t0}ms, output: ${html.length} bytes`);
    parentPort.postMessage({ html: finalHtml });
  } catch (err) {
    parentPort.postMessage({ error: err.message });
  }
}

run();
