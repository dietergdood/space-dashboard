export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { ticker } = req.query;
  if (!ticker || !/^[A-Z]{1,6}$/.test(ticker.toUpperCase())) {
    return res.status(400).json({ error: 'Invalid ticker' });
  }

  const sym = ticker.toUpperCase();
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
  };

  try {
    // Fetch chart data (prices) and quote summary (marketCap etc.) in parallel
    const [chartRes, summaryRes] = await Promise.all([
      fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=5d`, { headers }),
      fetch(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${sym}?modules=price`, { headers }),
    ]);

    if (!chartRes.ok) throw new Error(`Chart: ${chartRes.status}`);
    const chartData = await chartRes.json();

    // Inject marketCap into chart meta if available
    if (summaryRes.ok) {
      try {
        const summaryData = await summaryRes.json();
        const price = summaryData?.quoteSummary?.result?.[0]?.price;
        if (price && chartData?.chart?.result?.[0]?.meta) {
          const meta = chartData.chart.result[0].meta;
          meta.marketCap = price.marketCap?.raw ?? meta.marketCap;
          meta.regularMarketVolume = price.regularMarketVolume?.raw ?? meta.regularMarketVolume;
        }
      } catch (_) { /* summary optional */ }
    }

    res.status(200).json(chartData);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}
