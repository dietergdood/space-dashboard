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

    // If no JSON braces found, check for refusal
    if (firstBrace === -1 || lastBrace === -1) {
      const refusalPhrases = [
        'I cannot provide', 'cannot provide the response',
        'I must inform you that I cannot', 'citation guidelines',
        'Ich bin nicht in der Lage'
      ];
      const isRefusal = refusalPhrases.some(p => raw.includes(p));
      if (isRefusal) {
        console.error('Model refused to return JSON:', raw.substring(0,150));
      } else {
        console.error('No JSON found. Raw:', raw.substring(0,300));
      }
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
    const body = [{
      ticker: ticker || 'global',
      section,
      data,
      updated_at: new Date().toISOString()
    }];
    // Use PATCH upsert with merge-duplicates to update existing rows
    const opts = {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal,resolution=merge-duplicates',
      },
      body: JSON.stringify(body)
    };
    const r = await fetch(`${SUPABASE_URL}/rest/v1/ki_cache?on_conflict=ticker,section`, opts);
    if (!r.ok) {
      const errText = await r.text();
      throw new Error(`Supabase ${r.status}: ${errText}`);
    }
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
  rklb: `Analysiere Rocket Lab (RKLB). JSON only: {"empfehlung":"KAUFEN","titel":"1 Satz Kernthese","begruendung":"3-4 Saetze Analyse","fundamentals":8,"momentum":8,"risiko":6,"bewertung":4,"explain_fundamentals":"Fundamentals — 1 Satz","explain_momentum":"Momentum — 1 Satz","explain_risiko":"Risiko — Hoeherer Score = niedrigeres Risiko. 1 Satz","explain_bewertung":"Bewertung — 1 Satz","einstieg":"$XX","kursziel":"$XXX","stopp":"$XX","lage":"Aktuelle Lage: 1 Satz","lage_typ":"positive","analysten":"Xx Kaufen Xx Halten"}`,
  asts: `Analysiere AST SpaceMobile (ASTS). JSON only: {"empfehlung":"HALTEN","titel":"1 Satz Kernthese","begruendung":"3-4 Saetze Analyse","fundamentals":6,"momentum":6,"risiko":4,"bewertung":4,"explain_fundamentals":"Fundamentals — 1 Satz","explain_momentum":"Momentum — 1 Satz","explain_risiko":"Risiko — Hoeherer Score = niedrigeres Risiko. 1 Satz","explain_bewertung":"Bewertung — 1 Satz","einstieg":"$XX","kursziel":"$XXX","stopp":"$XX","lage":"Aktuelle Lage: 1 Satz","lage_typ":"neutral","analysten":"Xx Kaufen Xx Halten"}`
};

const NEWS_PROMPTS = {
  rklb: `RKLB Rocket Lab news last 48h. Fill with real recent events. JSON only: {"articles":[{"title":"Max 80 chars","sentiment":"pos|neg|neu","body":"Nachrichtentext auf Deutsch","source":"Source name"}]}`,
  asts: `ASTS AST SpaceMobile news last 48h. Fill with real recent events. JSON only: {"articles":[{"title":"Max 80 chars","sentiment":"pos|neg|neu","body":"Nachrichtentext auf Deutsch","source":"Source name"}]}`
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
  rklb: `Aktuelle Rocket Lab (RKLB) Firmendaten. Quellen: rocketlabusa.com, SEC Filings, letzter Earnings Call. Antworte NUR mit JSON, kein HTML, keine cite-Tags: {"desc":"Firmenbeschreibung auf Deutsch","tags":[{"text":"Tag","type":"green"}],"stats":[{"label":"Backlog","val":"$X Mrd"}]}`,
  asts: `Aktuelle AST SpaceMobile (ASTS) Firmendaten. Quellen: ast-science.com, SEC Filings, letzter Earnings Call. Antworte NUR mit JSON, kein HTML, keine cite-Tags: {"desc":"Firmenbeschreibung auf Deutsch","tags":[{"text":"Tag","type":"green"}],"stats":[{"label":"Cash","val":"$X Mrd"}]}`
};

