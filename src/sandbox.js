/**
 * frender/src/sandbox.js
 *
 * Phase 4: JavaScript Sandbox
 *
 * Builds a fake browser "window" around our DOM, then executes the page's
 * <script> tags inside a Node vm context — safely isolated from the host.
 *
 * Two layers of isolation (as planned):
 *   1. vm.createContext()  — sandboxed V8 context, no access to host globals
 *   2. Worker thread       — catches anything that escapes the vm
 *
 * Shims provided (enough to boot React, Vue, Alpine, Svelte, vanilla JS):
 *   window, document, navigator, location, history, screen,
 *   setTimeout/clearTimeout, setInterval/clearInterval,
 *   requestAnimationFrame, cancelAnimationFrame,
 *   fetch, XMLHttpRequest,
 *   CustomEvent, Event, MutationObserver, IntersectionObserver,
 *   ResizeObserver, PerformanceObserver,
 *   localStorage, sessionStorage,
 *   console, performance, crypto,
 *   URL, URLSearchParams, Headers, Request, Response,
 *   TextEncoder, TextDecoder,
 *   atob, btoa, queueMicrotask,
 *   process (minimal stub — some bundlers check for it)
 */

"use strict";

const vm = require("node:vm");

// ─── Simple storage shim ──────────────────────────────────────────────────────

function makeStorage() {
  const store = Object.create(null);
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => {
      store[String(k)] = String(v);
    },
    removeItem: (k) => {
      delete store[k];
    },
    clear: () => {
      Object.keys(store).forEach((k) => {
        delete store[k];
      });
    },
    key: (i) => Object.keys(store)[i] ?? null,
    get length() {
      return Object.keys(store).length;
    },
  };
}

// ─── XHR stub ─────────────────────────────────────────────────────────────────
// Some older libs (and polyfills) instantiate XHR during boot even if they
// end up using fetch. We provide enough surface to not crash.

function makeXHR(baseUrl, fetchFn) {
  return class XMLHttpRequest {
    constructor() {
      this.readyState = 0;
      this.status = 0;
      this.statusText = "";
      this.responseText = "";
      this.response = null;
      this.responseType = "";
      this._method = "";
      this._url = "";
      this._headers = {};
      this.onload = null;
      this.onerror = null;
      this.onreadystatechange = null;
    }
    open(method, url) {
      this._method = method;
      this._url = url;
    }
    setRequestHeader(k, v) {
      this._headers[k] = v;
    }
    getAllResponseHeaders() {
      return "";
    }
    getResponseHeader() {
      return null;
    }
    abort() {}
    send(body) {
      const resolved = (() => {
        try {
          return new URL(this._url, baseUrl).href;
        } catch {
          return this._url;
        }
      })();
      fetchFn(resolved, { method: this._method, headers: this._headers, body })
        .then((r) =>
          r.text().then((text) => {
            this.readyState = 4;
            this.status = r.status;
            this.statusText = r.statusText;
            this.responseText = text;
            this.response = text;
            if (this.onreadystatechange)
              try {
                this.onreadystatechange();
              } catch {}
            if (this.onload)
              try {
                this.onload({ target: this });
              } catch {}
          }),
        )
        .catch((err) => {
          if (this.onerror)
            try {
              this.onerror(err);
            } catch {}
        });
    }
    addEventListener(type, fn) {
      if (type === "load") this.onload = fn;
      if (type === "error") this.onerror = fn;
    }
    removeEventListener() {}
  };
}

// ─── MutationObserver shim ────────────────────────────────────────────────────
// React's reconciler wires up a MutationObserver during init.
// We don't need it to fire — just not crash.

