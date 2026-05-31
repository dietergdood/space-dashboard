export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { ticker, range } = req.query;
  if (!ticker || !/^[A-Z]{1,6}$/.test(ticker.toUpperCase())) {
    return res.status(400).json({ error: 'Invalid ticker' });
  }

  const RANGES = {
    '1d':  { interval: '5m',  range: '1d' },
    '5d':  { interval: '15m', range: '5d' },
    '1mo': { interval: '1d',  range: '1mo' },
    '6mo': { interval: '1d',  range: '6mo' },
    'ytd': { interval: '1d',  range: 'ytd' },
    '1y':  { interval: '1wk', range: '1y' },
    '5y':  { interval: '1mo', range: '5y' },
  };

  const cfg = RANGES[range] || RANGES['1mo'];
  const sym = ticker.toUpperCase();

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://finance.yahoo.com/',
    'Origin': 'https://finance.yahoo.com',
  };

  async function tryFetch(url) {
    const r = await fetch(url, { headers });
    if (!r.ok) throw new Error(`Yahoo ${r.status}`);
    const d = await r.json();
    const result = d?.chart?.result?.[0];
    if (!result) throw new Error('No result');
    const ts = result.timestamp || [];
    const closes = result.indicators?.quote?.[0]?.close || [];
    const points = ts.map((t, i) => ({ t, c: closes[i] })).filter(p => p.c != null);
    if (!points.length) throw new Error('No points');
    return { points, currency: result.meta?.currency || 'USD' };
  }

  try {
    // Try with crumb first
    let crumb = null;
    try {
      const cr = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers });
      if (cr.ok) {
        const t = await cr.text();
        if (t && !t.includes('{') && t.length < 50) crumb = t.trim();
      }
    } catch(_) {}

    const crumbParam = crumb ? `&crumb=${encodeURIComponent(crumb)}` : '';

    // Try query1 first, then query2 as fallback
    const baseUrl = `?interval=${cfg.interval}&range=${cfg.range}${crumbParam}`;
    let data;
    try {
      data = await tryFetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}${baseUrl}`);
    } catch(e1) {
      // Fallback to query2
      data = await tryFetch(`https://query2.finance.yahoo.com/v8/finance/chart/${sym}${baseUrl}`);
    }

    return res.status(200).json({ ticker: sym, range, interval: cfg.interval, ...data });
  } catch(e) {
    return res.status(502).json({ error: e.message });
  }
}
