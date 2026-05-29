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
      'Prefer': method==='POST' ? 'resolution=merge-duplicates' : '',
    }
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`${SUPABASE_URL}/rest/v1${path}`, opts);
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  return r.json();
}

async function kiCall(prompt) {
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
  if (!resp.ok) throw new Error(`Anthropic ${resp.status}`);
  const data = await resp.json();
  const raw = data.content.filter(b=>b.type==='text').map(b=>b.text).join('').trim();
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON');
  return JSON.parse(match[0]);
}

async function saveToCache(ticker, section, data) {
  await supa('/ki_cache', 'POST', {
    ticker: ticker || 'global',
    section,
    data,
    updated_at: new Date().toISOString()
  });
}

const delay = ms => new Promise(r => setTimeout(r, ms));

export default async function handler(req, res) {
  // Verify cron secret to prevent unauthorized calls
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'No API key configured' });

  try {
    // Check if sync is enabled
    const settings = await supa('/sync_settings?id=eq.1&select=sync_enabled');
    if (settings?.[0]?.sync_enabled === false) {
      return res.status(200).json({ message: 'Sync disabled, skipping' });
    }

    const results = { success: [], failed: [] };

    const REC_PROMPTS = {
      rklb: `Analysiere Rocket Lab (RKLB) mit Web-Suchen. Antworte NUR mit JSON: {"empfehlung":"KAUFEN","titel":"Max 80 Zeichen","begruendung":"2-4 Sätze","fundamentals":8,"momentum":7,"risiko":6,"bewertung":5,"explain_fundamentals":"<b>Fundamentals</b> — 1 Satz","explain_momentum":"<b>Momentum</b> — 1 Satz","explain_risiko":"<b>Risiko</b> — <b>Höherer Score = niedrigeres Risiko.</b> 1 Satz","explain_bewertung":"<b>Bewertung</b> — 1 Satz","einstieg":"$120-130","kursziel":"$180","stopp":"$105","lage":"<b>Aktuelle Lage:</b> 1-2 Sätze","lage_typ":"positive","analysten":"12x Kaufen"}`,
      asts: `Analysiere AST SpaceMobile (ASTS) mit Web-Suchen. Antworte NUR mit JSON: {"empfehlung":"HALTEN","titel":"Max 80 Zeichen","begruendung":"2-4 Sätze","fundamentals":5,"momentum":8,"risiko":4,"bewertung":3,"explain_fundamentals":"<b>Fundamentals</b> — 1 Satz","explain_momentum":"<b>Momentum</b> — 1 Satz","explain_risiko":"<b>Risiko</b> — <b>Höherer Score = niedrigeres Risiko.</b> 1 Satz","explain_bewertung":"<b>Bewertung</b> — 1 Satz","einstieg":"$80-90","kursziel":"$140","stopp":"$70","lage":"<b>Aktuelle Lage:</b> 1-2 Sätze","lage_typ":"warning","analysten":"8x Kaufen"}`
    };

    const NEWS_PROMPTS = {
      rklb: `Suche aktuelle Nachrichten über Rocket Lab (RKLB) der letzten 24h. Antworte NUR mit JSON: {"articles":[{"title":"Titel","sentiment":"pos|neg|neu","body":"2-3 Sätze auf Deutsch","source":"Quelle"}]}`,
      asts: `Suche aktuelle Nachrichten über AST SpaceMobile (ASTS) der letzten 24h. Antworte NUR mit JSON: {"articles":[{"title":"Titel","sentiment":"pos|neg|neu","body":"2-3 Sätze auf Deutsch","source":"Quelle"}]}`
    };

    const SCENARIOS_PROMPTS = {
      rklb: `Analysiere RKLB Kursziele. Antworte NUR mit JSON: {"intro":"1 Satz","bull_label":"$XXX","bull_pct":100,"opt_label":"$XXX","opt_pct":56,"base_label":"$XXX","base_pct":56,"bear_label":"$XX","bear_pct":40,"bull_target":216,"base_target":120,"bear_target":86,"bull5yr":450,"base5yr":220,"bear5yr":70,"bull_desc":"Szenario → $XXX","base_desc":"Bankexperten → $XXX","bear_desc":"Szenario → $XX","sentiment":"2 Sätze Reddit/WSB","sentiment_warning":false}`,
      asts: `Analysiere ASTS Kursziele. Antworte NUR mit JSON: {"intro":"1 Satz","bull_label":"$XXX","bull_pct":100,"opt_label":"$XXX","opt_pct":54,"base_label":"$XX","base_pct":42,"bear_label":"$XX","bear_pct":36,"bull_target":200,"base_target":83,"bear_target":50,"bull5yr":380,"base5yr":120,"bear5yr":25,"bull_desc":"Szenario → $XXX","base_desc":"Bankexperten → $XX","bear_desc":"Szenario → $XX","sentiment":"2 Sätze Stand","sentiment_warning":true}`
    };

    const SECTOR_PROMPTS = {
      rklb: `Analysiere Sektor-Kontext für RKLB. Antworte NUR mit JSON: {"intro":"1 Satz","cards":[{"emoji":"🌌","name":"SpaceX IPO","val":"Status","val_color":"purple","desc":"2 Sätze"},{"emoji":"🛡","name":"Golden Dome","val":"Status","val_color":"green","desc":"2 Sätze"},{"emoji":"🌍","name":"Sektor-Peers","val":"Status","val_color":"blue","desc":"kurz"},{"emoji":"📈","name":"Defense Budget","val":"Status","val_color":"green","desc":"Einfluss"}]}`,
      asts: `Analysiere Sektor-Kontext für ASTS. Antworte NUR mit JSON: {"intro":"1 Satz","cards":[{"emoji":"🌌","name":"SpaceX Börsengang","val":"Status","val_color":"purple","desc":"2 Sätze"},{"emoji":"💥","name":"Blue Origin","val":"Status","val_color":"red","desc":"Aktuell"},{"emoji":"📶","name":"Starlink D2D","val":"Status","val_color":"red","desc":"Konkurrenz"},{"emoji":"📱","name":"AT&T & Verizon","val":"Status","val_color":"green","desc":"Partnership"}]}`
    };

    const CTX_PROMPTS = {
      rklb: `Suche aktuelle Firmendaten für Rocket Lab (RKLB). Antworte NUR mit JSON: {"desc":"1-2 Sätze","tags":[{"text":"Tag","type":"green"}],"stats":[{"label":"Backlog","val":"$X Mrd"}]}`,
      asts: `Suche aktuelle Firmendaten für AST SpaceMobile (ASTS). Antworte NUR mit JSON: {"desc":"1-2 Sätze","tags":[{"text":"Tag","type":"green"}],"stats":[{"label":"Cash","val":"$X Mrd"}]}`
    };

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
    ];

    for (const call of calls) {
      try {
        const data = await kiCall(call.prompt);
        await saveToCache(call.ticker, call.section, data);
        results.success.push(`${call.ticker}/${call.section}`);
        await delay(8000); // 8s between calls
      } catch(e) {
        results.failed.push(`${call.ticker}/${call.section}: ${e.message}`);
        await delay(5000);
      }
    }

    // Update last_sync timestamp
    await supa('/sync_settings', 'POST', {
      id: 1,
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
