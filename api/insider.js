// Real insider trades — parsed directly from SEC EDGAR Form 4 XML filings.
// Free, official primary source. Replaces KI-recherchierte Insider-Daten mit harten Daten.
const TICKERS = {
  rklb: { cik: '0001836935' },
  asts: { cik: '0001780312' },
  oklo: { cik: '0001849056' },
  spcx: { cik: '0001181412' },
};

const UA = { 'User-Agent': 'MyStocksDashboard/1.0 (space-stocks.vercel.app; contact@space-stocks.app)', 'Accept': '*/*' };

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}>\\s*([\\s\\S]*?)\\s*</${name}>`));
  return m ? m[1].trim() : null;
}
function tagVal(xml, name) {
  // e.g. <transactionShares><value>1000</value></transactionShares>
  const block = tag(xml, name);
  return block ? tag(block, 'value') ?? block : null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const t = (req.query.ticker || '').toLowerCase();
  if (!TICKERS[t]) return res.status(400).json({ error: 'ticker required: rklb, asts, spcx or oklo' });
  const cik = TICKERS[t].cik;

  try {
    const sub = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, { headers: UA });
    if (!sub.ok) return res.status(502).json({ error: 'SEC submissions failed', status: sub.status });
    const j = await sub.json();
    const r = j.filings?.recent || {};
    const idx = [];
    for (let i = 0; i < (r.form || []).length && idx.length < 8; i++) {
      if (r.form[i] === '4') idx.push(i);
    }

    const cikNum = String(parseInt(cik, 10));
    const filings = await Promise.all(idx.map(async (i) => {
      try {
        const acc = r.accessionNumber[i].replace(/-/g, '');
        const doc = (r.primaryDocument[i] || '').replace(/^.*\//, ''); // strip xslF345X05/ prefix -> raw XML
        if (!doc.endsWith('.xml')) return null;
        const xr = await fetch(`https://www.sec.gov/Archives/edgar/data/${cikNum}/${acc}/${doc}`, { headers: UA });
        if (!xr.ok) return null;
        const xml = await xr.text();

        const name = tag(xml, 'rptOwnerName');
        let title = tag(xml, 'officerTitle');
        if (!title && tag(xml, 'isDirector') === '1') title = 'Director';
        if (!title && tag(xml, 'isTenPercentOwner') === '1') title = '10%-Eigentümer';

        // Only open-market transactions (P = purchase, S = sale) — awards/exercises excluded
        let buyShares = 0, sellShares = 0, buyVal = 0, sellVal = 0, lastDate = r.filingDate[i], lastPrice = 0;
        const txBlocks = xml.match(/<nonDerivativeTransaction>[\s\S]*?<\/nonDerivativeTransaction>/g) || [];
        for (const b of txBlocks) {
          const code = tag(b, 'transactionCode');
          const shares = parseFloat(tagVal(b, 'transactionShares')) || 0;
          const price = parseFloat(tagVal(b, 'transactionPricePerShare')) || 0;
          const date = tagVal(b, 'transactionDate');
          if (date) lastDate = date;
          if (price) lastPrice = price;
          if (code === 'P') { buyShares += shares; buyVal += shares * price; }
          if (code === 'S') { sellShares += shares; sellVal += shares * price; }
        }
        if (!buyShares && !sellShares) return null; // only awards/exercises -> skip

        const isBuy = buyShares >= sellShares;
        const shares = isBuy ? buyShares : sellShares;
        const value = isBuy ? buyVal : sellVal;
        return {
          name: (name || '').replace(/\b\w/g, c => c.toUpperCase()),
          title: title || 'Insider',
          type: isBuy ? 'buy' : 'sell',
          shares: Math.round(shares),
          price: lastPrice || (shares ? +(value / shares).toFixed(2) : 0),
          value: Math.round(value),
          date: lastDate,
          note: `${isBuy ? 'Direktkauf' : 'Verkauf'} am offenen Markt (SEC Form 4)`,
        };
      } catch (_) { return null; }
    }));

    const trades = filings.filter(Boolean);
    const buys = trades.filter(x => x.type === 'buy').length;
    const sells = trades.length - buys;
    const signal = buys > sells ? 'bullish' : sells > buys ? 'bearish' : 'neutral';
    const summary = trades.length
      ? `${trades.length} Open-Market-Transaktionen in den letzten Form-4-Meldungen: ${buys} Käufe, ${sells} Verkäufe. Direkt aus SEC EDGAR geparst (Zuteilungen/Optionsausübungen ausgeblendet).`
      : 'Keine Open-Market-Käufe oder -Verkäufe in den letzten Form-4-Meldungen (nur Zuteilungen/Ausübungen oder keine Filings).';

    res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=43200');
    return res.status(200).json({ trades, summary, signal, source: 'SEC EDGAR Form 4', ts: Date.now() });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
