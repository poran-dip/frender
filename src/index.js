/**
 * frenderer/src/index.js
 * Public API. Spawns an isolated worker thread per render.
 * The main thread never touches page JS — only receives a plain string back.
 */

"use strict";

const { Worker } = require("node:worker_threads");
const path = require("node:path");

const WORKER_PATH = path.join(__dirname, "worker.js");

/**
 * @typedef {Object} frendererOptions
 * @property {number}  [timeout=30000]   - Max ms to wait for render to complete
 * @property {number}  [settle=1000]     - Ms to wait after scripts execute for async rendering
 * @property {boolean} [js=true]         - Whether to execute scripts at all
 * @property {Object}  [headers={}]      - Extra request headers
 */

/**
 * Fetch a URL and return fully JS-rendered HTML.
 * Each call runs in an isolated worker thread — safe to call with untrusted URLs.
 *
 * @param {string} url
 * @param {frendererOptions} options
 * @returns {Promise<string>} rendered HTML
 */
function frenderer(url, options = {}) {
  const opts = {
    timeout: 30000,
    settle: 1000,
    js: true,
    headers: {},
    ...options,
  };

  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_PATH, {
      workerData: { url, options: opts },
      // Workers get NO access to the parent's globals.
      // structuredClone boundary means only serializable data crosses.
    });

    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error(`frenderer timed out after ${opts.timeout}ms for: ${url}`));
    }, opts.timeout);

    worker.on("message", (msg) => {
      clearTimeout(timer);
      if (msg.error) {
        reject(new Error(msg.error));
      } else {
        resolve(msg.html);
      }
      worker.terminate();
    });

    worker.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
      worker.terminate();
    });

    worker.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Worker exited with code ${code}`));
      }
    });
  });
}

module.exports = { frenderer };
