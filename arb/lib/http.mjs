// fetch with a polite pace and 429/5xx backoff. Both venues rate-limit the
// public endpoints hard (Kalshi answers 429 within a few dozen fast calls).
const sleep = ms => new Promise(r => setTimeout(r, ms));
let last = 0;

export async function getJSON(url, { minGapMs = 120, tries = 5, headers = {} } = {}) {
  for (let t = 0; t < tries; t++) {
    const wait = last + minGapMs - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    let r;
    try {
      r = await fetch(url, { headers: { Accept: "application/json", ...headers } });
    } catch (e) {
      if (t === tries - 1) throw e;
      await sleep(500 * 2 ** t);
      continue;
    }
    if (r.ok) return r.json();
    if (r.status === 429 || r.status >= 500) {
      const ra = +r.headers.get("retry-after");
      await sleep(ra > 0 ? ra * 1000 : 1000 * 2 ** t);
      continue;
    }
    throw new Error(`GET ${url} -> ${r.status} ${(await r.text()).slice(0, 200)}`);
  }
  throw new Error(`GET ${url} -> gave up after ${tries} tries`);
}

export { sleep };
