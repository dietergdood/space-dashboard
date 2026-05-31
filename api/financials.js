// SEC EDGAR XBRL API — fetches real financial data directly from SEC
// CIK: RKLB = 0001836935, ASTS = 0001780312

const TICKERS = {
  rklb: { cik: '0001836935', name: 'Rocket Lab USA' },
  asts: { cik: '0001780312', name: 'AST SpaceMobile' },
};

const EDGAR_BASE = 'https://data.sec.gov/api/xbrl/companyfacts/CIK';

async function fetchEdgar(cik) {
  const url = `${EDGAR_BASE}${cik}.json`;
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'SpaceStocksDashboard/1.0 (space-stocks.vercel.app; contact@space-stocks.app)',
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip, deflate',
    }
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`SEC EDGAR ${r.status}: ${body.substring(0,100)}`);
  }
  return r.json();
}

function getLatestValue(facts, concept, unit = 'USD') {
  try {
    const data = facts?.['us-gaap']?.[concept]?.units?.[unit];
    if (!data?.length) return null;
    // Filter for 10-Q/10-K, sort by end date, get latest
    const filtered = data
      .filter(d => d.form === '10-Q' || d.form === '10-K')
      .sort((a, b) => new Date(b.end) - new Date(a.end));
    if (!filtered.length) return null;
    return { value: filtered[0].val, date: filtered[0].end, form: filtered[0].form };
  } catch { return null; }
}

function getQuarterlyRevenue(facts) {
  try {
    const data = facts?.['us-gaap']?.['Revenues']?.units?.['USD'] ||
                 facts?.['us-gaap']?.['RevenueFromContractWithCustomerExcludingAssessedTax']?.units?.['USD'] ||
                 facts?.['us-gaap']?.['RevenueFromContractWithCustomerIncludingAssessedTax']?.units?.['USD'] ||
                 facts?.['us-gaap']?.['SalesRevenueNet']?.units?.['USD'];
    if (!data?.length) return [];
    // Prefer quarterly (Q1-Q4) over annual, and only instantaneous periods (start != end)
    return data
      .filter(d => (d.form === '10-Q' || d.form === '10-K') && d.fp && d.start !== d.end)
      .sort((a, b) => new Date(b.end) - new Date(a.end))
      .slice(0, 5)
      .map(d => ({ value: d.val, date: d.end, period: d.fp, form: d.form }));
  } catch { return []; }
}

function formatM(val) {
  if (!val) return null;
  return Math.round(val / 1e6);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=3600');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { ticker } = req.query;
  if (!ticker || !TICKERS[ticker]) {
    return res.status(400).json({ error: 'ticker required: rklb or asts' });
  }

  try {
    const { cik, name } = TICKERS[ticker];
    const facts = await fetchEdgar(cik);
    const us = facts?.facts?.['us-gaap'] || {};
    const dei = facts?.facts?.['dei'] || {};

    // Revenue (try multiple concepts)
    const revData = getQuarterlyRevenue(facts.facts);
    const latestRev = revData[0] || null;
    const prevRev = revData[1] || null;
    const revYoY = latestRev && prevRev
      ? Math.round((latestRev.value - prevRev.value) / prevRev.value * 100)
      : null;

    // Gross profit
    const grossProfit = getLatestValue(facts.facts, 'GrossProfit');
    const grossMargin = grossProfit && latestRev
      ? Math.round(grossProfit.value / latestRev.value * 100)
      : null;

    // Cash & equivalents
    const cash = getLatestValue(facts.facts, 'CashAndCashEquivalentsAtCarryingValue') ||
                 getLatestValue(facts.facts, 'CashCashEquivalentsAndShortTermInvestments');

    // Long-term debt - ASTS uses different concepts
    const debt = getLatestValue(facts.facts, 'LongTermDebt') ||
                 getLatestValue(facts.facts, 'LongTermDebtNoncurrent') ||
                 getLatestValue(facts.facts, 'ConvertibleNotesPayable') ||
                 getLatestValue(facts.facts, 'NotesPayable');

    // Net loss/income
    const netIncome = getLatestValue(facts.facts, 'NetIncomeLoss');

    // Operating expenses
    const opex = getLatestValue(facts.facts, 'OperatingExpenses') ||
                 getLatestValue(facts.facts, 'CostsAndExpenses');

    // Shares outstanding
    const shares = getLatestValue(facts.facts, 'CommonStockSharesOutstanding', 'shares') ||
                   getLatestValue(facts.facts, 'EntityCommonStockSharesOutstanding', 'shares');

    return res.status(200).json({
      ticker: ticker.toUpperCase(),
      name,
      cik,
      source: 'SEC EDGAR',
      revenue: {
        latest_m: formatM(latestRev?.value),
        date: latestRev?.date,
        yoy_pct: revYoY,
        form: latestRev?.form,
        history: revData.map(d => ({ value_m: formatM(d.value), date: d.date, period: d.period }))
      },
      gross_margin_pct: grossMargin,
      gross_profit_m: formatM(grossProfit?.value),
      cash_m: formatM(cash?.value),
      cash_date: cash?.date,
      debt_m: formatM(debt?.value),
      debt_date: debt?.date,
      net_income_m: formatM(netIncome?.value),
      net_income_date: netIncome?.date,
      shares_m: shares ? Math.round(shares.value / 1e6) : null,
      updated_at: new Date().toISOString()
    });
  } catch (e) {
    console.error('financials error:', e.message);
    return res.status(200).json({
      error: e.message,
      ticker: ticker.toUpperCase(),
      note: 'SEC EDGAR fetch failed - will retry'
    });
  }
}