const INSIDER_RKLB_PROMPT = `RKLB Rocket Lab insider trades last 90 days from SEC Form 4. Fill with real trades. JSON only, no slashes in name fields: {"trades":[{"name":"First Last","title":"CFO","type":"sell","shares":10000,"price":95.50,"value":955000,"date":"2026-05-15","note":"RSU-Verkauf zur Steuerdeckung"}],"summary":"Zusammenfassung auf Deutsch","signal":"bearish"}`;

const INSIDER_ASTS_PROMPT = `ASTS AST SpaceMobile insider trades last 90 days from SEC Form 4. Fill with real trades. JSON only, no slashes in name fields: {"trades":[{"name":"First Last","title":"CEO","type":"sell","shares":5000,"price":120.00,"value":600000,"date":"2026-05-15","note":"RSU-Verkauf zur Steuerdeckung"}],"summary":"Zusammenfassung auf Deutsch","signal":"neutral"}`;

const RKLB_KPI_PROMPT = `Search Rocket Lab (RKLB) Q1 2026 financial results. Find revenue, backlog, gross margin, cash. Fill in real numbers. Respond with ONLY this JSON, no commentary: {"score_gesamt":82,"score_wachstum":88,"score_backlog":92,"score_marge":76,"score_liquiditaet":90,"score_risiko":58,"score_bewertung":38,"umsatz_wert":"$X Mio","umsatz_yoy":"+X%","umsatz_quelle":"Q1 2026","umsatz_datum":"2026-05-07","umsatz_trend":"up","backlog_wert":"$X Mrd","backlog_qoq":"+X%","backlog_mix":"X% Space Systems","backlog_coverage":"X.Xx","backlog_quelle":"Q1 2026","gross_margin_wert":"X%","gross_margin_qoq":"+X%","ebitda_wert":"-$X Mio","liquiditaet_wert":"$X Mrd","liquiditaet_quelle":"Q1 2026","neutron_status":"Status","neutron_erstflug":"H2 2026","neutron_risiko":"Mittel","defense_sda":"$X Mio","defense_golden_dome":"Partner","launches_2026":"X Starts","launches_2026_note":"Target X","launch_success":"X%","ev_sales":"PS Xx","analyst_range":"$X-$X","analyst_konsens":"$X","kurs_vs_konsens":"X%","netloss_wert":"-$X Mio","interpretation":"Analyse auf Deutsch","haupttreiber":["Backlog-Wachstum","Defense","Bruttomarge"],"hauptrisiken":["Neutron-Timing","Hohe Bewertung"]}`;

const ASTS_MILESTONE_PROMPT = `Search AST SpaceMobile (ASTS) Q1 2026 data. Find: cash position, BlueBird satellite status, FCC license, MNO partners, revenue. Fill in real numbers. Respond with ONLY this JSON, no commentary: {"score_gesamt":68,"score_cash":82,"score_umsatz_ramp":48,"score_launch":52,"score_technologie":90,"score_partner":85,"score_risiko":48,"score_bewertung":45,"cash_wert":"$X Mrd","cash_datum":"2026-03-31","cash_quelle":"Q1 2026","debt_wert":"$X Mrd","cash_runway":"X months","umsatz_wert":"$X Mio","umsatz_yoy":"+X%","umsatz_datum":"2026-05","guidance_2026":"$X-X Mio","guidance_progress":"X% reached","netloss_wert":"-$X Mio","bb1_5_status":"In orbit","bb1_5_ampel":"gruen","bb6_status":"In orbit","bb6_ampel":"gruen","bb7_status":"Deorbited","bb7_ampel":"rot","bb8_10_status":"Q3 2026 launch","bb8_10_ampel":"gelb","fcc_status":"Approved","itu_status":"Ongoing","mno_anzahl":60,"mno_aktive":"ATT Verizon Vodafone","peak_speed":"98 Mbps","ev_sales":"PS X","analyst_range":"$X-$X","analyst_konsens":"$X","kurs_vs_konsens":"X%","risk_launch":"Mittel","risk_dilution":"Hoch","risk_konkurrenz":"Starlink D2D","risk_zeitplan":"Delays possible","naechster_meilenstein":"BB-8-10 Q3 2026","interpretation":"Analyse auf Deutsch","haupttreiber":["Starke Liquiditaet","MNO-Partner","Technologie"],"hauptrisiken":["Verwässerung","Schulden","Zeitplan"]}`;

