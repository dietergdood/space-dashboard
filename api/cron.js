// Vercel Cron Job - runs 4x daily
// Requires ANTHROPIC_API_KEY in Vercel Environment Variables

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY; // service role key (not anon!)
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
  // 204 No Content is success for upsert
  if (r.status === 204) return {};
  const text = await r.text();
  return text ? JSON.parse(text) : {};
}

async function kiCall(prompt, retries=3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    if (attempt > 0) {
      const wait = attempt * 20000; // 20s, 40s
      console.log(`Rate limit retry ${attempt}, waiting ${wait/1000}s`);
      await delay(wait);
    }
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1000,
        tools: [{type: 'web_search_20250305', name: 'web_search'}],
        messages: [{role: 'user', content: prompt}]
      })
    });
    if (resp.status === 429) {
      console.log('429 rate limit on attempt', attempt);
      continue;
    }
    if (!resp.ok) throw new Error(`Anthropic ${resp.status}`);
    const data = await resp.json();
    const raw = data.content.filter(b=>b.type==='text').map(b=>b.text).join('').trim();
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON in response');
    return JSON.parse(match[0]);
  }
  throw new Error('Max retries exceeded');
}

async function saveToCache(ticker, section, data) {
  try {
    const t = ticker || 'global';
    // DELETE existing row first
    await supaDelete(`/ki_cache?ticker=eq.${t}&section=eq.${section}`);
    // Then INSERT fresh
    const result = await supa('/ki_cache', 'POST', {
      ticker: t,
      section,
      data,
      updated_at: new Date().toISOString()
    });
    console.log('Saved:', t, section);
    return result;
  } catch(e) {
    console.error('saveToCache failed:', ticker, section, e.message);
    throw e;
  }
}

async function supaDelete(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    method: 'DELETE',
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Prefer': 'return=minimal',
    }
  });
  // 204 = success, ignore other statuses
  return r.status;
}

const delay = ms => new Promise(r => setTimeout(r, ms));