class MutationObserver {
  constructor(cb) {
    this._cb = cb;
  }
  observe() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

// ─── Minimal Event / CustomEvent ──────────────────────────────────────────────

class FEvent {
  constructor(type, opts = {}) {
    this.type = type;
    this.bubbles = opts.bubbles || false;
    this.cancelable = opts.cancelable || false;
    this.composed = opts.composed || false;
    this.defaultPrevented = false;
    this.target = null;
    this.currentTarget = null;
    this.timeStamp = Date.now();
  }
  preventDefault() {
    this.defaultPrevented = true;
  }
  stopPropagation() {}
  stopImmediatePropagation() {}
}

class FCustomEvent extends FEvent {
  constructor(type, opts = {}) {
    super(type, opts);
    this.detail = opts.detail ?? null;
  }
}

// ─── Performance shim ─────────────────────────────────────────────────────────

function makePerformance() {
  const start = Date.now();
  const marks = {};
  return {
    now: () => Date.now() - start,
    mark: (name) => {
      marks[name] = Date.now() - start;
    },
    measure: () => {},
    getEntriesByName: () => [],
    getEntriesByType: () => [],
    clearMarks: () => {},
    clearMeasures: () => {},
    timing: { navigationStart: start, loadEventEnd: start + 100 },
    navigation: { type: 0, redirectCount: 0 },
    eventCounts: {},
    toJSON: () => ({}),
  };
}

// ─── crypto stub (uuid generation etc) ───────────────────────────────────────

function makeCrypto() {
  return {
    getRandomValues(arr) {
      for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
      return arr;
    },
    randomUUID() {
      return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
      });
    },
    subtle: {
      digest: () => Promise.resolve(new ArrayBuffer(0)),
    },
  };
}

// ─── Timer queue ──────────────────────────────────────────────────────────────
// We shim setTimeout/setInterval to queue callbacks instead of running them
// on the host event loop. After script execution we drain the queue manually
// in Phase 5 (settle). This gives frameworks a chance to schedule async renders.

function makeTimerQueue() {
  let id = 0;
  const queue = []; // { id, fn, args, ms, interval }

  function setTimeout_(fn, ms = 0, ...args) {
    const tid = ++id;
    queue.push({ id: tid, fn, args, ms, interval: false });
    return tid;
  }
  function clearTimeout_(tid) {
    const idx = queue.findIndex((t) => t.id === tid);
    if (idx !== -1) queue.splice(idx, 1);
  }
  function setInterval_(fn, ms = 0, ...args) {
    const tid = ++id;
    queue.push({ id: tid, fn, args, ms, interval: true });
    return tid;
  }
  function clearInterval_(tid) {
    clearTimeout_(tid);
  }

  // Drain: run all queued callbacks once (non-recurring)
  function drain() {
    const pending = queue.splice(0);
    for (const t of pending) {
      try {
        t.fn(...t.args);
      } catch {}
    }
  }

  return {
    setTimeout: setTimeout_,
    clearTimeout: clearTimeout_,
    setInterval: setInterval_,
    clearInterval: clearInterval_,
    drain,
  };
}

// ─── Build sandbox window ─────────────────────────────────────────────────────

/**
 * Build the full window object that gets injected into the vm context.
 *
 * @param {Object} domDocument  — the document wrapper from dom.js
 * @param {string} pageUrl      — the page's URL (for location, fetch resolution)
 * @param {Function} fetchFn    — node-fetch (or compatible)
 * @returns {{ context, timerQueue }}
 */