const GLOSSAR_PROMPT = `Finance and space terms from recent RKLB ASTS SpaceX news. Current Golden Dome budget. Fill with real data. JSON only: {"golden_dome_def":"US missile defense program, current budget and RKLB role","terms":[{"term":"Term","def":"Short German explanation without special chars"}]}`;

const GOV_RKLB_PROMPT = `What US government contracts does Rocket Lab have in 2026? JSON only, no prose outside JSON: {"golden_dome":{"budget":"$X Mrd","rklb_anteil":"$X Mio","status":"active","desc":"Beschreibung auf Deutsch"},"sda":{"budget":"$X Mrd","rklb_auftraege":"$X Mio","status":"active","desc":"Beschreibung auf Deutsch"},"nasa":{"program":"VCLS","wert":"$X Mio","status":"active","desc":"Beschreibung auf Deutsch"},"space_force":{"program":"NSSL","wert":"$X Mio","status":"active","desc":"Beschreibung auf Deutsch"},"ausblick":"Umsatzausblick auf Deutsch"}`;

const GOV_ASTS_PROMPT = `AST SpaceMobile (ASTS) regulatory status 2026: FCC, ITU, DoD, NTIA. Fill with real data. JSON only: {"fcc":{"status":"License status","frequenz":"Frequency band","desc":"Beschreibung auf Deutsch"},"itu":{"status":"Status","desc":"Beschreibung auf Deutsch"},"dod":{"potenzial":"High/Medium/Low","desc":"Beschreibung auf Deutsch"},"ntia":{"status":"Status","desc":"Beschreibung auf Deutsch"},"ausblick":"Regulierungsausblick"}`;

const SPCX_NEWS_PROMPT = `SpaceX news last 48 hours. Fill with real recent events. JSON only: {"articles":[{"title":"Max 80 chars","sentiment":"pos|neg|neu","body":"Nachrichtentext auf Deutsch","source":"Source name"}]}`;

const SPCX_SECTOR_PROMPT = `SpaceX market position 2026: Starlink users, Falcon 9 launches, Starship status, market share. Fill with real data. JSON only: {"intro":"market position","ipo_status":"status","ipo_date":"date","bewertung":"$X Trd","cards":[{"emoji":"🛸","name":"Starlink","val":"X Mio users","val_color":"green","desc":"status"},{"emoji":"🚀","name":"Falcon 9","val":"X launches","val_color":"blue","desc":"market share"},{"emoji":"⭐","name":"Starship","val":"status","val_color":"amber","desc":"development"},{"emoji":"🏆","name":"Market share","val":"X%","val_color":"green","desc":"commercial"}]}`;

const SPCX_GOV_PROMPT = `SpaceX government contracts 2026: FAA Starship license, NASA Artemis HLS, Space Force NSSL, SEC IPO filing. Fill with real current data. JSON only: {"faa":{"status":"status","desc":"Beschreibung auf Deutsch"},"nasa":{"wert":"$X Mrd","desc":"Beschreibung auf Deutsch"},"space_force":{"wert":"$X Mrd","desc":"Beschreibung auf Deutsch"},"sec":{"status":"status","desc":"Beschreibung auf Deutsch"}}`;

const SPCX_CTX_PROMPT = `SpaceX company facts 2026. Fill with real data. JSON only: {"desc":"aktueller Status","tags":[{"text":"Rockets","type":"blue"},{"text":"Starlink","type":"green"},{"text":"IPO 2026","type":"amber"}],"stats":[{"label":"Valuation","val":"$XXX Mrd"},{"label":"Employees","val":"~13000"},{"label":"Launches 2025","val":"X"}]}`;

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

  // Group by ticker and run each ticker's calls in parallel (max 3 concurrent)
  // This fits 14 calls in ~120s instead of ~300s
  async function runCall(c) {
    try {
      const data = await kiCall(c.prompt);
      await saveToCache(c.section, c.ticker, data);
      succeeded++;
    } catch(e) {
      console.error(`Failed: ${c.ticker} ${c.section} — ${e.message}`);
      failed.push(`${c.ticker||'global'}/${c.section}`);
    }
  }

  // Run in batches of 3 to avoid rate limits
  const batchSize = 3;
  for (let i = 0; i < calls.length; i += batchSize) {
    const batch = calls.slice(i, i + batchSize);
    await Promise.all(batch.map(c => runCall(c)));
    if (i + batchSize < calls.length) await delay(2000);
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
