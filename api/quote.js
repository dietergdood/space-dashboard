export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { ticker } = req.query;
  if (!ticker || !/^[A-Z]{1,6}$/.test(ticker.toUpperCase())) {
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
    // Get crumb
    let crumb = null;
    try {
      const crumbRes = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers });
      if (crumbRes.ok) {
        const text = await crumbRes.text();
        if (text && !text.includes('{')) crumb = text.trim();
      }
    } catch (_) {}

    const crumbParam = crumb ? '&crumb=' + encodeURIComponent(crumb) : '';

    // Fetch: 5d daily (for prev close calc) + 1y weekly (for chart) + quote (for real-time)
    const [chart5dRes, chart1yRes, quoteRes] = await Promise.all([
      fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=5d${crumbParam}`, { headers }),
      fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1wk&range=1y${crumbParam}`, { headers }),
      fetch(`https://query2.finance.yahoo.com/v7/finance/quote?symbols=${sym}&fields=regularMarketPrice,regularMarketPreviousClose,marketCap,regularMarketVolume,fiftyTwoWeekHigh,fiftyTwoWeekLow${crumbParam}`, { headers }),
    ]);

    if (!chart5dRes.ok) throw new Error(`Chart5d: ${chart5dRes.status}`);
    const chartData = await chart5dRes.json();

    // Inject 1y weekly history
    if (chart1yRes.ok) {
      try {
        const hist = await chart1yRes.json();
        const r = hist?.chart?.result?.[0];
        if (r && chartData?.chart?.result?.[0]) {
          chartData.chart.result[0].history = {
            timestamps: r.timestamp,
            closes: r.indicators?.quote?.[0]?.close,
          };
        }
      } catch (_) {}
    }

    // Inject real-time quote fields
    if (quoteRes.ok) {
      try {
        const quoteData = await quoteRes.json();
        const q = quoteData?.quoteResponse?.result?.[0];
        if (q && chartData?.chart?.result?.[0]?.meta) {
          const meta = chartData.chart.result[0].meta;
          if (q.regularMarketPreviousClose) meta.regularMarketPreviousClose = q.regularMarketPreviousClose;
          if (q.regularMarketPrice)         meta.regularMarketPrice         = q.regularMarketPrice;
          if (q.marketCap)                  meta.marketCap                  = q.marketCap;
          if (q.regularMarketVolume)        meta.regularMarketVolume        = q.regularMarketVolume;
          if (q.fiftyTwoWeekHigh)           meta.fiftyTwoWeekHigh           = q.fiftyTwoWeekHigh;
          if (q.fiftyTwoWeekLow)            meta.fiftyTwoWeekLow            = q.fiftyTwoWeekLow;
        }
      } catch (_) {}
    }

    res.status(200).json(chartData);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}
