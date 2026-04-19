# frenderer

Execute client-side JavaScript and extract fully rendered HTML or text — without a browser.

Perfect for scraping, SEO, and AI pipelines — use `--text` to extract clean, readable content from modern SPAs.

```bash
frenderer https://example.com
```

## How it works

Most modern sites are JS-rendered — the raw HTML is just an empty `<div id="root">`. frenderer runs the page’s JavaScript in a sandboxed environment, lets the DOM fully resolve, then returns the final result.

Pipeline:

**Tokenizer → Parser → DOM → JS Sandbox → Cleaner**

frenderer exists for one simple reason: most tools either don’t execute JavaScript, or require a full browser to do it. This sits in the middle — fast, lightweight, and purpose-built for content extraction.

All built from scratch in Node.js. No Puppeteer. No Playwright. No headless browser.

## Install

```bash
npm install -g frenderer
```

Requires Node.js 22+.

## CLI

```bash
frenderer <url> [options]
```

| Flag                    | Default | Description                                                |
| ----------------------- | ------- | ---------------------------------------------------------- |
| `-o, --out <file>`      | stdout  | Write output to file                                       |
| `-s, --settle <ms>`     | 1000    | Wait after scripts run for async renders                   |
| `-t, --timeout <ms>`    | 30000   | Total render timeout                                       |
| `--no-js`               | —       | Skip JS execution, static fetch only                       |
| `--script-timeout <ms>` | 5000    | Per-script execution kill timeout                          |
| `--attributes`          | —       | Preserve all HTML attributes (disable attribute stripping) |
| `--text`                | —       | Extract plain text only, no HTML tags                      |
| `--pretty`              | —       | Pretty-print output                                        |
| `--no-clean`            | —       | Raw rendered HTML, no cleaning                             |
| `-H, --header <k:v>`    | —       | Add request header (repeatable)                            |
| `-v, --verbose`         | —       | Show script errors and timing per script                   |
| `-q, --quiet`           | —       | Suppress progress output                                   |

### Examples

```bash
# Render a JS-heavy SPA
frenderer https://myapp.vercel.app

# Save to file
frenderer https://myapp.vercel.app -o out.html

# Extract plain text (great for LLM input or search indexing)
frenderer https://myapp.vercel.app --text -o content.txt

# Give async frameworks more time to render
frenderer https://myapp.vercel.app -s 3000

# Static fetch only, no JS
frenderer https://example.com --no-js

# Keep raw HTML with all attributes intact
frenderer https://myapp.vercel.app --no-clean --attributes

# Pass cookies for auth-protected pages
frenderer https://myapp.vercel.app -H "Cookie: session=abc123"

# Debug script errors
frenderer https://myapp.vercel.app --verbose
```

## Library

```js
import { frenderer } from "frenderer";

const html = await frenderer("https://myapp.vercel.app", {
  settle: 2000, // ms to wait for async rendering
  timeout: 30000, // total timeout
  js: true, // execute scripts
  clean: true, // strip noise (default)
  headers: {}, // custom request headers
});
```

### Clean options

By default frenderer strips classes, aria labels, data attributes, scripts, styles, SVGs, comments, and Next.js image optimizer URLs — leaving lean, readable HTML.

```js
const html = await frenderer(url, {
  clean: {
    class: true, // Tailwind / CSS classnames
    aria: true, // aria-* attributes
    data: true, // data-* attributes
    style: false, // inline styles
    id: false, // id attributes
    scripts: true, // <script> blocks
    styles: true, // <style> blocks + <link rel=stylesheet>
    svg: true, // <svg> blocks (icons)
    comments: true, // <!-- comments -->
    srcset: true, // srcset attributes
    imgattrs: true, // width/height/loading/decoding
    imgurls: true, // decode Next.js image optimizer URLs
    decimals: true, // trim long decimals in inline styles
    attributes: true, // strip ALL attributes (overrides above)
    textonly: false, // extract plain text only
    whitespace: true, // collapse blank lines
  },
});
```

### As a prerender middleware

Drop-in SEO for existing Vite/CRA apps — serve rendered HTML to crawlers, normal SPA to users:

```js
import { frenderer } from "frenderer";

const BOT_UA = /googlebot|bingbot|twitterbot|facebookexternalhit|crawler/i;

app.use(async (req, res, next) => {
  if (!BOT_UA.test(req.headers["user-agent"] || "")) return next();

  const html = await frenderer(`http://localhost:${PORT}${req.url}`, {
    settle: 1000,
  });
  res.send(html);
});
```

## Security

Script execution runs inside two layers of isolation:

1. **`vm` context** — sandboxed V8 isolate, no access to host globals (`require`, `process`, `__dirname`, env vars)
2. **Worker thread** — each render runs in an isolated thread; even if a script escapes the vm, the main process is unaffected

Designed to safely execute untrusted page scripts using multiple isolation layers.

## Limitations

- Pages that require authentication (cookies/sessions) need headers passed manually
- Sites using WebGL, Canvas, or WebAssembly for rendering won't work
- Heavy anti-bot detection (Cloudflare, Akamai) may block requests
- Not a replacement for proper SSR frameworks (Next.js, Nuxt) in new projects

## Contributing

frenderer is early and intentionally simple. If something feels missing or could be cleaner, you're probably right.

Areas that could use help:

- Better JS compatibility (framework edge cases)
- Smarter DOM → text extraction
- Performance improvements
- Plugin/hooks system

PRs and ideas welcome.

## License

Apache 2.0

> Turn modern JS-heavy websites into clean, readable content — no browser required.
