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

  const cfg = RANGES[range] || RANGES['1y'];
  const sym = ticker.toUpperCase();

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Referer': 'https://finance.yahoo.com/',
  };

  try {
    let crumb = null;
    try {
      const cr = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers });
      if (cr.ok) { const t = await cr.text(); if (t && !t.includes('{') && t.length < 50) crumb = t.trim(); }
    } catch(_) {}

    const crumbParam = crumb ? '&crumb=' + encodeURIComponent(crumb) : '';
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=${cfg.interval}&range=${cfg.range}${crumbParam}`;
    const r = await fetch(url, { headers });
    if (!r.ok) throw new Error(`Yahoo ${r.status}`);
    const d = await r.json();
    const result = d?.chart?.result?.[0];
    if (!result) throw new Error('No data');

    const ts = result.timestamp || [];
    const closes = result.indicators?.quote?.[0]?.close || [];

    // Filter out nulls
    const points = ts.map((t, i) => ({ t, c: closes[i] })).filter(p => p.c != null);

    return res.status(200).json({
      ticker: sym,
      range,
      interval: cfg.interval,
      points,
      currency: result.meta?.currency || 'USD',
    });
  } catch(e) {
    return res.status(502).json({ error: e.message });
  }
}