function buildSandbox(domDocument, pageUrl, fetchFn) {
  let urlObj;
  try {
    urlObj = new URL(pageUrl);
  } catch {
    urlObj = new URL("http://localhost");
  }

  const timerQueue = makeTimerQueue();
  const storage = { local: makeStorage(), session: makeStorage() };
  const perf = makePerformance();
  const XHR = makeXHR(pageUrl, fetchFn);

  // Resolve relative URLs against page origin
  const resolve = (url) => {
    try {
      return new URL(url, pageUrl).href;
    } catch {
      return url;
    }
  };

  // Wrapped fetch that resolves relative URLs
  const sandboxFetch = (url, opts) => fetchFn(resolve(url), opts);

  // location object (read-only navigating stubs)
  const location = {
    href: pageUrl,
    origin: urlObj.origin,
    protocol: urlObj.protocol,
    host: urlObj.host,
    hostname: urlObj.hostname,
    port: urlObj.port,
    pathname: urlObj.pathname,
    search: urlObj.search,
    hash: "",
    assign: () => {},
    replace: () => {},
    reload: () => {},
    toString: () => pageUrl,
  };

  // Minimal history
  const history = {
    length: 1,
    state: null,
    scrollRestoration: "auto",
    pushState: (_state, _title, url) => {
      if (url) location.href = resolve(url);
    },
    replaceState: (_state, _title, url) => {
      if (url) location.href = resolve(url);
    },
    back: () => {},
    forward: () => {},
    go: () => {},
  };

  // screen
  const screen = {
    width: 1920,
    height: 1080,
    availWidth: 1920,
    availHeight: 1080,
    colorDepth: 24,
    pixelDepth: 24,
    orientation: { type: "landscape-primary", angle: 0 },
  };

  // navigator
  const navigator = {
    userAgent: "Mozilla/5.0 (compatible; frender/1.0)",
    language: "en-US",
    languages: ["en-US", "en"],
    platform: "Linux x86_64",
    onLine: true,
    cookieEnabled: false,
    vendor: "",
    product: "Gecko",
    appName: "Netscape",
    appVersion: "5.0",
    javaEnabled: () => false,
    sendBeacon: () => false,
    clipboard: {
      writeText: () => Promise.resolve(),
      readText: () => Promise.resolve(""),
    },
    mediaDevices: {
      getUserMedia: () => Promise.reject(new Error("not supported")),
    },
    permissions: { query: () => Promise.resolve({ state: "denied" }) },
    geolocation: {
      getCurrentPosition: (_, err) => err?.({ code: 1, message: "denied" }),
    },
  };

  // console — silent by default (avoid polluting frender output)
  // Set FRENDER_VERBOSE=1 to see page console output
  const verbose = process.env.FRENDER_VERBOSE === "1";
  const console_ = {
    log: (...a) => {
      if (verbose) console.log("[page]", ...a);
    },
    warn: (...a) => {
      if (verbose) console.warn("[page]", ...a);
    },
    error: (...a) => {
      if (verbose) console.error("[page]", ...a);
    },
    info: (...a) => {
      if (verbose) console.info("[page]", ...a);
    },
    debug: (...a) => {
      if (verbose) console.debug("[page]", ...a);
    },
    group: () => {},
    groupEnd: () => {},
    groupCollapsed: () => {},
    time: () => {},
    timeEnd: () => {},
    timeLog: () => {},
    count: () => {},
    countReset: () => {},
    assert: () => {},
    dir: () => {},
    table: () => {},
    trace: () => {},
    clear: () => {},
  };

  // CSS stub — some frameworks call getComputedStyle during boot
  const makeComputedStyle = () =>
    new Proxy(
      {},
      {
        get: (_, prop) => (prop === "getPropertyValue" ? () => "" : ""),
      },
    );

  // document.defaultView should point back to window — set after window is built
  let window_;

  window_ = {
    // ── Self-references ────────────────────────────────────────────────────
    get window() {
      return window_;
    },
    get self() {
      return window_;
    },
    get globalThis() {
      return window_;
    },
    get top() {
      return window_;
    },
    get parent() {
      return window_;
    },
    get frames() {
      return window_;
    },
    get length() {
      return 0;
    },

    // ── Core DOM ───────────────────────────────────────────────────────────
    document: domDocument,
    location,
    history,
    screen,
    navigator,

    // ── Timers ─────────────────────────────────────────────────────────────
    setTimeout: timerQueue.setTimeout,
    clearTimeout: timerQueue.clearTimeout,
    setInterval: timerQueue.setInterval,
    clearInterval: timerQueue.clearInterval,
    requestAnimationFrame: (fn) => {
      timerQueue.setTimeout(fn, 0, performance.now());
      return 1;
    },
    cancelAnimationFrame: timerQueue.clearTimeout,
    queueMicrotask: (fn) => Promise.resolve().then(fn),

    // ── Network ────────────────────────────────────────────────────────────
    fetch: sandboxFetch,
    XMLHttpRequest: XHR,
    WebSocket: class WebSocket {
      constructor() {
        this.readyState = 3;
      } /* CLOSED */
    },

    // ── Storage ────────────────────────────────────────────────────────────
    localStorage: storage.local,
    sessionStorage: storage.session,
    indexedDB: null,
    caches: {
      open: () => Promise.reject(),
      match: () => Promise.resolve(null),
    },
    cookieStore: null,

    // ── Events / Observers ─────────────────────────────────────────────────
    Event: FEvent,
    CustomEvent: FCustomEvent,
    MutationObserver,
    IntersectionObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    PerformanceObserver: class {
      observe() {}
      disconnect() {}
      static supportedEntryTypes = [];
    },
    AbortController: class AbortController {
      constructor() {
        this.signal = {
          aborted: false,
          addEventListener: () => {},
          removeEventListener: () => {},
        };
      }
      abort() {
        this.signal.aborted = true;
      }
    },
    AbortSignal: { timeout: () => ({ aborted: false }) },
    EventSource: class {
      constructor() {
        this.readyState = 2;
      }
    },
    EventTarget: class {
      addEventListener() {}
      removeEventListener() {}
      dispatchEvent() {}
    },

    // ── Encoding ───────────────────────────────────────────────────────────
    TextEncoder,
    TextDecoder,
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),

    // ── URL ────────────────────────────────────────────────────────────────
    URL,
    URLSearchParams,

    // ── Fetch API primitives ───────────────────────────────────────────────
    Headers: class Headers {
      constructor(init = {}) {
        this._h = {};
        Object.entries(init).forEach(([k, v]) => {
          this.set(k, v);
        });
      }
      get(k) {
        return this._h[k.toLowerCase()] ?? null;
      }
      set(k, v) {
        this._h[k.toLowerCase()] = v;
      }
      has(k) {
        return k.toLowerCase() in this._h;
      }
      delete(k) {
        delete this._h[k.toLowerCase()];
      }
      append(k, v) {
        const lk = k.toLowerCase();
        this._h[lk] = this._h[lk] ? `${this._h[lk]}, ${v}` : v;
      }
      entries() {
        return Object.entries(this._h)[Symbol.iterator]();
      }
      forEach(fn) {
        Object.entries(this._h).forEach(([k, v]) => {
          fn(v, k, this);
        });
      }
    },
    Request: class Request {
      constructor(url, opts = {}) {
        this.url = url;
        this.method = opts.method || "GET";
        this.headers = opts.headers || {};
      }
    },
    Response: class Response {
      constructor(body = "", opts = {}) {
        this.body = body;
        this.status = opts.status || 200;
        this.ok = this.status < 400;
      }
      text() {
        return Promise.resolve(String(this.body));
      }
      json() {
        return Promise.resolve(JSON.parse(this.body));
      }
      blob() {
        return Promise.resolve(new Blob([this.body]));
      }
    },
    Blob:
      typeof Blob !== "undefined"
        ? Blob
        : class Blob {
            constructor(parts) {
              this._parts = parts;
            }
          },
    FormData: class FormData {
      constructor() {
        this._data = [];
      }
      append(k, v) {
        this._data.push([k, v]);
      }
      get(k) {
        return this._data.find(([key]) => key === k)?.[1] ?? null;
      }
    },

    // ── Media / Canvas stubs ───────────────────────────────────────────────
    // Frameworks often try to detect capabilities; we stub enough to not throw
    Image: class Image {
      constructor() {
        this.onload = null;
        this.onerror = null;
      }
      set src(_v) {
        if (this.onload)
          Promise.resolve().then(() => {
            try {
              this.onload();
            } catch {}
          });
      }
    },
    Audio: class Audio {
      play() {
        return Promise.resolve();
      }
      pause() {}
      load() {}
    },
    Video: class Video {
      play() {
        return Promise.resolve();
      }
      pause() {}
      load() {}
    },
    HTMLCanvasElement: class {
      getContext() {
        return {
          fillRect() {},
          clearRect() {},
          getImageData() {
            return { data: [] };
          },
          putImageData() {},
          drawImage() {},
          scale() {},
          rotate() {},
          translate() {},
          save() {},
          restore() {},
        };
      }
    },

    // ── CSS / Layout stubs ─────────────────────────────────────────────────
    getComputedStyle: () => makeComputedStyle(),
    matchMedia: (query) => ({
      matches: false,
      media: query,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
    requestIdleCallback: (fn) => {
      timerQueue.setTimeout(fn, 0, {
        didTimeout: false,
        timeRemaining: () => 50,
      });
      return 1;
    },
    cancelIdleCallback: timerQueue.clearTimeout,

    // ── Performance / Diagnostics ──────────────────────────────────────────
    performance: perf,
    crypto: makeCrypto(),
    console: console_,

    // ── Misc browser globals ───────────────────────────────────────────────
    devicePixelRatio: 1,
    innerWidth: 1920,
    innerHeight: 1080,
    outerWidth: 1920,
    outerHeight: 1080,
    scrollX: 0,
    scrollY: 0,
    pageXOffset: 0,
    pageYOffset: 0,
    screenX: 0,
    screenY: 0,
    scrollTo: () => {},
    scrollBy: () => {},
    scroll: () => {},
    alert: () => {},
    confirm: () => false,
    prompt: () => null,
    open: () => null,
    close: () => {},
    focus: () => {},
    blur: () => {},
    print: () => {},
    stop: () => {},
    postMessage: () => {},
    structuredClone: (v) => JSON.parse(JSON.stringify(v)),

    // ── Process stub (CRA / webpack bundlers check process.env.NODE_ENV) ───
    process: {
      env: { NODE_ENV: "production" },
      browser: true,
      version: "",
      versions: {},
      platform: "browser",
      nextTick: (fn) => Promise.resolve().then(fn),
    },

    // ── Global constructor stubs (instanceof checks) ───────────────────────
    Object,
    Array,
    Function,
    String,
    Number,
    Boolean,
    Symbol,
    BigInt,
    Date,
    Math,
    JSON,
    RegExp,
    Error,
    TypeError,
    RangeError,
    Map,
    Set,
    WeakMap,
    WeakSet,
    WeakRef,
    FinalizationRegistry,
    Promise,
    Proxy,
    Reflect,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURIComponent,
    decodeURIComponent,
    encodeURI,
    decodeURI,
    ArrayBuffer,
    DataView,
    SharedArrayBuffer: typeof SharedArrayBuffer !== "undefined" ? SharedArrayBuffer : undefined,
    Int8Array,
    Uint8Array,
    Uint8ClampedArray,
    Int16Array,
    Uint16Array,
    Int32Array,
    Uint32Array,
    Float32Array,
    Float64Array,
    BigInt64Array,
    BigUint64Array,
    clearImmediate: () => {},
    setImmediate: (fn, ...args) => {
      timerQueue.setTimeout(fn, 0, ...args);
      return 0;
    },

    // ── Window event stubs ─────────────────────────────────────────────────
    onload: null,
    onunload: null,
    onbeforeunload: null,
    onpopstate: null,
    onhashchange: null,
    onerror: null,
    onmessage: null,
    addEventListener(type, fn) {
      // Some frameworks listen to window 'load' and bootstrap there
      if (type === "load" || type === "DOMContentLoaded") {
        Promise.resolve().then(() => {
          try {
            fn(new FEvent(type));
          } catch {}
        });
      }
    },
    removeEventListener() {},
    dispatchEvent(_e) {
      return true;
    },
  };

  // Wire document.defaultView → window
  try {
    Object.defineProperty(domDocument, "defaultView", {
      get: () => window_,
      configurable: true,
    });
  } catch {}

  // Create the actual vm context — this is the sandboxed V8 isolate
  // We spread window_ into a plain object so vm can contextify it.
  // IMPORTANT: We do NOT pass require, process (real), __dirname, etc.
  const contextObject = Object.assign(Object.create(null), window_);

  // Make self-references work inside the context
  contextObject.window = contextObject;
  contextObject.self = contextObject;
  contextObject.globalThis = contextObject;

  vm.createContext(contextObject);

  return { context: contextObject, timerQueue };
}

// ─── Script execution ─────────────────────────────────────────────────────────

/**
 * Execute a single script string inside the sandbox context.
 * Wraps in try/catch — a broken script should not kill the render.
 *
 * @param {string}  code     — JS source
 * @param {Object}  context  — vm context from buildSandbox
 * @param {string}  filename — for stack traces
 * @param {number}  timeout  — ms before the script is killed
 */
function runScript(code, context, filename = "<script>", timeout = 5000) {
  try {
    const script = new vm.Script(code, { filename });
    script.runInContext(context, { timeout });
  } catch (err) {
    // Script errors are expected (missing APIs, etc.) — log in verbose mode only
    if (process.env.FRENDER_VERBOSE === "1") {
      console.error(`[frender] script error in ${filename}:`, err.message);
    }
  }
}

module.exports = { buildSandbox, runScript, makeStorage };
