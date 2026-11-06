// The Cloudflare Web Analytics beacon (arcade#190) is a real third-party script. On the local test server
// its report is refused by CORS and logs console errors, and a test must never reach the network anyway,
// so every page a test opens gets the beacon as an empty script: no request leaves, nothing is reported.
export function stubAnalytics(browser) {
  const stub = (ctx) => ctx.route(/cloudflareinsights\.com/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...args) => { const ctx = await newContext(...args); await stub(ctx); return ctx; };
  const newPage = browser.newPage.bind(browser);
  browser.newPage = async (...args) => { const page = await newPage(...args); await stub(page.context()); return page; };
  return browser;
}
