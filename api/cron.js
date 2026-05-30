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
      const wait = attempt * 15000;
      console.log(`Retry ${attempt}, waiting ${wait/1000}s`);
      await delay(wait);
    }
    console.log(`API call attempt ${attempt+1}, prompt length: ${prompt.length}`);
    let resp;
    try {
      resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          max_tokens: 1024,
          tools: [{type: 'web_search_20250305', name: 'web_search'}],
          messages: [{role: 'user', content: prompt}]
        })
      });
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
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) {
      console.error('No JSON found in response');
      throw new Error('No JSON in response');
    }
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
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'No ANTHROPIC_API_KEY configured' });
  if (!SUPABASE_URL) return res.status(500).json({ error: 'No SUPABASE_URL configured' });
  if (!SUPABASE_SERVICE_KEY) return res.status(500).json({ error: 'No SUPABASE_SERVICE_KEY configured' });
  // Optional: ?scope=rklb or ?scope=asts or ?scope=global to run subset
  const scope = req.query?.scope || 'all';
  console.log('Cron starting, scope:', scope);

  try {
    // Check if sync is enabled
    const settings = await supa('/sync_settings?id=eq.1&select=sync_enabled');
    if (settings?.[0]?.sync_enabled === false) {
      return res.status(200).json({ message: 'Sync disabled, skipping' });
    }

    const results = { success: [], failed: [] };

    const REC_PROMPTS = {
      rklb: `Analysiere Rocket Lab (RKLB). Suche auf: rocketlabusa.com/investors, SEC Filings, Reuters, Bloomberg, CNBC, Seeking Alpha, SpaceNews, NASASpaceFlight, Breaking Defense, SpaceForce.mil, Reddit r/RocketLab r/space, X/@RocketLab, StockTwits RKLB, TipRanks, Zacks. Berücksichtige Abhängigkeiten: SpaceX (Konkurrenz Electron vs Falcon9, Neutron vs Falcon9), Blue Origin New Glenn, Amazon Kuiper Aufträge, NASA/SpaceForce Aufträge, SDA Tracking Layer. Antworte NUR mit JSON, KEIN HTML in Texten ausser bei explain_* Feldern, keine <cite> Tags: {"empfehlung":"KAUFEN","titel":"Max 80 Zeichen","begruendung":"2-4 Sätze","fundamentals":8,"momentum":7,"risiko":6,"bewertung":5,"explain_fundamentals":"<b>Fundamentals</b> — 1 Satz","explain_momentum":"<b>Momentum</b> — 1 Satz","explain_risiko":"<b>Risiko</b> — <b>Höherer Score = niedrigeres Risiko.</b> 1 Satz","explain_bewertung":"<b>Bewertung</b> — 1 Satz","einstieg":"$120-130","kursziel":"$180","stopp":"$105","lage":"<b>Aktuelle Lage:</b> 1-2 Sätze","lage_typ":"positive","analysten":"12x Kaufen"}`,
      asts: `Analysiere AST SpaceMobile (ASTS) aktuell. Berücksichtige: Starlink D2D Konkurrenz, AT&T/Verizon Partnerships, FCC Lizenzen, Satelliten-Netz Status. Antworte NUR mit JSON, KEIN HTML in Texten ausser bei explain_* Feldern, keine <cite> Tags: {"empfehlung":"HALTEN","titel":"Max 80 Zeichen","begruendung":"2-4 Sätze","fundamentals":5,"momentum":8,"risiko":4,"bewertung":3,"explain_fundamentals":"<b>Fundamentals</b> — 1 Satz","explain_momentum":"<b>Momentum</b> — 1 Satz","explain_risiko":"<b>Risiko</b> — <b>Höherer Score = niedrigeres Risiko.</b> 1 Satz","explain_bewertung":"<b>Bewertung</b> — 1 Satz","einstieg":"$80-90","kursziel":"$140","stopp":"$70","lage":"<b>Aktuelle Lage:</b> 1-2 Sätze","lage_typ":"warning","analysten":"8x Kaufen"}`
    };

    const NEWS_PROMPTS = {
      rklb: `Suche aktuelle RKLB Rocket Lab Nachrichten der letzten 48h. Quellen: rocketlabusa.com, Reuters, Bloomberg, SpaceNews, NASASpaceFlight, Breaking Defense, Reddit r/RocketLab, X @RocketLab, StockTwits RKLB, SEC Filings. Antworte NUR mit JSON, KEIN HTML, keine <cite> Tags: {"articles":[{"title":"Titel","sentiment":"pos|neg|neu","body":"2-3 Sätze auf Deutsch ohne HTML","source":"Exakte Quelle"}]}`,
      asts: `Suche aktuelle ASTS AST SpaceMobile Nachrichten der letzten 48h. Quellen: ast-science.com, Reuters, Bloomberg, SpaceNews, FierceWireless, Light Reading, Reddit r/ASTS, X @AST_SpaceMobile, StockTwits ASTS, T-Mobile/AT&T News. Antworte NUR mit JSON, KEIN HTML, keine <cite> Tags: {"articles":[{"title":"Titel","sentiment":"pos|neg|neu","body":"2-3 Sätze auf Deutsch ohne HTML","source":"Exakte Quelle"}]}`
    };

    const SCENARIOS_PROMPTS = {
      rklb: `Analysiere RKLB Kursziele. Suche auf: rocketlabusa.com/updates, X/Twitter (@RocketLab), Reddit r/RocketLab, r/stocks, StockTwits RKLB, Yahoo Finance, Bloomberg, Reuters, SEC Filings (sec.gov), Seeking Alpha, The Motley Fool. Suche aktuelle Analysten-Kursziele von Goldman Sachs, Morgan Stanley, Bank of America, Needham, Canaccord. Prüfe auch Reddit r/RocketLab und StockTwits für Retail-Sentiment. WICHTIG: bull_pct=100 (immer), opt_pct/base_pct/bear_pct = Balkenlänge 0-100 (KEINE negativen Werte, immer zwischen 0 und 100). Antworte NUR mit JSON, KEIN HTML, keine <cite> Tags: {"intro":"1 Satz ohne HTML","bull_label":"$XXX","bull_pct":100,"opt_label":"$XXX","opt_pct":56,"base_label":"$XXX","base_pct":40,"bear_label":"$XX","bear_pct":25,"bull_target":216,"base_target":120,"bear_target":86,"bull5yr":450,"base5yr":220,"bear5yr":70,"bull_desc":"Szenario → $XXX","base_desc":"Bankexperten → $XXX","bear_desc":"Szenario → $XX","sentiment":"2 Sätze Gesamt-Community-Stimmung ohne HTML","sentiment_warning":false,"sentiment_reddit":"Bullish|Bearish|Neutral","sentiment_reddit_sub":"z.B. 85% bullish r/RocketLab","sentiment_x":"Bullish|Bearish|Neutral","sentiment_x_sub":"z.B. Positiv nach Launch","sentiment_st":"Bullish|Bearish|Neutral","sentiment_st_sub":"z.B. 72% Bulls"}`,
      asts: `Analysiere ASTS Kursziele. Suche auf: ast-science.com/news, X/Twitter (@AST_SpaceMobile), Reddit r/ASTS, r/stocks, StockTwits ASTS, Yahoo Finance, Bloomberg, Reuters, SEC Filings (sec.gov), Seeking Alpha, The Motley Fool. Suche aktuelle Analysten-Kursziele von Scotiabank, ASB Securities, NorthCoast Research. Prüfe auch Reddit r/ASTS und StockTwits für Retail-Sentiment. WICHTIG: bull_pct=100 (immer), opt_pct/base_pct/bear_pct = Balkenlänge 0-100 (KEINE negativen Werte, immer zwischen 0 und 100). Antworte NUR mit JSON, KEIN HTML, keine <cite> Tags: {"intro":"1 Satz ohne HTML","bull_label":"$XXX","bull_pct":100,"opt_label":"$XXX","opt_pct":54,"base_label":"$XX","base_pct":40,"bear_label":"$XX","bear_pct":25,"bull_target":200,"base_target":83,"bear_target":50,"bull5yr":380,"base5yr":120,"bear5yr":25,"bull_desc":"Szenario → $XXX","base_desc":"Bankexperten → $XX","bear_desc":"Szenario → $XX","sentiment":"2 Sätze Gesamt-Community-Stimmung ohne HTML","sentiment_warning":true,"sentiment_reddit":"Bullish|Bearish|Neutral","sentiment_reddit_sub":"z.B. 70% bullish r/ASTS","sentiment_x":"Bullish|Bearish|Neutral","sentiment_x_sub":"z.B. Gemischt nach News","sentiment_st":"Bullish|Bearish|Neutral","sentiment_st_sub":"z.B. 65% Bulls"}`
    };

    const SECTOR_PROMPTS = {
      rklb: `Analysiere Sektor-Kontext und Abhängigkeiten für RKLB. Analysiere aktuell: 1) SpaceX als Konkurrent UND potenzieller Kunde (Rideshare). 2) Blue Origin/New Glenn als direkter Konkurrent. 3) Amazon Project Kuiper als potenzielle RKLB Launch-Aufträge. 4) US Government (NASA, Space Force, SDA) als Hauptkunde. 5) Golden Dome Raketenabwehr-Budget. Antworte NUR mit JSON, KEIN HTML, keine <cite> Tags: {"intro":"1 Satz ohne HTML","cards":[{"emoji":"🚀","name":"SpaceX","val":"Konkurrent","val_color":"purple","desc":"Falcon 9 vs Electron, Neutron vs Falcon 9 — aktuelle Marktanteile"},{"emoji":"🛡","name":"Golden Dome","val":"Budget $X Mrd","val_color":"green","desc":"Aktuelles Programm-Budget und RKLB Vertragsanteil"},{"emoji":"🛸","name":"SDA Tracking Layer","val":"Status","val_color":"blue","desc":"Space Development Agency Aufträge — RKLB Tranche Status"},{"emoji":"🌕","name":"NASA Aufträge","val":"Status","val_color":"blue","desc":"Aktuelle NASA VCLS, CLPS und sonstige Launch-Aufträge"},{"emoji":"⚔️","name":"Space Force","val":"Budget","val_color":"green","desc":"US Space Force Launch-Aufträge und NSSL Programm"},{"emoji":"📦","name":"Amazon Kuiper","val":"Potenzial","val_color":"amber","desc":"Kuiper Konstellation Launch-Aufträge — Status"}]}`,
      asts: `Analysiere Sektor-Kontext und Abhängigkeiten für ASTS. Analysiere aktuell: 1) Starlink Direct-to-Cell als direkter Hauptkonkurrent (SpaceX/T-Mobile). 2) AT&T Partnership Status und Umsatzpotenzial. 3) Verizon Partnership Status. 4) Amazon Project Kuiper D2D Pläne. 5) Blue Origin D2D Pläne. 6) T-Mobile Starlink vs ASTS Exklusivität. Antworte NUR mit JSON, KEIN HTML, keine <cite> Tags: {"intro":"1 Satz ohne HTML","cards":[{"emoji":"⚡","name":"Starlink D2D","val":"Konkurrent","val_color":"red","desc":"SpaceX/T-Mobile D2D — aktuelle Abdeckung und Nutzerzahlen vs ASTS"},{"emoji":"📱","name":"AT&T & Verizon","val":"Partner","val_color":"green","desc":"Kommerzieller Rollout-Status, Nutzerzahlen, Revenue-Sharing"},{"emoji":"🌍","name":"Globale Carrier","val":"Anzahl Partner","val_color":"blue","desc":"Aktuelle Anzahl Carrier-Partner weltweit und neue Verträge"},{"emoji":"🛰","name":"Satelliten-Netz","val":"X Satelliten","val_color":"blue","desc":"Aktuelle Anzahl BlueBird Satelliten im Orbit und Abdeckung"},{"emoji":"📡","name":"FCC Lizenzen","val":"Status","val_color":"green","desc":"FCC Frequenz-Lizenzen und regulatorische Genehmigungen"},{"emoji":"📦","name":"Amazon Kuiper D2D","val":"Zeitplan","val_color":"amber","desc":"Kuiper Direct-to-Device Pläne und Bedrohung für ASTS"}]}`
    };

    const CTX_PROMPTS = {
      rklb: `Aktuelle Rocket Lab (RKLB) Firmendaten: Backlog, Revenue, Mitarbeiter, HQ, Gründungsjahr. Quellen: rocketlabusa.com, SEC Filings, letzter Earnings Call. Antworte NUR mit JSON, KEIN HTML, keine <cite> Tags: {"desc":"1-2 Sätze ohne HTML","tags":[{"text":"Tag","type":"green"}],"stats":[{"label":"Backlog","val":"$X Mrd"}]}`,
      asts: `Aktuelle AST SpaceMobile (ASTS) Firmendaten: Cash, Satelliten im Orbit, Partner-Carrier, Gründungsjahr. Quellen: ast-science.com, SEC Filings, letzter Earnings Call. Antworte NUR mit JSON, KEIN HTML, keine <cite> Tags: {"desc":"1-2 Sätze ohne HTML","tags":[{"text":"Tag","type":"green"}],"stats":[{"label":"Cash","val":"$X Mrd"}]}`
    };

    const GLOSSAR_PROMPT = `Analysiere aktuelle RKLB und ASTS News aus folgenden Quellen: Suche auf: X/Twitter, Reddit (r/investing, r/wallstreetbets), Yahoo Finance, Bloomberg, Reuters, SEC Filings. rocketlabusa.com/updates, ast-science.com/news. Welche 2-4 neue Fachbegriffe tauchen auf? Suche auch das aktuelle Budget des US "Golden Dome" Programms auf defense.gov und Reuters. Antworte NUR mit JSON, KEIN HTML, keine <cite> Tags: {"golden_dome_def":"US-Raketenabwehr (BETRAG). Rocket Lab Lieferant.","terms":[{"term":"Begriff","def":"Kurze Erklärung ohne HTML"}]}`;

    const GOV_RKLB_PROMPT = `Aktuelle US Gov Aufträge für RKLB: 1) Golden Dome Budget + RKLB Anteil. 2) SDA Tracking Layer RKLB Aufträge. 3) NASA Launch-Aufträge. 4) Space Force NSSL Status.
    Antworte NUR mit JSON, KEIN HTML, keine <cite> Tags: {"golden_dome":{"budget":"$X Mrd","rklb_anteil":"$X Mio","status":"Status","desc":"1-2 Sätze RKLB-Relevanz"},"sda":{"budget":"$X Mrd","rklb_auftraege":"X Aufträge / $X Mio","status":"Status","desc":"1-2 Sätze RKLB Tranche Status"},"nasa":{"program":"VCLS/CLPS","wert":"$X Mio","status":"Status","desc":"1 Satz"},"space_force":{"program":"NSSL","wert":"$X Mio","status":"Status","desc":"1 Satz"},"ausblick":"1 Satz RKLB Government Revenue Ausblick"}`;

    const GOV_ASTS_PROMPT = `Aktuelle US Regulierung für ASTS: 1) FCC Frequenzlizenz-Status. 2) ITU internationale Koordination. 3) DoD/Military Nutzungspotenzial. 4) NTIA Frequenzverwaltung.
    Antworte NUR mit JSON, KEIN HTML, keine <cite> Tags: {"fcc":{"status":"Status Lizenz","frequenz":"Frequenzband","desc":"1-2 Sätze FCC Genehmigungsstatus"},"itu":{"status":"Status","desc":"1 Satz internationale Koordination"},"dod":{"potenzial":"Hoch/Mittel/Niedrig","desc":"1-2 Sätze DoD Nutzungspotenzial"},"ntia":{"status":"Status","desc":"1 Satz"},"ausblick":"1 Satz ASTS Regulierungs-Ausblick"}`;

    const allCalls = [
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
      { ticker:null,   section:'glossar',  prompt: GLOSSAR_PROMPT },
      { ticker:'rklb', section:'gov_space', prompt: GOV_RKLB_PROMPT },
      { ticker:'asts', section:'gov_space', prompt: GOV_ASTS_PROMPT },
    ];
    // Filter by scope for faster execution
    const calls = scope === 'rklb' ? allCalls.filter(c => c.ticker === 'rklb') :
                  scope === 'asts' ? allCalls.filter(c => c.ticker === 'asts') :
                  scope === 'global' ? allCalls.filter(c => !c.ticker) :
                  allCalls;
    console.log(`Running ${calls.length} calls for scope: ${scope}`);

    // Run in parallel batches to stay within timeout
    const batch1 = calls.slice(0, 7);  // first 7
    const batch2 = calls.slice(7);     // remaining 6

    async function runCall(call) {
      try {
        const data = await kiCall(call.prompt);
        await saveToCache(call.ticker, call.section, data);
        results.success.push(`${call.ticker}/${call.section}`);
      } catch(e) {
        results.failed.push(`${call.ticker}/${call.section}: ${e.message}`);
      }
    }

    // Batch 1: run with small stagger
    for (const call of batch1) {
      await runCall(call);
      await delay(2000);
    }
    // Batch 2: parallel (2 at a time)
    for (let i = 0; i < batch2.length; i += 2) {
      await Promise.all([
        runCall(batch2[i]),
        batch2[i+1] ? runCall(batch2[i+1]) : Promise.resolve()
      ]);
      await delay(2000);
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
