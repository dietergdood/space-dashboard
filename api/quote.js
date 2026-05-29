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
    // Step 1: Get crumb (needed for authenticated endpoints)
    let crumb = null;
    try {
      const crumbRes = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers });
      if (crumbRes.ok) crumb = await crumbRes.text();
    } catch (_) {}

    // Step 2: Fetch chart data
    const chartUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=5d${crumb ? '&crumb=' + encodeURIComponent(crumb) : ''}`;
    const chartRes = await fetch(chartUrl, { headers });
    if (!chartRes.ok) throw new Error(`Chart: ${chartRes.status}`);
    const chartData = await chartRes.json();

    // Step 3: Try to get marketCap from quote endpoint (no crumb needed)
    try {
      const quoteUrl = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${sym}&fields=marketCap,regularMarketVolume${crumb ? '&crumb=' + encodeURIComponent(crumb) : ''}`;
      const quoteRes = await fetch(quoteUrl, { headers });
      if (quoteRes.ok) {
        const quoteData = await quoteRes.json();
        const q = quoteData?.quoteResponse?.result?.[0];
        if (q && chartData?.chart?.result?.[0]?.meta) {
          const meta = chartData.chart.result[0].meta;
          if (q.marketCap) meta.marketCap = q.marketCap;
          if (q.regularMarketVolume) meta.regularMarketVolume = q.regularMarketVolume;
        }
      }
    } catch (_) { /* optional */ }

    res.status(200).json(chartData);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}
