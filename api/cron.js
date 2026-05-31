// Vercel Cron Job - runs 4x daily
// Requires ANTHROPIC_API_KEY in Vercel Environment Variables

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

async function supa(path, method='GET', body=null) {
  const opts = {
    method,
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': (method==='POST'||method==='PATCH') ? 'return=minimal' : '',
    }
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`${SUPABASE_URL}/rest/v1${path}`, opts);
  if (!r.ok) {
    const errText = await r.text();
    console.error('Supabase error:', r.status, errText);
    throw new Error(`Supabase ${r.status}: ${errText}`);
  }
  if (r.status === 204) return {};
  const text = await r.text();
  return text ? JSON.parse(text) : {};
}

// ── JSON Sanitizer ─────────────────────────────────────────────────────────
// Removes common causes of JSON parse failures from KI responses
function sanitizeJson(str) {
  return str
    // Remove cite tags like text
    .replace(/]*>([^<]*)<\/antml:cite>/g, '$1')
    // Remove all remaining HTML tags
    .replace(/<[^>]+>/g, '')
    // Fix unescaped newlines inside strings (common cause of parse failures)
    .replace(/("(?:[^"\\]|\\.)*")/g, m => m.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t'))
    // Remove trailing commas before } or ]
    .replace(/,(\s*[}\]])/g, '$1')
    .trim();
}

