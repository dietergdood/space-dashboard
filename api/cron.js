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
    // Remove cite tags, keep inner text
    .replace(/<(?:antml:)?cite[^>]*>([\s\S]*?)<\/(?:antml:)?cite>/g, '$1')
    // Remove all remaining HTML tags
    .replace(/<[^>]+>/g, '')
    // Fix unescaped newlines inside strings (common cause of parse failures)
    .replace(/("(?:[^"\\]|\\.)*")/g, m => m.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t'))
    // Remove trailing commas before } or ]
    .replace(/,(\s*[}\]])/g, '$1')
    .trim();
}

// Global für alle KI-Prompts: erzwingt kompaktes, parsbares JSON (Opus 5 zitiert/formatiert sonst gern)
const JSON_STYLE = 'WICHTIG: Antworte AUSSCHLIESSLICH mit einem einzigen JSON-Objekt. Keine Markdown-Codefences, keine <cite>-Tags, keine Quellenangaben oder Fussnoten im Text, keine Zeilenumbrueche in Strings, Strings kurz halten. ';

async function kiCall(prompt, retries=3, maxSearches=8, model='claude-opus-5') {
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
          max_tokens: 12000, // Opus 5: max_tokens = Thinking + sichtbarer Text — grosszügig ansetzen
          output_config: { effort: 'medium' }, // weniger Thinking-Tokens, reicht für JSON-Research
          tools: [{type: 'web_search_20250305', name: 'web_search', max_uses: maxSearches}],
          messages: [{role: 'user', content: JSON_STYLE + prompt}]
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

    // Strip citation tags the model may embed despite instructions
    jsonStr = jsonStr.replace(/<\/?(?:antml:)?cite[^>]*>/g, '');

    // Extract JSON object (from first { to last })
    const firstBrace = jsonStr.indexOf('{');
    const lastBrace = jsonStr.lastIndexOf('}');

    // If no opening brace found, check for refusal
    if (firstBrace === -1) {
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
    let extracted = lastBrace > firstBrace
      ? jsonStr.substring(firstBrace, lastBrace + 1)
      : jsonStr.substring(firstBrace); // abgeschnittene Antwort — Reparatur versuchen

    // Strategy 1: direct parse
    try { return JSON.parse(extracted); } catch(_) {}

    // Strategy 2: sanitize then parse
    try { return JSON.parse(sanitizeJson(extracted)); } catch(_) {}

    // Strategy 3: fix newlines in strings
    try {
      const fixed = extracted.replace(/\r?\n/g, ' ').replace(/\t/g, ' ');
      return JSON.parse(fixed);
    } catch(_) {}

    // Strategy 4: repair truncated JSON (cut at last complete value, close open braces/brackets)
    try {
      const repaired = repairTruncatedJson(extracted);
      if (repaired) {
        console.log('JSON repaired from truncated response');
        return repaired;
      }
    } catch(_) {}

    // Strategy 5: salvage known structures
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

// ── Repariert abgeschnittenes JSON: schneidet beim letzten vollständigen Wert ab und schliesst Klammern ──
function repairTruncatedJson(str) {
  let s = str.replace(/\r?\n/g, ' ').replace(/\t/g, ' ');
  for (let attempt = 0; attempt < 40; attempt++) {
    // Offene Klammern zählen (Strings dabei überspringen)
    let depth = [], inStr = false, esc = false;
    for (const ch of s) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{' || ch === '[') depth.push(ch);
      if (ch === '}' || ch === ']') depth.pop();
    }
    let candidate = s;
    if (inStr) candidate += '"';                       // offenen String schliessen
    candidate = candidate.replace(/,\s*$/, '');        // hängendes Komma weg
    candidate = candidate.replace(/"[^"]*"\s*:\s*$/, '""'); // hängender Key ohne Wert
    candidate = candidate.replace(/,\s*$/, '');
    for (let i = depth.length - 1; i >= 0; i--) candidate += depth[i] === '{' ? '}' : ']';
    try { return JSON.parse(candidate); } catch(_) {}
    // Weiter zurückschneiden: bis zum letzten Komma oder Klammer-Ende
    const cut = Math.max(s.lastIndexOf(','), s.lastIndexOf('}'), s.lastIndexOf(']'));
    if (cut <= 0) return null;
    s = s.substring(0, cut);
  }
  return null;
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
  rklb: `Analysiere Rocket Lab (RKLB) aktuell. JSON only: {"empfehlung":"KAUFEN","titel":"Kernthese auf Deutsch","begruendung":"3-4 Saetze Analyse auf Deutsch","fundamentals":8,"momentum":8,"risiko":6,"bewertung":4,"explain_fundamentals":"Fundamentals — operative Lage auf Deutsch","explain_momentum":"Momentum — Kurstrend auf Deutsch","explain_risiko":"Risiko — Hoeherer Score = niedrigeres Risiko. Risikobewertung auf Deutsch","explain_bewertung":"Bewertung — Bewertungskommentar auf Deutsch","einstieg":"$130 (unter aktuellem Kurs oder aktueller Kurs bei KAUFEN)","kursziel":"$175 (Ziel hoeher als Einstieg)","stopp":"$100 (Stopp tiefer als Einstieg)","lage":"<b>Aktuelle Lage:</b> 2-3 Saetze operative News auf Deutsch: aktuellste Auftraege Launches Quartalszahlen Partnerschaften — keine Kurszahlen","lage_typ":"positive","analysten":"Xx Kaufen Xx Halten","earnings_date":"YYYY-MM-DD naechste Quartalszahlen falls bekannt"}`,
  asts: `Analysiere AST SpaceMobile (ASTS) aktuell. JSON only: {"empfehlung":"HALTEN","titel":"Kernthese auf Deutsch","begruendung":"3-4 Saetze Analyse auf Deutsch","fundamentals":6,"momentum":6,"risiko":4,"bewertung":4,"explain_fundamentals":"Fundamentals — operative Lage auf Deutsch","explain_momentum":"Momentum — Kurstrend auf Deutsch","explain_risiko":"Risiko — Hoeherer Score = niedrigeres Risiko. Risikobewertung auf Deutsch","explain_bewertung":"Bewertung — Bewertungskommentar auf Deutsch","einstieg":"$110 (unter aktuellem Kurs oder aktueller Kurs bei KAUFEN)","kursziel":"$150 (Ziel hoeher als Einstieg)","stopp":"$85 (Stopp tiefer als Einstieg)","lage":"<b>Aktuelle Lage:</b> 2-3 Saetze operative News auf Deutsch: aktuellste Satellitenstatus Carrier-Partner FCC-Lizenzen Quartalszahlen — keine Kurszahlen","lage_typ":"neutral","analysten":"Xx Kaufen Xx Halten","earnings_date":"YYYY-MM-DD naechste Quartalszahlen falls bekannt"}`,
  spcx: `Analysiere SpaceX (NASDAQ: SPCX, boersennotiert seit Juni 2026, IPO $135) aktuell. JSON only: {"empfehlung":"HALTEN","titel":"Kernthese auf Deutsch","begruendung":"3-4 Saetze Analyse auf Deutsch","fundamentals":7,"momentum":6,"risiko":4,"bewertung":2,"explain_fundamentals":"Fundamentals — operative Lage auf Deutsch","explain_momentum":"Momentum — Kurstrend auf Deutsch","explain_risiko":"Risiko — Hoeherer Score = niedrigeres Risiko. Risikobewertung auf Deutsch","explain_bewertung":"Bewertung — Bewertungskommentar auf Deutsch","einstieg":"$130 (unter aktuellem Kurs oder aktueller Kurs bei KAUFEN)","kursziel":"$185 (Ziel hoeher als Einstieg)","stopp":"$110 (Stopp tiefer als Einstieg)","lage":"<b>Aktuelle Lage:</b> 2-3 Saetze operative News auf Deutsch: Starship Testfluege Starlink Nutzerzahlen xAI Quartalszahlen NASA-Auftraege — keine Kurszahlen","lage_typ":"neutral","analysten":"Xx Kaufen Xx Halten","earnings_date":"YYYY-MM-DD naechste Quartalszahlen falls bekannt"}`,
  oklo: `Analysiere Oklo Inc (NYSE: OKLO, Kernreaktor-Entwickler, Aurora 75 MWe) aktuell. JSON only: {"empfehlung":"HALTEN","titel":"Kernthese auf Deutsch","begruendung":"3-4 Saetze Analyse auf Deutsch","fundamentals":4,"momentum":6,"risiko":3,"bewertung":3,"explain_fundamentals":"Fundamentals — operative Lage auf Deutsch (noch kein Umsatz)","explain_momentum":"Momentum — Kurstrend auf Deutsch","explain_risiko":"Risiko — Hoeherer Score = niedrigeres Risiko. Risikobewertung auf Deutsch","explain_bewertung":"Bewertung — Bewertungskommentar auf Deutsch","einstieg":"$55 (unter aktuellem Kurs oder aktueller Kurs bei KAUFEN)","kursziel":"$95 (Ziel hoeher als Einstieg)","stopp":"$40 (Stopp tiefer als Einstieg)","lage":"<b>Aktuelle Lage:</b> 2-3 Saetze operative News auf Deutsch: NRC-Lizenzierung Aurora-Baufortschritt neue Kundenvertraege Meta Switch Equinix Quartalszahlen — keine Kurszahlen","lage_typ":"neutral","analysten":"Xx Kaufen Xx Halten","earnings_date":"YYYY-MM-DD naechste Quartalszahlen falls bekannt"}`
};

const NEWS_PROMPTS = {
  rklb: `RKLB Rocket Lab news last 48h. Fill with real recent events. JSON only: {"articles":[{"title":"Max 80 chars","sentiment":"pos|neg|neu","body":"Nachrichtentext auf Deutsch","source":"Source name"}]}`,
  asts: `ASTS AST SpaceMobile news last 48h. Fill with real recent events. JSON only: {"articles":[{"title":"Max 80 chars","sentiment":"pos|neg|neu","body":"Nachrichtentext auf Deutsch","source":"Source name"}]}`,
  spcx: `SPCX SpaceX stock news last 48h (Starship, Starlink, xAI, NASA, share price drivers). Fill with real recent events. JSON only: {"articles":[{"title":"Max 80 chars","sentiment":"pos|neg|neu","body":"Nachrichtentext auf Deutsch","source":"Source name"}]}`,
  oklo: `OKLO Oklo Inc news last 48h (NRC licensing, Aurora reactor, data center deals, nuclear sector). Fill with real recent events. JSON only: {"articles":[{"title":"Max 80 chars","sentiment":"pos|neg|neu","body":"Nachrichtentext auf Deutsch","source":"Source name"}]}`
};

const SCENARIOS_PROMPTS = {
  rklb: `Analysiere RKLB Kursziele von Analysten (Goldman Sachs, Morgan Stanley, Needham, Canaccord). Suche auf Yahoo Finance, Seeking Alpha, TipRanks. WICHTIG: bull_pct=100 immer, alle pct-Werte zwischen 0-100. Antworte NUR mit JSON, kein HTML, keine cite-Tags, keine Zeilenumbrueche: {"intro":"1 Satz","bull_label":"$XXX","bull_pct":100,"opt_label":"$XXX","opt_pct":56,"base_label":"$XXX","base_pct":40,"bear_label":"$XX","bear_pct":25,"bull_target":216,"base_target":120,"bear_target":86,"bull5yr":450,"base5yr":220,"bear5yr":70,"bull_desc":"Szenario $XXX","base_desc":"Bankexperten $XXX","bear_desc":"Szenario $XX","sentiment":"2 Saetze ohne HTML","sentiment_warning":false,"sentiment_reddit":"Bullish","sentiment_reddit_sub":"1 Satz","sentiment_x":"Bullish","sentiment_x_sub":"1 Satz","sentiment_st":"Neutral","sentiment_st_sub":"1 Satz","sentiment_tg":"Bullish","sentiment_tg_sub":"1 Satz","sentiment_fb":"Neutral","sentiment_fb_sub":"1 Satz"}`,
  asts: `Analysiere ASTS Kursziele von Analysten (Scotiabank, NorthCoast, ASB Securities). Suche auf Yahoo Finance, Seeking Alpha, TipRanks. WICHTIG: bull_pct=100 immer, alle pct-Werte zwischen 0-100. Antworte NUR mit JSON, kein HTML, keine cite-Tags, keine Zeilenumbrueche: {"intro":"1 Satz","bull_label":"$XXX","bull_pct":100,"opt_label":"$XXX","opt_pct":54,"base_label":"$XX","base_pct":40,"bear_label":"$XX","bear_pct":25,"bull_target":200,"base_target":83,"bear_target":50,"bull5yr":380,"base5yr":120,"bear5yr":25,"bull_desc":"Szenario $XXX","base_desc":"Bankexperten $XX","bear_desc":"Szenario $XX","sentiment":"2 Saetze ohne HTML","sentiment_warning":true,"sentiment_reddit":"Bullish","sentiment_reddit_sub":"1 Satz","sentiment_x":"Bullish","sentiment_x_sub":"1 Satz","sentiment_st":"Neutral","sentiment_st_sub":"1 Satz","sentiment_tg":"Bullish","sentiment_tg_sub":"1 Satz","sentiment_fb":"Neutral","sentiment_fb_sub":"1 Satz"}`,
  spcx: `Analysiere SpaceX (SPCX) Kursziele von Analysten (Morgan Stanley, Goldman Sachs, CFRA, Morningstar). Suche auf Yahoo Finance, Seeking Alpha, TipRanks, CNBC. WICHTIG: bull_pct=100 immer, alle pct-Werte zwischen 0-100. Antworte NUR mit JSON, kein HTML, keine cite-Tags, keine Zeilenumbrueche: {"intro":"1 Satz","bull_label":"$XXX","bull_pct":100,"opt_label":"$XXX","opt_pct":60,"base_label":"$XXX","base_pct":45,"bear_label":"$XXX","bear_pct":30,"bull_target":250,"base_target":165,"bear_target":110,"bull5yr":500,"base5yr":260,"bear5yr":90,"bull_desc":"Szenario $XXX","base_desc":"Bankexperten $XXX","bear_desc":"Szenario $XXX","sentiment":"2 Saetze ohne HTML","sentiment_warning":true,"sentiment_reddit":"Bullish","sentiment_reddit_sub":"1 Satz","sentiment_x":"Bullish","sentiment_x_sub":"1 Satz","sentiment_st":"Neutral","sentiment_st_sub":"1 Satz","sentiment_tg":"Neutral","sentiment_tg_sub":"1 Satz","sentiment_fb":"Neutral","sentiment_fb_sub":"1 Satz"}`,
  oklo: `Analysiere Oklo (OKLO) Kursziele von Analysten (Citi, BofA, Wedbush, B. Riley, Seaport). Suche auf Yahoo Finance, Seeking Alpha, TipRanks. WICHTIG: bull_pct=100 immer, alle pct-Werte zwischen 0-100. Antworte NUR mit JSON, kein HTML, keine cite-Tags, keine Zeilenumbrueche: {"intro":"1 Satz","bull_label":"$XXX","bull_pct":100,"opt_label":"$XXX","opt_pct":55,"base_label":"$XX","base_pct":40,"bear_label":"$XX","bear_pct":25,"bull_target":140,"base_target":85,"bear_target":40,"bull5yr":300,"base5yr":120,"bear5yr":25,"bull_desc":"Szenario $XXX","base_desc":"Bankexperten $XX","bear_desc":"Szenario $XX","sentiment":"2 Saetze ohne HTML","sentiment_warning":true,"sentiment_reddit":"Bullish","sentiment_reddit_sub":"1 Satz","sentiment_x":"Bullish","sentiment_x_sub":"1 Satz","sentiment_st":"Neutral","sentiment_st_sub":"1 Satz","sentiment_tg":"Neutral","sentiment_tg_sub":"1 Satz","sentiment_fb":"Neutral","sentiment_fb_sub":"1 Satz"}`
};

const SECTOR_PROMPTS = {
  rklb: `Analysiere Sektor-Kontext fuer RKLB. Quellen: SpaceNews, Breaking Defense, defense.gov, nasa.gov. Alle Texte auf Deutsch. Antworte NUR mit JSON, kein HTML, keine cite-Tags, keine Zeilenumbrueche in Strings: {"intro":"1 Satz ohne HTML","cards":[{"emoji":"🚀","name":"SpaceX","val":"Konkurrent","val_color":"purple","desc":"Marktposition vs RKLB ohne Sonderzeichen"},{"emoji":"🛡","name":"Golden Dome","val":"$X Mrd","val_color":"green","desc":"Budget und RKLB-Anteil"},{"emoji":"🛸","name":"SDA Tracking","val":"Status","val_color":"blue","desc":"Tranche-Status RKLB"},{"emoji":"🌕","name":"NASA","val":"Status","val_color":"blue","desc":"Launch-Auftraege RKLB"},{"emoji":"⚔️","name":"Space Force","val":"Budget","val_color":"green","desc":"NSSL Auftraege"},{"emoji":"📦","name":"Amazon Kuiper","val":"Potenzial","val_color":"amber","desc":"Launch-Auftraege Potenzial"}]}`,
  asts: `Analysiere Sektor-Kontext fuer ASTS. Quellen: SpaceNews, FierceWireless, fcc.gov, T-Mobile/AT&T Newsroom. Alle Texte auf Deutsch. Antworte NUR mit JSON, kein HTML, keine cite-Tags, keine Zeilenumbrueche in Strings: {"intro":"1 Satz ohne HTML","cards":[{"emoji":"⚡","name":"Starlink D2D","val":"Konkurrent","val_color":"red","desc":"D2D-Abdeckung vs ASTS"},{"emoji":"📱","name":"AT&T und Verizon","val":"Partner","val_color":"green","desc":"Rollout-Status und Revenue"},{"emoji":"🌍","name":"Globale Carrier","val":"60 Partner","val_color":"blue","desc":"Neue Carrier-Vertraege"},{"emoji":"🛰","name":"Satelliten","val":"X im Orbit","val_color":"blue","desc":"BlueBird Status"},{"emoji":"📡","name":"FCC Lizenzen","val":"Status","val_color":"green","desc":"Regulatorischer Status"},{"emoji":"📦","name":"Kuiper D2D","val":"Zeitplan","val_color":"amber","desc":"Konkurrenz-Bedrohung"}]}`,
  spcx: `Analysiere Sektor-Kontext fuer die SpaceX Aktie (SPCX). Quellen: SpaceNews, CNBC, Reuters, spacex.com. Alle Texte auf Deutsch. Antworte NUR mit JSON, kein HTML, keine cite-Tags, keine Zeilenumbrueche in Strings: {"intro":"1 Satz ohne HTML","cards":[{"emoji":"🛸","name":"Starlink","val":"X Mio Nutzer","val_color":"green","desc":"Nutzer Umsatz Wachstum"},{"emoji":"⭐","name":"Starship","val":"Status","val_color":"amber","desc":"Testflug-Status Artemis Mars"},{"emoji":"🤖","name":"xAI","val":"Status","val_color":"purple","desc":"Integration Capex Rechenzentren"},{"emoji":"📦","name":"Amazon Kuiper","val":"Konkurrenz","val_color":"red","desc":"Satelliten-Internet Konkurrenz"},{"emoji":"🚀","name":"Startmarkt","val":"X% Anteil","val_color":"green","desc":"Marktanteil kommerzielle Starts"},{"emoji":"💰","name":"Bewertung","val":"$X Bio","val_color":"amber","desc":"Marktkapitalisierung vs Umsatz"}]}`,
  oklo: `Analysiere Sektor-Kontext fuer Oklo (OKLO). Quellen: World Nuclear News, Utility Dive, Reuters, oklo.com, nrc.gov. Alle Texte auf Deutsch. Antworte NUR mit JSON, kein HTML, keine cite-Tags, keine Zeilenumbrueche in Strings: {"intro":"1 Satz ohne HTML","cards":[{"emoji":"🤖","name":"KI-Strombedarf","val":"Status","val_color":"green","desc":"Rechenzentren Nachfrage Big Tech Nuklear-Deals"},{"emoji":"⚛️","name":"SMR-Konkurrenz","val":"Status","val_color":"red","desc":"NuScale TerraPower X-energy Kairos"},{"emoji":"🧪","name":"HALEU / Uran","val":"Status","val_color":"amber","desc":"Brennstoff-Verfuegbarkeit Centrus DOE"},{"emoji":"🏛","name":"NRC-Reform","val":"Status","val_color":"blue","desc":"ADVANCE Act beschleunigte Lizenzierung"},{"emoji":"⚡","name":"Strompreise","val":"Status","val_color":"blue","desc":"PPA-Preise Rechenzentren"},{"emoji":"🏢","name":"Grosskunden","val":"~14 GW","val_color":"green","desc":"Switch Meta Equinix Vertraege"}]}`
};

const CTX_PROMPTS = {
  rklb: `Aktuelle Rocket Lab (RKLB) Firmendaten. Quellen: rocketlabusa.com, SEC Filings, letzter Earnings Call. Antworte NUR mit JSON, kein HTML, keine cite-Tags: {"desc":"Firmenbeschreibung auf Deutsch","tags":[{"text":"Tag","type":"green"}],"stats":[{"label":"Backlog","val":"$X Mrd"}]}`,
  asts: `Aktuelle AST SpaceMobile (ASTS) Firmendaten. Quellen: ast-science.com, SEC Filings, letzter Earnings Call. Antworte NUR mit JSON, kein HTML, keine cite-Tags: {"desc":"Firmenbeschreibung auf Deutsch","tags":[{"text":"Tag","type":"green"}],"stats":[{"label":"Cash","val":"$X Mrd"}]}`,
  spcx: `Aktuelle SpaceX (NASDAQ: SPCX) Firmendaten. Quellen: spacex.com, SEC Filings, CNBC, letzter Earnings Call. Antworte NUR mit JSON, kein HTML, keine cite-Tags: {"desc":"Firmenbeschreibung auf Deutsch","tags":[{"text":"Tag","type":"green"}],"stats":[{"label":"Starlink Nutzer","val":"X Mio"}]}`,
  oklo: `Aktuelle Oklo Inc (NYSE: OKLO) Firmendaten. Quellen: oklo.com, SEC Filings, letzter Earnings Call. Antworte NUR mit JSON, kein HTML, keine cite-Tags: {"desc":"Firmenbeschreibung auf Deutsch","tags":[{"text":"Tag","type":"green"}],"stats":[{"label":"Pipeline","val":"X GW"}]}`
};

const INSIDER_RKLB_PROMPT = `RKLB Rocket Lab insider trades last 90 days from SEC Form 4. Fill with real trades. JSON only, no slashes in name fields: {"trades":[{"name":"First Last","title":"CFO","type":"sell","shares":10000,"price":95.50,"value":955000,"date":"2026-05-15","note":"RSU-Verkauf zur Steuerdeckung"}],"summary":"Zusammenfassung auf Deutsch","signal":"bearish"}`;

const INSIDER_ASTS_PROMPT = `ASTS AST SpaceMobile insider trades last 90 days from SEC Form 4. Fill with real trades. JSON only, no slashes in name fields: {"trades":[{"name":"First Last","title":"CEO","type":"sell","shares":5000,"price":120.00,"value":600000,"date":"2026-05-15","note":"RSU-Verkauf zur Steuerdeckung"}],"summary":"Zusammenfassung auf Deutsch","signal":"neutral"}`;


const INSIDER_SPCX_PROMPT = `SPCX SpaceX insider trades since June 2026 IPO from SEC Form 4 (Musk, Shotwell, executives, lockup status). Fill with real trades if any. JSON only, no slashes in name fields: {"trades":[{"name":"First Last","title":"CEO","type":"sell","shares":10000,"price":150.00,"value":1500000,"date":"2026-07-15","note":"Kontext auf Deutsch"}],"summary":"Zusammenfassung auf Deutsch (inkl. Lockup-Hinweis falls keine Trades)","signal":"neutral"}`;

const INSIDER_OKLO_PROMPT = `OKLO Oklo Inc insider trades last 90 days from SEC Form 4 (Jacob DeWitte, executives, Sam Altman). Fill with real trades. JSON only, no slashes in name fields: {"trades":[{"name":"First Last","title":"CEO","type":"sell","shares":5000,"price":65.00,"value":325000,"date":"2026-07-01","note":"Kontext auf Deutsch"}],"summary":"Zusammenfassung auf Deutsch","signal":"neutral"}`;

const SPCX_MILESTONE_PROMPT = `Search SpaceX (SPCX) latest quarterly and operational data 2026. Find: revenue, Starlink subscribers, Starship test flights, cash, capex, analyst targets. Fill in real numbers. Respond with ONLY this JSON, no commentary: {"score_gesamt":62,"score_wachstum":80,"score_starlink":88,"score_starship":55,"score_liquiditaet":75,"score_risiko":40,"score_bewertung":25,"umsatz_wert":"$X Mrd","umsatz_yoy":"+X%","umsatz_quelle":"Q1 2026","umsatz_datum":"2026-05","umsatz_trend":"up","guidance_2026":"$X Mrd Ziel","starlink_subs":"X Mio","starlink_umsatz":"$X Mrd","starlink_anteil":"X% vom Umsatz","starship_status":"Status auf Deutsch","starship_ampel":"gelb","starship_fluege":"X Testfluege 2026","v3_status":"Status auf Deutsch","v3_ampel":"gelb","artemis_status":"HLS Status auf Deutsch","artemis_ampel":"gelb","mars_status":"Status auf Deutsch","mars_ampel":"gelb","cash_wert":"$X Mrd","cash_datum":"2026-06","cash_quelle":"IPO + Q1 2026","capex_wert":"$X Mrd/Quartal","netloss_wert":"-$X Mrd","launches_2026":"X Starts","launches_2026_note":"Ziel X Starts","launch_success":"X%","ev_sales":"PS Xx","analyst_range":"$X-$X","analyst_konsens":"$X","kurs_vs_konsens":"X% ueber/unter Konsens","risk_bewertung":"Hoch","risk_capex":"Hoch","risk_regulierung":"Mittel","risk_konkurrenz":"Mittel","naechster_meilenstein":"Wichtigster naechster Schritt","interpretation":"Analyse auf Deutsch","haupttreiber":["Starlink-Wachstum","Startmarkt-Dominanz","Starship"],"hauptrisiken":["Extreme Bewertung","Capex/xAI","Starship-Timing"]}`;

const OKLO_MILESTONE_PROMPT = `Search Oklo Inc (OKLO) latest quarterly and operational data 2026. Find: cash position, net loss, Aurora-INL construction status, NRC licensing (PDC approved May 2026, COLA), customer pipeline GW (Switch 12 GW, Meta 1.2 GW Ohio, Equinix 500 MW), HALEU fuel, analyst targets. Fill in real numbers. Respond with ONLY this JSON, no commentary: {"score_gesamt":55,"score_cash":70,"score_pipeline":80,"score_lizenz":65,"score_technologie":60,"score_risiko":35,"score_bewertung":30,"cash_wert":"$X Mrd","cash_datum":"2026-03-31","cash_quelle":"Q1 2026","debt_wert":"$X Mio","cash_runway":"X Monate","netloss_wert":"-$X Mio","pipeline_gw":"~X GW","pipeline_kunden":"Switch 12 GW Meta 1.2 GW Equinix 500 MW","pipeline_neu":"Neueste Vertraege auf Deutsch","nrc_status":"Status auf Deutsch","pdc_status":"Genehmigt Mai 2026","cola_status":"Status auf Deutsch","cola_ampel":"gelb","doe_status":"Status auf Deutsch","aurora_leistung":"75 MWe","aurora_status":"Baustatus auf Deutsch","aurora_ampel":"gelb","fuel_status":"HALEU Status auf Deutsch","fuel_ampel":"gelb","meta_projekt_status":"Status auf Deutsch","meta_ampel":"gruen","ev_sales":"Pre-Revenue","analyst_range":"$X-$X","analyst_konsens":"$X","kurs_vs_konsens":"X% ueber/unter Konsens","risk_genehmigung":"Mittel","risk_finanzierung":"Hoch","risk_zeitplan":"Hoch","risk_konkurrenz":"Mittel","naechster_meilenstein":"Wichtigster naechster Schritt","interpretation":"Analyse auf Deutsch","haupttreiber":["14 GW Pipeline","NRC-Fortschritt","KI-Strombedarf"],"hauptrisiken":["Kein Umsatz","Lizenzierungs-Timing","Verwaesserung"]}`;

const GOV_OKLO_PROMPT = `Oklo Inc (OKLO) US government status 2026: NRC licensing (PDC approved May 2026, COLA plans), DOE Idaho National Laboratory partnership and reactor pilot program, DoD Air Force Eielson AFB microreactor project, HALEU fuel allocation and Atomic Alchemy radioisotopes. Fill with real data. JSON only: {"nrc":{"status":"Status","desc":"Beschreibung auf Deutsch"},"doe":{"status":"Status","desc":"Beschreibung auf Deutsch"},"dod":{"status":"Status","desc":"Beschreibung auf Deutsch"},"fuel":{"status":"Status","desc":"Beschreibung auf Deutsch"},"ausblick":"Regulierungsausblick auf Deutsch"}`;

const RKLB_KPI_PROMPT = `Search Rocket Lab (RKLB) Q1 2026 financial results. Find revenue, backlog, gross margin, cash. Fill in real numbers. Respond with ONLY this JSON, no commentary: {"score_gesamt":82,"score_wachstum":88,"score_backlog":92,"score_marge":76,"score_liquiditaet":90,"score_risiko":58,"score_bewertung":38,"umsatz_wert":"$X Mio","umsatz_yoy":"+X%","umsatz_quelle":"Q1 2026","umsatz_datum":"2026-05-07","umsatz_trend":"up","backlog_wert":"$X Mrd","backlog_qoq":"+X%","backlog_mix":"X% Space Systems","backlog_coverage":"X.Xx","backlog_quelle":"Q1 2026","gross_margin_wert":"X%","gross_margin_qoq":"+X%","ebitda_wert":"-$X Mio","liquiditaet_wert":"$X Mrd","liquiditaet_quelle":"Q1 2026","neutron_status":"Qualifikationstests laufen","neutron_erstflug":"Q4 2026 geplant","neutron_risiko":"Mittel","defense_sda":"$X Mio","defense_golden_dome":"Raytheon Partner","launches_2026":"X Starts","launches_2026_note":"Ziel X Starts","launch_success":"X%","ev_sales":"PS Xx","analyst_range":"$X-$X","analyst_konsens":"$X","kurs_vs_konsens":"X% ueber/unter Konsens","netloss_wert":"-$X Mio","interpretation":"Analyse auf Deutsch","haupttreiber":["Backlog-Wachstum","Defense","Bruttomarge"],"hauptrisiken":["Neutron-Timing","Hohe Bewertung"]}`;

const ASTS_MILESTONE_PROMPT = `Search AST SpaceMobile (ASTS) Q1 2026 data. Find: cash position, BlueBird satellite status, FCC license, MNO partners, revenue. Fill in real numbers. Respond with ONLY this JSON, no commentary: {"score_gesamt":68,"score_cash":82,"score_umsatz_ramp":48,"score_launch":52,"score_technologie":90,"score_partner":85,"score_risiko":48,"score_bewertung":45,"cash_wert":"$X Mrd","cash_datum":"2026-03-31","cash_quelle":"Q1 2026","debt_wert":"$X Mrd","cash_runway":"X Monate","umsatz_wert":"$X Mio","umsatz_yoy":"+X%","umsatz_datum":"2026-05","guidance_2026":"$X-X Mio","guidance_progress":"X% erreicht","netloss_wert":"-$X Mio","bb1_5_status":"Im Orbit aktiv","bb1_5_ampel":"gruen","bb6_status":"Im Orbit aktiv","bb6_ampel":"gruen","bb7_status":"Deorbited nach Anomalie","bb7_ampel":"rot","bb8_10_status":"Start Mitte Juni 2026","bb8_10_ampel":"gelb","fcc_status":"Genehmigt April 2026","itu_status":"Koordination laeuft","mno_anzahl":60,"mno_aktive":"ATT Verizon Vodafone Rakuten","peak_speed":"98 Mbps","ev_sales":"PS X","analyst_range":"$X-$X","analyst_konsens":"$X","kurs_vs_konsens":"X% ueber/unter Konsens","risk_launch":"Mittel","risk_dilution":"Hoch","risk_konkurrenz":"Starlink D2D aktiv","risk_zeitplan":"Verzoegerungen moeglich","naechster_meilenstein":"BB-8-10 Start Q3 2026","interpretation":"Analyse auf Deutsch","haupttreiber":["Starke Liquiditaet","MNO-Partner","Technologie"],"hauptrisiken":["Verwässerung","Schulden","Zeitplan"]}`;

const GLOSSAR_PROMPT = `Finance and space terms from recent RKLB ASTS SpaceX news. Current Golden Dome budget. Fill with real data. JSON only: {"golden_dome_def":"US missile defense program, current budget and RKLB role","terms":[{"term":"Term","def":"Short German explanation without special chars"}]}`;

const GOV_RKLB_PROMPT = `What US government contracts does Rocket Lab have in 2026? JSON only, no prose outside JSON: {"golden_dome":{"budget":"$X Mrd","rklb_anteil":"$X Mio","status":"active","desc":"Beschreibung auf Deutsch"},"sda":{"budget":"$X Mrd","rklb_auftraege":"$X Mio","status":"active","desc":"Beschreibung auf Deutsch"},"nasa":{"program":"VCLS","wert":"$X Mio","status":"active","desc":"Beschreibung auf Deutsch"},"space_force":{"program":"NSSL","wert":"$X Mio","status":"active","desc":"Beschreibung auf Deutsch"},"ausblick":"Umsatzausblick auf Deutsch"}`;

const GOV_ASTS_PROMPT = `AST SpaceMobile (ASTS) regulatory status 2026: FCC, ITU, DoD, NTIA. Fill with real data. JSON only: {"fcc":{"status":"License status","frequenz":"Frequency band","desc":"Beschreibung auf Deutsch"},"itu":{"status":"Status","desc":"Beschreibung auf Deutsch"},"dod":{"potenzial":"High/Medium/Low","desc":"Beschreibung auf Deutsch"},"ntia":{"status":"Status","desc":"Beschreibung auf Deutsch"},"ausblick":"Regulierungsausblick"}`;

const SPCX_GOV_PROMPT = `SpaceX (NASDAQ: SPCX) government status 2026: FAA Starship launch licenses, NASA Artemis HLS contracts, Space Force NSSL launch awards, SEC reporting since June 2026 IPO. Fill with real current data. JSON only: {"faa":{"status":"status","desc":"Beschreibung auf Deutsch"},"nasa":{"wert":"$X Mrd","desc":"Beschreibung auf Deutsch"},"space_force":{"wert":"$X Mrd","desc":"Beschreibung auf Deutsch"},"sec":{"status":"status","desc":"Beschreibung auf Deutsch"}}`;


// ── Generische Prompts für selbst hinzugefügte Titel ──────────────────────
function buildCustomPrompts(sym, name) {
  const co = `${name} (${sym})`;
  return {
    rec: `Analysiere die Aktie ${co} aktuell. JSON only: {"empfehlung":"HALTEN","titel":"Kernthese auf Deutsch","begruendung":"3-4 Saetze Analyse auf Deutsch","fundamentals":5,"momentum":5,"risiko":5,"bewertung":5,"explain_fundamentals":"Fundamentals — operative Lage auf Deutsch","explain_momentum":"Momentum — Kurstrend auf Deutsch","explain_risiko":"Risiko — Hoeherer Score = niedrigeres Risiko. Risikobewertung auf Deutsch","explain_bewertung":"Bewertung — Bewertungskommentar auf Deutsch","einstieg":"$X","kursziel":"$X","stopp":"$X","lage":"<b>Aktuelle Lage:</b> 2-3 Saetze operative News auf Deutsch — keine Kurszahlen","lage_typ":"neutral","analysten":"Xx Kaufen Xx Halten","earnings_date":"YYYY-MM-DD naechste Quartalszahlen falls bekannt"}`,
    news: `${sym} ${name} stock news last 48h. Fill with real recent events. JSON only: {"articles":[{"title":"Max 80 chars","sentiment":"pos|neg|neu","body":"Nachrichtentext auf Deutsch","source":"Source name"}]}`,
    scenarios: `Analysiere Kursziele von Analysten fuer ${co}. Suche auf Yahoo Finance, TipRanks, Seeking Alpha. WICHTIG: bull_pct=100 immer, alle pct-Werte 0-100. Antworte NUR mit JSON, kein HTML, keine cite-Tags: {"intro":"1 Satz","bull_label":"$XXX","bull_pct":100,"opt_label":"$XXX","opt_pct":60,"base_label":"$XXX","base_pct":45,"bear_label":"$XXX","bear_pct":30,"bull_target":0,"base_target":0,"bear_target":0,"bull5yr":0,"base5yr":0,"bear5yr":0,"bull_desc":"Szenario","base_desc":"Bankexperten","bear_desc":"Szenario","analyst_konsens":"$XXX","sentiment":"2 Saetze ohne HTML","sentiment_warning":true,"sentiment_reddit":"Neutral","sentiment_reddit_sub":"1 Satz","sentiment_x":"Neutral","sentiment_x_sub":"1 Satz","sentiment_st":"Neutral","sentiment_st_sub":"1 Satz","sentiment_tg":"Neutral","sentiment_tg_sub":"1 Satz","sentiment_fb":"Neutral","sentiment_fb_sub":"1 Satz"}`,
    sector: `Analysiere Branchen- und Wettbewerbsumfeld von ${co}. Alle Texte auf Deutsch. Antworte NUR mit JSON, kein HTML, keine cite-Tags: {"intro":"1 Satz ohne HTML","cards":[{"emoji":"📊","name":"Thema","val":"Kennzahl","val_color":"green","desc":"Kurzbeschreibung"}]}`,
    ctx: `Aktuelle Firmendaten zu ${co}. Quellen: Investor Relations, SEC Filings, letzter Earnings Call. Antworte NUR mit JSON, kein HTML, keine cite-Tags: {"desc":"Firmenbeschreibung auf Deutsch in 2 Saetzen","tags":[{"text":"Tag","type":"green"}],"stats":[{"label":"Kennzahl","val":"Wert"}]}`,
    kpi: `Analysiere ${co} fundamental. Suche aktuelle Quartalszahlen, Bilanz, Analystenziele. Antworte NUR mit JSON, kein HTML, keine cite-Tags: {"score_gesamt":50,"score_kommentar":"1 Satz auf Deutsch","score_wachstum":5,"score_profitabilitaet":5,"score_bilanz":5,"score_momentum":5,"score_risiko":5,"score_bewertung":5,"analyst_range":"$X-$X","kurs_vs_konsens":"X% ueber/unter Konsens","interpretation":"3-4 Saetze Analyse auf Deutsch","haupttreiber":["Treiber 1","Treiber 2"],"hauptrisiken":["Risiko 1","Risiko 2"]}`,
    insider: `${sym} ${name} insider trades last 90 days from SEC Form 4. Fill with real trades. JSON only, no slashes in name fields: {"trades":[{"name":"First Last","title":"CEO","type":"sell","shares":1000,"price":10.00,"value":10000,"date":"2026-07-01","note":"Kontext auf Deutsch"}],"summary":"Zusammenfassung auf Deutsch","signal":"neutral"}`,
  };
}

// Liest selbst hinzugefuegte Titel aus Supabase (Tabelle user_tickers, optional)
async function fetchCustomTickers() {
  try {
    const rows = await supa('/user_tickers?select=ticker,symbol,name');
    if (!Array.isArray(rows)) return [];
    const seen = new Set();
    return rows.filter(r => {
      const k = (r.ticker || '').toLowerCase();
      if (!k || seen.has(k)) return false;
      seen.add(k); return true;
    }).map(r => ({ t: (r.ticker||'').toLowerCase(), sym: (r.symbol||'').toUpperCase(), name: r.name || r.symbol }));
  } catch (e) {
    console.log('Keine eigenen Titel (user_tickers nicht vorhanden oder leer):', e.message);
    return [];
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { scope } = req.query;
  console.log('Cron starting, scope:', scope || 'all');

  const customTickers = await fetchCustomTickers();
  if (customTickers.length) console.log('Eigene Titel gefunden:', customTickers.map(c => c.sym).join(', '));

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
    { ticker:'spcx', section:'rec',        prompt: REC_PROMPTS.spcx },
    { ticker:'spcx', section:'news',       prompt: NEWS_PROMPTS.spcx },
    { ticker:'spcx', section:'scenarios',  prompt: SCENARIOS_PROMPTS.spcx },
    { ticker:'spcx', section:'sector',     prompt: SECTOR_PROMPTS.spcx },
    { ticker:'spcx', section:'ctx',        prompt: CTX_PROMPTS.spcx },
    { ticker:'spcx', section:'milestone',  prompt: SPCX_MILESTONE_PROMPT },
    { ticker:'spcx', section:'insider',    prompt: INSIDER_SPCX_PROMPT },
    { ticker:'spcx', section:'gov_space',  prompt: SPCX_GOV_PROMPT },
    { ticker:'oklo', section:'rec',        prompt: REC_PROMPTS.oklo },
    { ticker:'oklo', section:'news',       prompt: NEWS_PROMPTS.oklo },
    { ticker:'oklo', section:'scenarios',  prompt: SCENARIOS_PROMPTS.oklo },
    { ticker:'oklo', section:'sector',     prompt: SECTOR_PROMPTS.oklo },
    { ticker:'oklo', section:'ctx',        prompt: CTX_PROMPTS.oklo },
    { ticker:'oklo', section:'milestone',  prompt: OKLO_MILESTONE_PROMPT },
    { ticker:'oklo', section:'insider',    prompt: INSIDER_OKLO_PROMPT },
    { ticker:'oklo', section:'gov_space',  prompt: GOV_OKLO_PROMPT },
  ];

  // Selbst hinzugefuegte Titel: generische Prompts anhaengen
  for (const c of customTickers) {
    const p = buildCustomPrompts(c.sym, c.name);
    allCalls.push(
      { ticker:c.t, section:'rec',       prompt:p.rec,       custom:true },
      { ticker:c.t, section:'news',      prompt:p.news,      custom:true },
      { ticker:c.t, section:'scenarios', prompt:p.scenarios, custom:true },
      { ticker:c.t, section:'sector',    prompt:p.sector,    custom:true },
      { ticker:c.t, section:'ctx',       prompt:p.ctx,       custom:true },
      { ticker:c.t, section:'kpi',       prompt:p.kpi,       custom:true },
      { ticker:c.t, section:'insider',   prompt:p.insider,   custom:true },
    );
  }

  // Scope filtering
  const fastSections = new Set(['rec','news','scenarios']);
  const slowSections = new Set(['sector','ctx','glossar','kpi','milestone','insider','gov_space']);

  let calls = allCalls;
  if (scope === 'rklb')       calls = allCalls.filter(c => c.ticker === 'rklb');
  else if (scope === 'asts')  calls = allCalls.filter(c => c.ticker === 'asts');
  else if (scope === 'spcx')  calls = allCalls.filter(c => c.ticker === 'spcx');
  else if (scope === 'oklo')  calls = allCalls.filter(c => c.ticker === 'oklo');
  else if (scope === 'rklb_news') calls = allCalls.filter(c => c.ticker==='rklb' && fastSections.has(c.section));
  else if (scope === 'asts_news') calls = allCalls.filter(c => c.ticker==='asts' && fastSections.has(c.section));
  else if (scope === 'spcx_news') calls = allCalls.filter(c => c.ticker==='spcx' && fastSections.has(c.section));
  else if (scope === 'oklo_news') calls = allCalls.filter(c => c.ticker==='oklo' && fastSections.has(c.section));
  else if (scope === 'custom') calls = allCalls.filter(c => c.custom);
  else if (scope === 'custom_news') calls = allCalls.filter(c => c.custom && fastSections.has(c.section));
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
