// Real analyst consensus, earnings dates & short interest — Yahoo Finance quoteSummary
// Replaces KI-estimated values with hard data. Free, no API key.
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { ticker } = req.query;
  if (!ticker || !/^[A-Z0-9]{1,6}$/.test(ticker.toUpperCase())) {
    return res.status(400).json({ error: 'Invalid ticker' });
  }
  const sym = ticker.toUpperCase();
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://finance.yahoo.com/',
    'Origin': 'https://finance.yahoo.com',
  };

  try {
    let crumb = null;
    try {
      const crumbRes = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers });
      if (crumbRes.ok) {
        const text = await crumbRes.text();
        if (text && !text.includes('{') && text.length < 50) crumb = text.trim();
      }
    } catch (_) {}
    const crumbParam = crumb ? '&crumb=' + encodeURIComponent(crumb) : '';

    const modules = 'financialData,calendarEvents,defaultKeyStatistics,recommendationTrend';
    let r = await fetch(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${sym}?modules=${modules}${crumbParam}`, { headers });
    if (!r.ok) {
      r = await fetch(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${sym}?modules=${modules}${crumbParam}`, { headers });
    }
    if (!r.ok) return res.status(502).json({ error: 'Yahoo quoteSummary failed', status: r.status });

    const j = await r.json();
    const q = j?.quoteSummary?.result?.[0];
    if (!q) return res.status(404).json({ error: 'No data for ' + sym });

    const fd = q.financialData || {};
    const ce = q.calendarEvents || {};
    const ks = q.defaultKeyStatistics || {};
    const rt = (q.recommendationTrend?.trend || [])[0] || {};

    // Next earnings date (Yahoo returns epoch seconds, sometimes a range)
    let earningsDate = null;
    const eArr = ce.earnings?.earningsDate;
    if (Array.isArray(eArr) && eArr.length) {
      const raw = eArr[0]?.raw ?? eArr[0];
      if (raw) earningsDate = new Date(raw * 1000).toISOString().split('T')[0];
    }

    const ratingMap = {
      strong_buy: 'Starker Kauf', buy: 'Kaufen', hold: 'Halten',
      underperform: 'Untergewichten', sell: 'Verkaufen', none: null,
    };

    const out = {
      symbol: sym,
      targetMean:  fd.targetMeanPrice?.raw ?? null,
      targetHigh:  fd.targetHighPrice?.raw ?? null,
      targetLow:   fd.targetLowPrice?.raw ?? null,
      analystCount: fd.numberOfAnalystOpinions?.raw ?? null,
      rating: ratingMap[fd.recommendationKey] ?? fd.recommendationKey ?? null,
      recTrend: { strongBuy: rt.strongBuy ?? null, buy: rt.buy ?? null, hold: rt.hold ?? null, sell: (rt.sell ?? 0) + (rt.strongSell ?? 0) },
      earningsDate,
      shortPercentOfFloat: ks.shortPercentOfFloat?.raw != null ? +(ks.shortPercentOfFloat.raw * 100).toFixed(1) : null,
      sharesShort: ks.sharesShort?.raw ?? null,
      source: 'Yahoo Finance quoteSummary',
      ts: Date.now(),
    };

    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');
    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