export default async function handler(req, res) {
  // Vercel automatically secures cron endpoints
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'No ANTHROPIC_API_KEY configured' });
  if (!SUPABASE_URL) return res.status(500).json({ error: 'No SUPABASE_URL configured' });
  if (!SUPABASE_SERVICE_KEY) return res.status(500).json({ error: 'No SUPABASE_SERVICE_KEY configured' });
  console.log('Env check OK, starting cron...');

  try {
    // Check if sync is enabled
    const settings = await supa('/sync_settings?id=eq.1&select=sync_enabled');
    if (settings?.[0]?.sync_enabled === false) {
      return res.status(200).json({ message: 'Sync disabled, skipping' });
    }

    const results = { success: [], failed: [] };

    const REC_PROMPTS = {
      rklb: `Analysiere Rocket Lab (RKLB) mit Web-Suchen. Antworte NUR mit JSON, KEIN HTML in Texten ausser bei explain_* Feldern, keine <cite> Tags: {"empfehlung":"KAUFEN","titel":"Max 80 Zeichen","begruendung":"2-4 Sätze","fundamentals":8,"momentum":7,"risiko":6,"bewertung":5,"explain_fundamentals":"<b>Fundamentals</b> — 1 Satz","explain_momentum":"<b>Momentum</b> — 1 Satz","explain_risiko":"<b>Risiko</b> — <b>Höherer Score = niedrigeres Risiko.</b> 1 Satz","explain_bewertung":"<b>Bewertung</b> — 1 Satz","einstieg":"$120-130","kursziel":"$180","stopp":"$105","lage":"<b>Aktuelle Lage:</b> 1-2 Sätze","lage_typ":"positive","analysten":"12x Kaufen"}`,
      asts: `Analysiere AST SpaceMobile (ASTS) mit Web-Suchen. Antworte NUR mit JSON, KEIN HTML in Texten ausser bei explain_* Feldern, keine <cite> Tags: {"empfehlung":"HALTEN","titel":"Max 80 Zeichen","begruendung":"2-4 Sätze","fundamentals":5,"momentum":8,"risiko":4,"bewertung":3,"explain_fundamentals":"<b>Fundamentals</b> — 1 Satz","explain_momentum":"<b>Momentum</b> — 1 Satz","explain_risiko":"<b>Risiko</b> — <b>Höherer Score = niedrigeres Risiko.</b> 1 Satz","explain_bewertung":"<b>Bewertung</b> — 1 Satz","einstieg":"$80-90","kursziel":"$140","stopp":"$70","lage":"<b>Aktuelle Lage:</b> 1-2 Sätze","lage_typ":"warning","analysten":"8x Kaufen"}`
    };

    const NEWS_PROMPTS = {
      rklb: `Suche aktuelle Nachrichten über Rocket Lab (RKLB) der letzten 24h. Suche auf: rocketlabusa.com/updates, X/Twitter (@RocketLab), Reddit r/RocketLab, r/stocks, StockTwits RKLB, Yahoo Finance, Bloomberg, Reuters, SEC Filings (sec.gov), Seeking Alpha, The Motley Fool. Bevorzuge offizielle Pressemitteilungen und seriöse Finanzmedien. Antworte NUR mit JSON, KEIN HTML, keine <cite> Tags: {"articles":[{"title":"Titel","sentiment":"pos|neg|neu","body":"2-3 Sätze auf Deutsch ohne HTML","source":"Exakte Quelle (z.B. Reuters, rocketlabusa.com, Reddit r/RocketLab)"}]}`,
      asts: `Suche aktuelle Nachrichten über AST SpaceMobile (ASTS) der letzten 24h. Suche auf: ast-science.com/news, X/Twitter (@AST_SpaceMobile), Reddit r/ASTS, r/stocks, StockTwits ASTS, Yahoo Finance, Bloomberg, Reuters, SEC Filings (sec.gov), Seeking Alpha, The Motley Fool. Bevorzuge offizielle Pressemitteilungen und seriöse Finanzmedien. Antworte NUR mit JSON, KEIN HTML, keine <cite> Tags: {"articles":[{"title":"Titel","sentiment":"pos|neg|neu","body":"2-3 Sätze auf Deutsch ohne HTML","source":"Exakte Quelle (z.B. Reuters, ast-science.com, Reddit r/ASTS)"}]}`
    };

    const SCENARIOS_PROMPTS = {
      rklb: `Analysiere RKLB Kursziele. Suche auf: rocketlabusa.com/updates, X/Twitter (@RocketLab), Reddit r/RocketLab, r/stocks, StockTwits RKLB, Yahoo Finance, Bloomberg, Reuters, SEC Filings (sec.gov), Seeking Alpha, The Motley Fool. Suche aktuelle Analysten-Kursziele von Goldman Sachs, Morgan Stanley, Bank of America, Needham, Canaccord. Prüfe auch Reddit r/RocketLab und StockTwits für Retail-Sentiment. Antworte NUR mit JSON, KEIN HTML, keine <cite> Tags: {"intro":"1 Satz ohne HTML","bull_label":"$XXX","bull_pct":100,"opt_label":"$XXX","opt_pct":56,"base_label":"$XXX","base_pct":56,"bear_label":"$XX","bear_pct":40,"bull_target":216,"base_target":120,"bear_target":86,"bull5yr":450,"base5yr":220,"bear5yr":70,"bull_desc":"Szenario → $XXX","base_desc":"Bankexperten → $XXX","bear_desc":"Szenario → $XX","sentiment":"2 Sätze Gesamt-Community-Stimmung ohne HTML","sentiment_warning":false,"sentiment_reddit":"Bullish|Bearish|Neutral","sentiment_reddit_sub":"z.B. 85% bullish r/RocketLab","sentiment_x":"Bullish|Bearish|Neutral","sentiment_x_sub":"z.B. Positiv nach Launch","sentiment_st":"Bullish|Bearish|Neutral","sentiment_st_sub":"z.B. 72% Bulls"}`,
      asts: `Analysiere ASTS Kursziele. Suche auf: ast-science.com/news, X/Twitter (@AST_SpaceMobile), Reddit r/ASTS, r/stocks, StockTwits ASTS, Yahoo Finance, Bloomberg, Reuters, SEC Filings (sec.gov), Seeking Alpha, The Motley Fool. Suche aktuelle Analysten-Kursziele von Scotiabank, ASB Securities, NorthCoast Research. Prüfe auch Reddit r/ASTS und StockTwits für Retail-Sentiment. Antworte NUR mit JSON, KEIN HTML, keine <cite> Tags: {"intro":"1 Satz ohne HTML","bull_label":"$XXX","bull_pct":100,"opt_label":"$XXX","opt_pct":54,"base_label":"$XX","base_pct":42,"bear_label":"$XX","bear_pct":36,"bull_target":200,"base_target":83,"bear_target":50,"bull5yr":380,"base5yr":120,"bear5yr":25,"bull_desc":"Szenario → $XXX","base_desc":"Bankexperten → $XX","bear_desc":"Szenario → $XX","sentiment":"2 Sätze Gesamt-Community-Stimmung ohne HTML","sentiment_warning":true,"sentiment_reddit":"Bullish|Bearish|Neutral","sentiment_reddit_sub":"z.B. 70% bullish r/ASTS","sentiment_x":"Bullish|Bearish|Neutral","sentiment_x_sub":"z.B. Gemischt nach News","sentiment_st":"Bullish|Bearish|Neutral","sentiment_st_sub":"z.B. 65% Bulls"}`
    };

    const SECTOR_PROMPTS = {
      rklb: `Analysiere Sektor-Kontext für RKLB. Antworte NUR mit JSON, KEIN HTML in Texten, keine <cite> oder andere Tags: {"intro":"1 Satz ohne HTML","cards":[{"emoji":"🌌","name":"SpaceX IPO","val":"Status","val_color":"purple","desc":"2 Sätze ohne HTML"},{"emoji":"🛡","name":"Golden Dome","val":"Status","val_color":"green","desc":"2 Sätze ohne HTML"},{"emoji":"🌍","name":"Sektor-Peers","val":"Status","val_color":"blue","desc":"kurz ohne HTML"},{"emoji":"📈","name":"Defense Budget","val":"Status","val_color":"green","desc":"Einfluss ohne HTML"}]}`,
      asts: `Analysiere Sektor-Kontext für ASTS. Antworte NUR mit JSON, KEIN HTML in Texten, keine <cite> oder andere Tags: {"intro":"1 Satz ohne HTML","cards":[{"emoji":"🌌","name":"SpaceX Börsengang","val":"Status","val_color":"purple","desc":"2 Sätze ohne HTML"},{"emoji":"💥","name":"Blue Origin","val":"Status","val_color":"red","desc":"Aktuell ohne HTML"},{"emoji":"📶","name":"Starlink D2D","val":"Status","val_color":"red","desc":"Konkurrenz ohne HTML"},{"emoji":"📱","name":"AT&T & Verizon","val":"Status","val_color":"green","desc":"Partnership ohne HTML"}]}`
    };

    const CTX_PROMPTS = {
      rklb: `Suche aktuelle Firmendaten für Rocket Lab (RKLB). Quellen: rocketlabusa.com/updates, SEC Filings (sec.gov RKLB), Reuters, Bloomberg, letzter Earnings Call. Antworte NUR mit JSON, KEIN HTML, keine <cite> Tags: {"desc":"1-2 Sätze ohne HTML","tags":[{"text":"Tag","type":"green"}],"stats":[{"label":"Backlog","val":"$X Mrd"}]}`,
      asts: `Suche aktuelle Firmendaten für AST SpaceMobile (ASTS). Quellen: ast-science.com/news, SEC Filings (sec.gov ASTS), Reuters, Bloomberg, letzter Earnings Call. Antworte NUR mit JSON, KEIN HTML, keine <cite> Tags: {"desc":"1-2 Sätze ohne HTML","tags":[{"text":"Tag","type":"green"}],"stats":[{"label":"Cash","val":"$X Mrd"}]}`
    };

    const GLOSSAR_PROMPT = `Analysiere aktuelle RKLB und ASTS News aus folgenden Quellen: Suche auf: X/Twitter, Reddit (r/investing, r/wallstreetbets), Yahoo Finance, Bloomberg, Reuters, SEC Filings. rocketlabusa.com/updates, ast-science.com/news. Welche 2-4 neue Fachbegriffe tauchen auf? Suche auch das aktuelle Budget des US "Golden Dome" Programms auf defense.gov und Reuters. Antworte NUR mit JSON, KEIN HTML, keine <cite> Tags: {"golden_dome_def":"US-Raketenabwehr (BETRAG). Rocket Lab Lieferant.","terms":[{"term":"Begriff","def":"Kurze Erklärung ohne HTML"}]}`;

    const calls = [
      { ticker:'rklb', section:'rec',      prompt: REC_PROMPTS.rklb },
      { ticker:'asts', section:'rec',      prompt: REC_PROMPTS.asts },
      { ticker:'rklb', section:'news',     prompt: NEWS_PROMPTS.rklb },
      { ticker:'asts', section:'news',     prompt: NEWS_PROMPTS.asts },
      { ticker:'rklb', section:'scenarios',prompt: SCENARIOS_PROMPTS.rklb },
      { ticker:'asts', section:'scenarios',prompt: SCENARIOS_PROMPTS.asts },
      { ticker:'rklb', section:'sector',   prompt: SECTOR_PROMPTS.rklb },
      { ticker:'asts', section:'sector',   prompt: SECTOR_PROMPTS.asts },
      { ticker:'rklb', section:'ctx',      prompt: CTX_PROMPTS.rklb },
      { ticker:'asts', section:'ctx',      prompt: CTX_PROMPTS.asts },
      { ticker:null, section:'glossar', prompt: GLOSSAR_PROMPT },
    ];

    for (const call of calls) {
      try {
        const data = await kiCall(call.prompt);
        await saveToCache(call.ticker, call.section, data);
        results.success.push(`${call.ticker}/${call.section}`);
        await delay(8000); // 8s between calls
      } catch(e) {
        results.failed.push(`${call.ticker}/${call.section}: ${e.message}`);
        await delay(2000);
      }
    }

    // Update last_sync timestamp
    await supa('/sync_settings?id=eq.1', 'PATCH', {
      last_sync: new Date().toISOString(),
      sync_enabled: true
    });

    return res.status(200).json({ 
      message: 'Sync complete',
      success: results.success.length,
      failed: results.failed
    });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