async function kiCall(prompt, retries=3, maxSearches=8, model='claude-sonnet-4-5') {
  for (let attempt = 0; attempt < retries; attempt++) {
    if (attempt > 0) {
      const wait = attempt * 15000;
      console.log(`Retry ${attempt}, waiting ${wait/1000}s`);
      await delay(wait);
    }
    console.log(`API call attempt ${attempt+1}, prompt length: ${prompt.length}`);
    let resp;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 80000);
      resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: model,
          max_tokens: 2048,  // increased from 1024 — prevents truncated JSON
          tools: [{type: 'web_search_20250305', name: 'web_search', max_uses: maxSearches}],
          messages: [{role: 'user', content: prompt}]
        })
      });
      clearTimeout(timeout);
    } catch(fetchErr) {
      console.error('Fetch error:', fetchErr.message);
      continue;
    }
    console.log(`API response status: ${resp.status}`);
    if (resp.status === 429) {
      console.log('Rate limited, retrying...');
      continue;
    }
    if (!resp.ok) {
      const errText = await resp.text();
      console.error(`API error ${resp.status}:`, errText.substring(0, 200));
      throw new Error(`Anthropic ${resp.status}: ${errText.substring(0,100)}`);
    }
    const data = await resp.json();
    console.log('Response content blocks:', data.content?.length, data.content?.map(b=>b.type).join(','));
    const raw = data.content.filter(b=>b.type==='text').map(b=>b.text).join('').trim();
    console.log('Raw text length:', raw.length, '| First 100:', raw.substring(0,100));

    // Strip markdown code fences
    let jsonStr = raw
      .replace(/^```json\s*/m,'')
      .replace(/^```\s*/m,'')
      .replace(/\s*```\s*$/,'')
      .trim();

    // Extract JSON object (from first { to last })
    const firstBrace = jsonStr.indexOf('{');
    const lastBrace = jsonStr.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1) {
      console.error('No JSON found. Raw:', raw.substring(0,300));
      throw new Error('No JSON in response');
    }
    let extracted = jsonStr.substring(firstBrace, lastBrace + 1);

    // Strategy 1: direct parse
    try { return JSON.parse(extracted); } catch(_) {}

    // Strategy 2: sanitize then parse
    try { return JSON.parse(sanitizeJson(extracted)); } catch(_) {}

    // Strategy 3: fix newlines in strings
    try {
      const fixed = extracted.replace(/\r?\n/g, ' ').replace(/\t/g, ' ');
      return JSON.parse(fixed);
    } catch(_) {}

    // Strategy 4: salvage known structures
    try {
      const salvaged = salvageJson(extracted);
      if (salvaged) {
        console.log('JSON salvaged via structure extraction');
        return salvaged;
      }
    } catch(_) {}

    console.error('All JSON strategies failed for this attempt');
    throw new Error(`JSON parse failed after all strategies`);
  }
  throw new Error('All retries exhausted');
}

// ── Structured salvage for known response types ────────────────────────────
function salvageJson(raw) {
  // Articles
  if (raw.includes('"articles"')) {
    const articles = [];
    const titleM  = [...raw.matchAll(/"title":\s*"([^"]{1,120})"/g)];
    const sentM   = [...raw.matchAll(/"sentiment":\s*"([^"]{1,10})"/g)];
    const sourceM = [...raw.matchAll(/"source":\s*"([^"]{1,100})"/g)];
    const bodyM   = [...raw.matchAll(/"body":\s*"(.*?)(?:","sentiment"|","source")/gs)];
    const count = Math.min(titleM.length, sentM.length);
    for (let i = 0; i < count; i++) {
      articles.push({
        title: titleM[i][1],
        sentiment: sentM[i][1],
        body: bodyM[i] ? bodyM[i][1].replace(/<[^>]*>/g,'').replace(/\\n/g,' ').trim() : '',
        source: sourceM[i] ? sourceM[i][1] : ''
      });
    }
    if (articles.length > 0) { console.log('Salvaged', articles.length, 'articles'); return {articles}; }
  }

  // Cards (sector)
  if (raw.includes('"cards"')) {
    const introMatch = raw.match(/"intro":\s*"([^"]+)"/);
    const cards = [];
    for (const m of raw.matchAll(/"emoji":\s*"([^"]+)"[^}]*?"name":\s*"([^"]+)"[^}]*?"val":\s*"([^"]+)"[^}]*?"val_color":\s*"([^"]+)"[^}]*?"desc":\s*"([^"]+)"/g)) {
      cards.push({emoji:m[1], name:m[2], val:m[3], val_color:m[4], desc:m[5]});
    }
    if (cards.length > 0) { console.log('Salvaged', cards.length, 'cards'); return {intro: introMatch?.[1]||'', cards}; }
  }

  // Insider trades
  if (raw.includes('"trades"')) {
    const trades = [];
    const nameM   = [...raw.matchAll(/"name":\s*"([^"]{1,80})"/g)];
    const typeM   = [...raw.matchAll(/"type":\s*"(buy|sell)"/g)];
    const sharesM = [...raw.matchAll(/"shares":\s*(\d+)/g)];
    const priceM  = [...raw.matchAll(/"price":\s*([\d.]+)/g)];
    const valueM  = [...raw.matchAll(/"value":\s*(\d+)/g)];
    const dateM   = [...raw.matchAll(/"date":\s*"([^"]{1,20})"/g)];
    const titleM  = [...raw.matchAll(/"title":\s*"([^"]{1,60})"/g)];
    const noteM   = [...raw.matchAll(/"note":\s*"([^"]{1,300})"/g)];
    for (let i = 0; i < nameM.length; i++) {
      trades.push({
        name: nameM[i][1],
        title: titleM[i]?.[1]||'',
        type: typeM[i]?.[1]||'sell',
        shares: sharesM[i] ? parseInt(sharesM[i][1]) : 0,
        price: priceM[i] ? parseFloat(priceM[i][1]) : 0,
        value: valueM[i] ? parseInt(valueM[i][1]) : 0,
        date: dateM[i]?.[1]||'',
        note: noteM[i] ? noteM[i][1].replace(/<[^>]*>/g,'') : ''
      });
    }
    const summaryM = raw.match(/"summary":\s*"([^"]{1,300})"/);
    const signalM  = raw.match(/"signal":\s*"(bullish|bearish|neutral)"/);
    if (trades.length > 0) { console.log('Salvaged', trades.length, 'trades'); return {trades, summary:summaryM?.[1]||'', signal:signalM?.[1]||'neutral'}; }
  }

  return null;
}

const delay = ms => new Promise(r => setTimeout(r, ms));

async function saveToCache(section, ticker, data) {
  const key = ticker ? `${ticker}/${section}` : `global/${section}`;
  try {
    await supa('/ki_cache?on_conflict=ticker,section', 'POST', [{
      ticker: ticker || 'global',
      section,
      data,
      updated_at: new Date().toISOString()
    }]);
    console.log(`Saved: ${ticker||'global'} ${section}`);
  } catch(e) {
    console.error(`Save failed ${key}:`, e.message);
  }
}

// ── Prompts ────────────────────────────────────────────────────────────────
// KEY RULES for all prompts:
// 1. "Return ONLY valid JSON" — no preamble, no explanation
// 2. "No line breaks inside string values" — prevents parse failures
// 3. "No HTML, no <cite> tags" — model sometimes adds citations
// 4. "No Umlauts in field names" — use ASCII keys only
// 5. Use concrete example values — model fills in the pattern

const REC_PROMPTS = {
  rklb: `Analysiere Rocket Lab (RKLB). Antworte NUR mit JSON: {"empfehlung":"KAUFEN|HALTEN|VERKAUFEN","score_fundamental":75,"score_momentum":80,"score_risiko":60,"score_bewertung":40,"titel":"1 Satz Kernthese ohne HTML","erklaerung":"3-4 Saetze Analyse ohne HTML ohne Sonderzeichen","einstieg":"$XX","kursziel":"$XXX","stopp":"$XX"}`,
  asts: `Analysiere AST SpaceMobile (ASTS). Antworte NUR mit JSON: {"empfehlung":"KAUFEN|HALTEN|VERKAUFEN","score_fundamental":65,"score_momentum":75,"score_risiko":45,"score_bewertung":50,"titel":"1 Satz Kernthese ohne HTML","erklaerung":"3-4 Saetze Analyse ohne HTML ohne Sonderzeichen","einstieg":"$XX","kursziel":"$XXX","stopp":"$XX"}`
};

const NEWS_PROMPTS = {
  rklb: `Search recent RKLB Rocket Lab news (last 48h). Sources: rocketlabusa.com, SEC EDGAR, SpaceNews, Bloomberg, Reuters, Seeking Alpha. Return ONLY valid JSON, no HTML, no cite tags, no line breaks in strings: {"articles":[{"title":"Max 80 chars","sentiment":"pos|neg|neu","body":"2-3 sentences in German, no line breaks","source":"Source name"}]}`,
  asts: `Search recent ASTS AST SpaceMobile news (last 48h). Sources: ast-science.com, SEC EDGAR, SpaceNews, Bloomberg, Reuters, FierceWireless. Return ONLY valid JSON, no HTML, no cite tags, no line breaks in strings: {"articles":[{"title":"Max 80 chars","sentiment":"pos|neg|neu","body":"2-3 sentences in German, no line breaks","source":"Source name"}]}`
};

const SCENARIOS_PROMPTS = {
  rklb: `Analysiere RKLB Kursziele von Analysten (Goldman Sachs, Morgan Stanley, Needham, Canaccord). Suche auf Yahoo Finance, Seeking Alpha, TipRanks. WICHTIG: bull_pct=100 immer, alle pct-Werte zwischen 0-100. Antworte NUR mit JSON, kein HTML, keine cite-Tags, keine Zeilenumbrueche: {"intro":"1 Satz","bull_label":"$XXX","bull_pct":100,"opt_label":"$XXX","opt_pct":56,"base_label":"$XXX","base_pct":40,"bear_label":"$XX","bear_pct":25,"bull_target":216,"base_target":120,"bear_target":86,"bull5yr":450,"base5yr":220,"bear5yr":70,"bull_desc":"Szenario $XXX","base_desc":"Bankexperten $XXX","bear_desc":"Szenario $XX","sentiment":"2 Saetze ohne HTML","sentiment_warning":false,"sentiment_reddit":"Bullish","sentiment_reddit_sub":"1 Satz","sentiment_x":"Bullish","sentiment_x_sub":"1 Satz","sentiment_st":"Neutral","sentiment_st_sub":"1 Satz","sentiment_tg":"Bullish","sentiment_tg_sub":"1 Satz","sentiment_fb":"Neutral","sentiment_fb_sub":"1 Satz"}`,
  asts: `Analysiere ASTS Kursziele von Analysten (Scotiabank, NorthCoast, ASB Securities). Suche auf Yahoo Finance, Seeking Alpha, TipRanks. WICHTIG: bull_pct=100 immer, alle pct-Werte zwischen 0-100. Antworte NUR mit JSON, kein HTML, keine cite-Tags, keine Zeilenumbrueche: {"intro":"1 Satz","bull_label":"$XXX","bull_pct":100,"opt_label":"$XXX","opt_pct":54,"base_label":"$XX","base_pct":40,"bear_label":"$XX","bear_pct":25,"bull_target":200,"base_target":83,"bear_target":50,"bull5yr":380,"base5yr":120,"bear5yr":25,"bull_desc":"Szenario $XXX","base_desc":"Bankexperten $XX","bear_desc":"Szenario $XX","sentiment":"2 Saetze ohne HTML","sentiment_warning":true,"sentiment_reddit":"Bullish","sentiment_reddit_sub":"1 Satz","sentiment_x":"Bullish","sentiment_x_sub":"1 Satz","sentiment_st":"Neutral","sentiment_st_sub":"1 Satz","sentiment_tg":"Bullish","sentiment_tg_sub":"1 Satz","sentiment_fb":"Neutral","sentiment_fb_sub":"1 Satz"}`
};

const SECTOR_PROMPTS = {
  rklb: `Analysiere Sektor-Kontext fuer RKLB. Quellen: SpaceNews, Breaking Defense, defense.gov, nasa.gov. Alle Texte auf Deutsch. Antworte NUR mit JSON, kein HTML, keine cite-Tags, keine Zeilenumbrueche in Strings: {"intro":"1 Satz ohne HTML","cards":[{"emoji":"🚀","name":"SpaceX","val":"Konkurrent","val_color":"purple","desc":"Marktposition vs RKLB ohne Sonderzeichen"},{"emoji":"🛡","name":"Golden Dome","val":"$X Mrd","val_color":"green","desc":"Budget und RKLB-Anteil"},{"emoji":"🛸","name":"SDA Tracking","val":"Status","val_color":"blue","desc":"Tranche-Status RKLB"},{"emoji":"🌕","name":"NASA","val":"Status","val_color":"blue","desc":"Launch-Auftraege RKLB"},{"emoji":"⚔️","name":"Space Force","val":"Budget","val_color":"green","desc":"NSSL Auftraege"},{"emoji":"📦","name":"Amazon Kuiper","val":"Potenzial","val_color":"amber","desc":"Launch-Auftraege Potenzial"}]}`,
  asts: `Analysiere Sektor-Kontext fuer ASTS. Quellen: SpaceNews, FierceWireless, fcc.gov, T-Mobile/AT&T Newsroom. Alle Texte auf Deutsch. Antworte NUR mit JSON, kein HTML, keine cite-Tags, keine Zeilenumbrueche in Strings: {"intro":"1 Satz ohne HTML","cards":[{"emoji":"⚡","name":"Starlink D2D","val":"Konkurrent","val_color":"red","desc":"D2D-Abdeckung vs ASTS"},{"emoji":"📱","name":"AT&T und Verizon","val":"Partner","val_color":"green","desc":"Rollout-Status und Revenue"},{"emoji":"🌍","name":"Globale Carrier","val":"60 Partner","val_color":"blue","desc":"Neue Carrier-Vertraege"},{"emoji":"🛰","name":"Satelliten","val":"X im Orbit","val_color":"blue","desc":"BlueBird Status"},{"emoji":"📡","name":"FCC Lizenzen","val":"Status","val_color":"green","desc":"Regulatorischer Status"},{"emoji":"📦","name":"Kuiper D2D","val":"Zeitplan","val_color":"amber","desc":"Konkurrenz-Bedrohung"}]}`
};

const CTX_PROMPTS = {
  rklb: `Aktuelle Rocket Lab (RKLB) Firmendaten. Quellen: rocketlabusa.com, SEC Filings, letzter Earnings Call. Antworte NUR mit JSON, kein HTML, keine cite-Tags: {"desc":"1-2 Saetze ohne HTML ohne Sonderzeichen","tags":[{"text":"Tag","type":"green"}],"stats":[{"label":"Backlog","val":"$X Mrd"}]}`,
  asts: `Aktuelle AST SpaceMobile (ASTS) Firmendaten. Quellen: ast-science.com, SEC Filings, letzter Earnings Call. Antworte NUR mit JSON, kein HTML, keine cite-Tags: {"desc":"1-2 Saetze ohne HTML ohne Sonderzeichen","tags":[{"text":"Tag","type":"green"}],"stats":[{"label":"Cash","val":"$X Mrd"}]}`
};

const INSIDER_RKLB_PROMPT = `Search RKLB Rocket Lab insider trades last 90 days. Sources: sec.gov Form 4, openinsider.com/RKLB, finviz.com. Return ONLY valid JSON, no HTML, no cite tags, no line breaks, no slashes in name fields: {"trades":[{"name":"First Last","title":"CFO","type":"sell","shares":10000,"price":95.50,"value":955000,"date":"2026-05-15","note":"RSU vesting sale"}],"summary":"1 sentence in German","signal":"bearish"}`;

const INSIDER_ASTS_PROMPT = `Search ASTS AST SpaceMobile insider trades last 90 days. Sources: sec.gov Form 4, openinsider.com/ASTS, finviz.com. Return ONLY valid JSON, no HTML, no cite tags, no line breaks, no slashes in name fields: {"trades":[{"name":"First Last","title":"CEO","type":"sell","shares":5000,"price":120.00,"value":600000,"date":"2026-05-15","note":"RSU vesting sale"}],"summary":"1 sentence in German","signal":"neutral"}`;

const RKLB_KPI_PROMPT = `Search Rocket Lab (RKLB) Q1 2026 financial KPIs. Sources: rocketlabusa.com/investors, SEC EDGAR 10-Q, spacenews.com. Return ONLY valid JSON, no HTML, no cite tags, no line breaks in strings: {"score_gesamt":82,"score_wachstum":88,"score_backlog":92,"score_marge":76,"score_liquiditaet":90,"score_risiko":58,"score_bewertung":38,"umsatz_wert":"$200 Mio","umsatz_yoy":"+121%","umsatz_quelle":"Q1 2026 Earnings","umsatz_datum":"2026-05-07","umsatz_trend":"up","backlog_wert":"$2.2 Mrd","backlog_qoq":"+20%","backlog_mix":"60% Space Systems","backlog_coverage":"2.75x","backlog_quelle":"Q1 2026 Earnings","gross_margin_wert":"38.2%","gross_margin_qoq":"+2.1%","ebitda_wert":"-$55 Mio","liquiditaet_wert":"$2.0 Mrd","liquiditaet_quelle":"Q1 2026 10-Q","neutron_status":"Qualification tests","neutron_erstflug":"H2 2026","neutron_risiko":"Mittel","defense_sda":"$816 Mio Tranche 3","defense_golden_dome":"Raytheon Partner","launches_2026":"21 Starts","launches_2026_note":"Ziel 22 Starts","launch_success":"100%","ev_sales":"PS 60x","analyst_range":"$60-$150","analyst_konsens":"$104","kurs_vs_konsens":"38% ueber Konsens","netloss_wert":"-$55 Mio","interpretation":"2 sentences in German without special chars","haupttreiber":["Backlog","Defense","Gross Margin"],"hauptrisiken":["Neutron-Timing","Hohe Bewertung"]}`;

const ASTS_MILESTONE_PROMPT = `Search AST SpaceMobile (ASTS) Q1 2026 operational KPIs. Sources: ast-science.com/investors, SEC EDGAR 10-Q, fcc.gov, spacenews.com. Return ONLY valid JSON, no HTML, no cite tags, no line breaks in strings: {"score_gesamt":68,"score_cash":82,"score_umsatz_ramp":48,"score_launch":52,"score_technologie":90,"score_partner":85,"score_risiko":48,"score_bewertung":45,"cash_wert":"$3.5 Mrd","cash_datum":"2026-03-31","cash_quelle":"Q1 2026 10-Q","debt_wert":"$2.96 Mrd","cash_runway":"18 Monate","umsatz_wert":"$14.7 Mio","umsatz_yoy":"+1946%","umsatz_datum":"2026-05-11","guidance_2026":"$150-200 Mio","guidance_progress":"10% erreicht","netloss_wert":"-$191 Mio","bb1_5_status":"Im Orbit aktiv","bb1_5_ampel":"gruen","bb6_status":"Im Orbit aktiv","bb6_ampel":"gruen","bb7_status":"Deorbited nach Anomalie","bb7_ampel":"rot","bb8_10_status":"Start Q3 2026","bb8_10_ampel":"gelb","fcc_status":"Genehmigt April 2026","itu_status":"Koordination laeuft","mno_anzahl":60,"mno_aktive":"ATT Verizon Vodafone Rakuten","peak_speed":"98.9 Mbps","ev_sales":"PS 15x","analyst_range":"$80-$250","analyst_konsens":"$150","kurs_vs_konsens":"10% unter Konsens","risk_launch":"Mittel","risk_dilution":"Hoch","risk_konkurrenz":"Starlink D2D aktiv","risk_zeitplan":"Verzoegerungen moeglich","naechster_meilenstein":"BB-8-10 Start Q3 2026","interpretation":"2 sentences in German without special chars","haupttreiber":["Starke Liquiditaet","MNO-Partnernetzwerk","Technologie"],"hauptrisiken":["Launch-Cadence","Hoher Debt","Cashburn"]}`;

const GLOSSAR_PROMPT = `Search 2-3 new finance or space terms from recent RKLB ASTS SpaceX news. Find current Golden Dome program budget. Return ONLY valid JSON, no HTML, no cite tags: {"golden_dome_def":"US missile defense program, current budget and RKLB role","terms":[{"term":"Term","def":"Short German explanation without special chars"}]}`;

const GOV_RKLB_PROMPT = `Search current US government contracts for Rocket Lab (RKLB). Sources: defense.gov, sda.mil, nasa.gov, breakingdefense.com, spacenews.com. Return ONLY valid JSON, no HTML, no cite tags, no line breaks in strings: {"golden_dome":{"budget":"$X Mrd","rklb_anteil":"$X Mio","status":"Status","desc":"1-2 sentences RKLB relevance"},"sda":{"budget":"$X Mrd","rklb_auftraege":"X contracts $X Mio","status":"Status","desc":"1-2 sentences SDA Tranche"},"nasa":{"program":"VCLS/CLPS","wert":"$X Mio","status":"Status","desc":"1 sentence"},"space_force":{"program":"NSSL","wert":"$X Mio","status":"Status","desc":"1 sentence"},"ausblick":"1 sentence RKLB government revenue outlook"}`;

const GOV_ASTS_PROMPT = `Search current US regulatory status for AST SpaceMobile (ASTS). Sources: fcc.gov, itu.int, ntia.gov, spacenews.com. Return ONLY valid JSON, no HTML, no cite tags, no line breaks in strings: {"fcc":{"status":"License status","frequenz":"Frequency band","desc":"1-2 sentences FCC approval status"},"itu":{"status":"Status","desc":"1 sentence international coordination"},"dod":{"potenzial":"High/Medium/Low","desc":"1-2 sentences DoD potential"},"ntia":{"status":"Status","desc":"1 sentence"},"ausblick":"1 sentence ASTS regulatory outlook"}`;

const SPCX_NEWS_PROMPT = `Search recent SpaceX news last 48h. Sources: spacex.com, Reuters, Bloomberg, SpaceNews, nasaspaceflight.com. Return ONLY valid JSON, no HTML, no cite tags, no line breaks in strings: {"articles":[{"title":"Max 80 chars","sentiment":"pos|neg|neu","body":"2-3 sentences in German no line breaks","source":"Source name"}]}`;

const SPCX_SECTOR_PROMPT = `Search current SpaceX market data and IPO status. Sources: spacenews.com, reuters.com, bloomberg.com. Return ONLY valid JSON, no HTML, no cite tags: {"intro":"1 sentence market position","ipo_status":"IPO status 2026","ipo_date":"planned date","bewertung":"valuation","cards":[{"emoji":"🛸","name":"Starlink","val":"user count","val_color":"green","desc":"status"},{"emoji":"🚀","name":"Falcon 9","val":"launches 2026","val_color":"blue","desc":"market share"},{"emoji":"⭐","name":"Starship","val":"status","val_color":"amber","desc":"development"},{"emoji":"🏆","name":"Market share","val":"percent","val_color":"green","desc":"commercial"}]}`;

const SPCX_GOV_PROMPT = `Search SpaceX government contracts and FAA licenses. Sources: nasa.gov, faa.gov, spaceforce.mil, spacenews.com. Return ONLY valid JSON, no HTML, no cite tags, no line breaks in strings: {"faa":{"status":"license status","desc":"Starship FAA approvals"},"nasa":{"wert":"$X Mrd","desc":"Artemis HLS CRS contracts"},"space_force":{"wert":"$X Mrd","desc":"NSSL launch contracts"},"sec":{"status":"filing status","desc":"IPO progress"}}`;

const SPCX_CTX_PROMPT = `Current SpaceX company data. Sources: spacex.com, reuters.com, bloomberg.com, spacenews.com. Return ONLY valid JSON, no HTML, no cite tags, no line breaks in strings: {"desc":"1-2 sentences current status without special chars","tags":[{"text":"Rockets","type":"blue"},{"text":"Starlink","type":"green"},{"text":"IPO 2026","type":"amber"}],"stats":[{"label":"Valuation","val":"$XXX Mrd"},{"label":"Employees","val":"~13000"},{"label":"Launches 2025","val":"X"}]}`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { scope } = req.query;
  console.log('Cron starting, scope:', scope || 'all');

  const allCalls = [
    { ticker:'rklb', section:'rec',        prompt: REC_PROMPTS.rklb },
    { ticker:'asts', section:'rec',        prompt: REC_PROMPTS.asts },
    { ticker:'rklb', section:'news',       prompt: NEWS_PROMPTS.rklb },
    { ticker:'asts', section:'news',       prompt: NEWS_PROMPTS.asts },
    { ticker:'rklb', section:'scenarios',  prompt: SCENARIOS_PROMPTS.rklb },
    { ticker:'asts', section:'scenarios',  prompt: SCENARIOS_PROMPTS.asts },
    { ticker:'rklb', section:'sector',     prompt: SECTOR_PROMPTS.rklb },
    { ticker:'asts', section:'sector',     prompt: SECTOR_PROMPTS.asts },
    { ticker:'rklb', section:'ctx',        prompt: CTX_PROMPTS.rklb },
    { ticker:'asts', section:'ctx',        prompt: CTX_PROMPTS.asts },
    { ticker:null,   section:'glossar',    prompt: GLOSSAR_PROMPT },
    { ticker:'rklb', section:'kpi',        prompt: RKLB_KPI_PROMPT },
    { ticker:'asts', section:'milestone',  prompt: ASTS_MILESTONE_PROMPT },
    { ticker:'rklb', section:'insider',    prompt: INSIDER_RKLB_PROMPT },
    { ticker:'asts', section:'insider',    prompt: INSIDER_ASTS_PROMPT },
    { ticker:'rklb', section:'gov_space',  prompt: GOV_RKLB_PROMPT },
    { ticker:'asts', section:'gov_space',  prompt: GOV_ASTS_PROMPT },
    { ticker:'spcx', section:'news',       prompt: SPCX_NEWS_PROMPT },
    { ticker:'spcx', section:'sector',     prompt: SPCX_SECTOR_PROMPT },
    { ticker:'spcx', section:'gov_space',  prompt: SPCX_GOV_PROMPT },
    { ticker:'spcx', section:'ctx',        prompt: SPCX_CTX_PROMPT },
  ];

  // Scope filtering
  const fastSections = new Set(['rec','news','scenarios']);
  const slowSections = new Set(['sector','ctx','glossar','kpi','milestone','insider','gov_space']);

  let calls = allCalls;
  if (scope === 'rklb')       calls = allCalls.filter(c => c.ticker === 'rklb');
  else if (scope === 'asts')  calls = allCalls.filter(c => c.ticker === 'asts');
  else if (scope === 'spcx')  calls = allCalls.filter(c => c.ticker === 'spcx');
  else if (scope === 'rklb_news') calls = allCalls.filter(c => c.ticker==='rklb' && fastSections.has(c.section));
  else if (scope === 'asts_news') calls = allCalls.filter(c => c.ticker==='asts' && fastSections.has(c.section));
  else if (scope === 'global') calls = allCalls.filter(c => c.section === 'glossar');
  else if (scope === 'all_fast') calls = allCalls.filter(c => fastSections.has(c.section));
  else if (scope === 'all_slow') calls = allCalls.filter(c => slowSections.has(c.section));

  console.log(`Running ${calls.length} calls for scope: ${scope||'all'}`);

  const failed = [];
  let succeeded = 0;

  for (let i = 0; i < calls.length; i++) {
    const { ticker, section, prompt } = calls[i];
    try {
      const data = await kiCall(prompt);
      await saveToCache(section, ticker, data);
      succeeded++;
    } catch(e) {
      console.error(`Failed: ${ticker} ${section} — ${e.message}`);
      failed.push(`${ticker}/${section}`);
    }
    if (i < calls.length - 1) await delay(2000);
  }

  // Log errors to Supabase for dashboard alert
  if (failed.length > 0) {
    try {
      await saveToCache('cron_errors', 'system', { failed, timestamp: new Date().toISOString() });
    } catch(_) {}
  }

  console.log(`Done: ${succeeded}/${calls.length} succeeded, ${failed.length} failed`);
  return res.status(200).json({ ok: true, succeeded, failed });
}
