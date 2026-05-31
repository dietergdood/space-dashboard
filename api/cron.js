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
      const timeout = setTimeout(() => controller.abort(), 80000); // 80s timeout
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
          max_tokens: 1024,
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
    // Strip markdown code blocks if present
    let jsonStr = raw.replace(/^```json\s*/,'').replace(/^```\s*/,'').replace(/\s*```$/,'').trim();
    // Find JSON object or array
    const match = jsonStr.match(/\{[\s\S]*\}/);
    if (!match) {
      console.error('No JSON found. Raw:', raw.substring(0,300));
      throw new Error('No JSON in response');
    }
    try {
      return JSON.parse(match[0]);
    } catch(parseErr) {
      console.error('JSON parse error:', parseErr.message, '| JSON:', match[0].substring(0,200));
      try {
        // Strategy 1: fix control characters
        let fixed = match[0]
          .replace(/\r?\n/g, ' ')
          .replace(/\t/g, ' ');
        return JSON.parse(fixed);
      } catch(e2) {
        try {
          // Strategy 2: use a lenient JSON parser approach
          // Extract each field manually for known structures
          const raw2 = match[0];
          // Try to salvage articles array
          if (raw2.includes('"articles"')) {
            const articles = [];
            // Split by article objects
            const titleMatches = [...raw2.matchAll(/"title":\s*"([^"]{1,120})"/g)];
            const sentMatches  = [...raw2.matchAll(/"sentiment":\s*"([^"]{1,10})"/g)];
            const sourceMatches= [...raw2.matchAll(/"source":\s*"([^"]{1,100})"/g)];
            // For body: take text between "body":" and the next ","sentiment" or ","source"
            const bodyMatches  = [...raw2.matchAll(/"body":\s*"(.*?)(?:","sentiment"|","source")/gs)];
            const count = Math.min(titleMatches.length, sentMatches.length);
            for (let i = 0; i < count; i++) {
              articles.push({
                title: titleMatches[i][1],
                sentiment: sentMatches[i][1],
                body: bodyMatches[i] ? bodyMatches[i][1].replace(/<[^>]*>/g,'').replace(/\\n/g,' ').trim() : '',
                source: sourceMatches[i] ? sourceMatches[i][1] : ''
              });
            }
            if (articles.length > 0) {
              console.log('Salvaged', articles.length, 'articles');
              return {articles};
            }
          }
          // Try to salvage cards array
          if (raw2.includes('"cards"')) {
            const introMatch = raw2.match(/"intro":\s*"([^"]+)"/);
            const cards = [];
            const cardMatches = raw2.matchAll(/"emoji":\s*"([^"]+)"[^}]*?"name":\s*"([^"]+)"[^}]*?"val":\s*"([^"]+)"[^}]*?"val_color":\s*"([^"]+)"[^}]*?"desc":\s*"([^"]+)"/g);
            for (const m of cardMatches) {
              cards.push({emoji:m[1], name:m[2], val:m[3], val_color:m[4], desc:m[5]});
            }
            if (cards.length > 0) {
              console.log('Salvaged', cards.length, 'cards');
              return {intro: introMatch?.[1]||'', cards};
            }
          }
          console.error('JSON salvage failed');
          throw new Error('JSON parse failed: ' + parseErr.message);
        } catch(e3) {
          console.error('All JSON strategies failed:', e3.message);
          throw new Error('JSON parse failed: ' + parseErr.message);
        }
      }
    }
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

    const results = { success: [], failed: [], startTime: Date.now() };

    const REC_PROMPTS = {
      rklb: `Analysiere Rocket Lab (RKLB). Suche auf: rocketlabusa.com/investors, SEC Filings, Reuters, Bloomberg, CNBC, Seeking Alpha, SpaceNews, NASASpaceFlight, Breaking Defense, SpaceForce.mil, Reddit r/RocketLab r/space, X/@RocketLab, StockTwits RKLB, TipRanks, Zacks. Berücksichtige Abhängigkeiten: SpaceX (Konkurrenz Electron vs Falcon9, Neutron vs Falcon9), Blue Origin New Glenn, Amazon Kuiper Aufträge, NASA/SpaceForce Aufträge, SDA Tracking Layer. Antworte NUR mit JSON, KEIN HTML in Texten ausser bei explain_* Feldern, keine <cite> Tags: {"empfehlung":"KAUFEN","titel":"Max 80 Zeichen","begruendung":"2-4 Sätze","fundamentals":8,"momentum":7,"risiko":6,"bewertung":5,"explain_fundamentals":"<b>Fundamentals</b> — 1 Satz","explain_momentum":"<b>Momentum</b> — 1 Satz","explain_risiko":"<b>Risiko</b> — <b>Höherer Score = niedrigeres Risiko.</b> 1 Satz","explain_bewertung":"<b>Bewertung</b> — 1 Satz","einstieg":"$120-130","kursziel":"$180","stopp":"$105","lage":"<b>Aktuelle Lage:</b> 1-2 Sätze","lage_typ":"positive","analysten":"12x Kaufen"}`,
      asts: `Analysiere AST SpaceMobile (ASTS) umfassend. OFFIZIELLE QUELLEN: ast-science.com/news, ast-science.com/investors, SEC EDGAR 8-K, Earnings Call Transcripts, IR Pressemitteilungen. FINANZMEDIEN: CNBC, Bloomberg, Reuters, Wall Street Journal, Financial Times, Forbes, Business Insider, Fortune, The Economist. BÖRSENPORTALE: Yahoo Finance, MarketWatch, Barron's, TheStreet, InvestorPlace, Benzinga, Motley Fool, Seeking Alpha, Zacks, TipRanks, Simply Wall St, Stockanalysis.com, Finviz, TradingView, Nasdaq.com, NYSE.com, Visible Alpha, Morningstar Research, CFRA Research, Estimize. ANALYSTEN: Goldman Sachs Research, Morgan Stanley, Bank of America, JPMorgan, Needham, Canaccord, Scotiabank, NorthCoast Research, Deutsche Bank, Wedbush Securities, Piper Sandler. SPACE/TELECOM-MEDIEN: SpaceNews, NASASpaceFlight, Via Satellite, Ars Technica Space, Payload Space (payload.space), Space Policy Online (spacepolicyonline.com), Space Capital (spacecapital.com), Bryce Tech (brycetech.com), The Orbit Report, Commercial Space News, FierceWireless, Light Reading, TechCrunch, RCR Wireless News (rcrwireless.com), Satellite Today (satellitetoday.com), Mobile World Live, GSMA Intelligence, Telecom TV. POLICY: CSIS (csis.org), Secure World Foundation (swfound.org), Space Foundation (spacefoundation.org), Bryce Tech Space Reports. INTERNATIONAL: Handelsblatt, Nikkei Asia, Caixin (chinesische Space-Konkurrenz). SOCIAL MEDIA: Reddit r/RocketLab r/ASTS r/space r/investing r/wallstreetbets r/stocks, X/Twitter @RocketLab @AST_SpaceMobile #RKLB #ASTS, StockTwits RKLB ASTS, Telegram RKLB/ASTS Channels, Facebook Investor Groups RKLB/ASTS, Instagram @rocketlab @astspacemobile, YouTube @RocketLab @ASTSpaceMobile, Discord RKLB/ASTS Community Servers. BEHÖRDEN: defense.gov, spaceforce.mil, sda.mil, nasa.gov, fcc.gov, itu.int, ntia.gov, breakingdefense.com, defensenews.com, esa.int, jaxa.jp, ofcom.org.uk, bundesnetzagentur.de. PARTNER-NEWS: T-Mobile, AT&T, Verizon Newsroom. Berücksichtige: Starlink D2D Konkurrenz, AT&T/Verizon/T-Mobile Partnerships, FCC/ITU Lizenzen, BlueBird Satelliten Status, Insider-Trading SEC EDGAR. Antworte NUR mit JSON, KEIN HTML in Texten ausser bei explain_* Feldern, keine <cite> Tags: {"empfehlung":"HALTEN","titel":"Max 80 Zeichen","begruendung":"2-4 Sätze","fundamentals":5,"momentum":8,"risiko":4,"bewertung":3,"explain_fundamentals":"<b>Fundamentals</b> — 1 Satz","explain_momentum":"<b>Momentum</b> — 1 Satz","explain_risiko":"<b>Risiko</b> — <b>Höherer Score = niedrigeres Risiko.</b> 1 Satz","explain_bewertung":"<b>Bewertung</b> — 1 Satz","einstieg":"$80-90","kursziel":"$140","stopp":"$70","lage":"<b>Aktuelle Lage:</b> 1-2 Sätze","lage_typ":"warning","analysten":"8x Kaufen","earnings_date":"YYYY-MM-DD nächster Earnings-Termin"}`
    };

    const NEWS_PROMPTS = {
      rklb: `Suche aktuelle RKLB Rocket Lab Nachrichten der letzten 48h. OFFIZIELLE QUELLEN: rocketlabusa.com/updates, rocketlabusa.com/investors, SEC EDGAR 8-K, Earnings Call Transcripts, IR Pressemitteilungen. FINANZMEDIEN: CNBC, Bloomberg, Reuters, Wall Street Journal, Financial Times, Forbes, Business Insider, Fortune, The Economist. BÖRSENPORTALE: Yahoo Finance, MarketWatch, Barron's, TheStreet, InvestorPlace, Benzinga, Motley Fool, Seeking Alpha, Zacks, TipRanks, Simply Wall St, Stockanalysis.com, Finviz, TradingView, Nasdaq.com, NYSE.com, Visible Alpha, Morningstar Research, CFRA Research, Estimize. ANALYSTEN: Goldman Sachs Research, Morgan Stanley, Bank of America, JPMorgan, Needham, Canaccord, Scotiabank, NorthCoast Research, Deutsche Bank, Wedbush Securities, Piper Sandler. SPACE-MEDIEN: SpaceNews, NASASpaceFlight, SpaceflightNow, Via Satellite, Aviation Week, Ars Technica Space, Space.com, Parabolic Arc, Payload Space (payload.space), Space Policy Online (spacepolicyonline.com), Space Capital (spacecapital.com), Bryce Tech (brycetech.com), The Orbit Report, Commercial Space News. POLICY/RESEARCH: CSIS (csis.org), Secure World Foundation (swfound.org), Space Foundation (spacefoundation.org), Bryce Tech Space Reports. INTERNATIONAL: Handelsblatt, Nikkei Asia, Caixin (chinesische Space-Konkurrenz). SOCIAL MEDIA: Reddit r/RocketLab r/ASTS r/space r/investing r/wallstreetbets r/stocks, X/Twitter @RocketLab @AST_SpaceMobile #RKLB #ASTS, StockTwits RKLB ASTS, Telegram RKLB/ASTS Channels, Facebook Investor Groups RKLB/ASTS, Instagram @rocketlab @astspacemobile, YouTube @RocketLab @ASTSpaceMobile, Discord RKLB/ASTS Community Servers. BEHÖRDEN: defense.gov, spaceforce.mil, sda.mil, nasa.gov, fcc.gov, itu.int, ntia.gov, breakingdefense.com, defensenews.com, esa.int, jaxa.jp. Antworte NUR mit gültigem JSON (keine Zeilenumbrüche in Strings, keine Sonderzeichen), KEIN HTML, keine <cite> Tags: {"articles":[{"title":"Titel max 80 Zeichen","sentiment":"pos|neg|neu","body":"2-3 Sätze auf Deutsch, kein Zeilenumbruch im Text","source":"Exakte Quelle"}]}`,
      asts: `Suche aktuelle ASTS AST SpaceMobile Nachrichten der letzten 48h. OFFIZIELLE QUELLEN: ast-science.com/news, ast-science.com/investors, SEC EDGAR 8-K, Earnings Call Transcripts, IR Pressemitteilungen. FINANZMEDIEN: CNBC, Bloomberg, Reuters, Wall Street Journal, Financial Times, Forbes, Business Insider, Fortune, The Economist. BÖRSENPORTALE: Yahoo Finance, MarketWatch, Barron's, TheStreet, InvestorPlace, Benzinga, Motley Fool, Seeking Alpha, Zacks, TipRanks, Simply Wall St, Stockanalysis.com, Finviz, TradingView, Nasdaq.com, NYSE.com, Visible Alpha, Morningstar Research, CFRA Research, Estimize. ANALYSTEN: Goldman Sachs Research, Morgan Stanley, Bank of America, JPMorgan, Needham, Canaccord, Scotiabank, NorthCoast Research, Deutsche Bank, Wedbush Securities, Piper Sandler. SPACE/TELECOM-MEDIEN: SpaceNews, NASASpaceFlight, Via Satellite, Ars Technica Space, Payload Space (payload.space), Space Policy Online (spacepolicyonline.com), Space Capital (spacecapital.com), Bryce Tech (brycetech.com), The Orbit Report, Commercial Space News, FierceWireless, Light Reading, TechCrunch, RCR Wireless News (rcrwireless.com), Satellite Today (satellitetoday.com), Mobile World Live, GSMA Intelligence, Telecom TV. POLICY: CSIS (csis.org), Secure World Foundation (swfound.org), Space Foundation (spacefoundation.org), Bryce Tech Space Reports. INTERNATIONAL: Handelsblatt, Nikkei Asia, Caixin (chinesische Space-Konkurrenz). SOCIAL MEDIA: Reddit r/RocketLab r/ASTS r/space r/investing r/wallstreetbets r/stocks, X/Twitter @RocketLab @AST_SpaceMobile #RKLB #ASTS, StockTwits RKLB ASTS, Telegram RKLB/ASTS Channels, Facebook Investor Groups RKLB/ASTS, Instagram @rocketlab @astspacemobile, YouTube @RocketLab @ASTSpaceMobile, Discord RKLB/ASTS Community Servers. BEHÖRDEN: defense.gov, spaceforce.mil, sda.mil, nasa.gov, fcc.gov, itu.int, ntia.gov, breakingdefense.com, defensenews.com, esa.int, jaxa.jp, ofcom.org.uk, bundesnetzagentur.de. PARTNER-NEWS: T-Mobile, AT&T, Verizon Newsroom. Antworte NUR mit gültigem JSON (keine Zeilenumbrüche in Strings, keine Sonderzeichen), KEIN HTML, keine <cite> Tags: {"articles":[{"title":"Titel max 80 Zeichen","sentiment":"pos|neg|neu","body":"2-3 Sätze auf Deutsch, kein Zeilenumbruch im Text","source":"Exakte Quelle"}]}`
    };

    const SCENARIOS_PROMPTS = {
      rklb: `Analysiere RKLB Kursziele. Quellen für Analysten-Kursziele: Goldman Sachs Research, Morgan Stanley, Bank of America, JPMorgan, Needham, Canaccord, Scotiabank, NorthCoast Research, Deutsche Bank, Wedbush Securities, Piper Sandler, Yahoo Finance, MarketWatch, Barron's, TheStreet, InvestorPlace, Benzinga, Motley Fool, Seeking Alpha, Zacks, TipRanks, Simply Wall St, Stockanalysis.com, Finviz, TradingView, Investopedia, 24/7 Wall St, Nasdaq.com, NYSE.com. Für Community-Sentiment: Reddit r/RocketLab r/ASTS r/space r/investing r/wallstreetbets r/stocks, X/Twitter @RocketLab @AST_SpaceMobile #RKLB #ASTS, StockTwits RKLB ASTS, Telegram RKLB/ASTS Channels, Facebook Investor Groups RKLB/ASTS, Instagram @rocketlab @astspacemobile, YouTube @RocketLab @ASTSpaceMobile, Discord RKLB/ASTS Community Servers. Suche auf: rocketlabusa.com/updates, X/Twitter (@RocketLab), Reddit r/RocketLab, r/stocks, StockTwits RKLB, Yahoo Finance, Bloomberg, Reuters, SEC Filings (sec.gov), Seeking Alpha, The Motley Fool. Suche aktuelle Analysten-Kursziele von Goldman Sachs, Morgan Stanley, Bank of America, Needham, Canaccord. Prüfe auch Reddit r/RocketLab und StockTwits für Retail-Sentiment. WICHTIG: bull_pct=100 (immer), opt_pct/base_pct/bear_pct = Balkenlänge 0-100 (KEINE negativen Werte, immer zwischen 0 und 100). Antworte NUR mit JSON, KEIN HTML, keine <cite> Tags: {"intro":"1 Satz ohne HTML","bull_label":"$XXX","bull_pct":100,"opt_label":"$XXX","opt_pct":56,"base_label":"$XXX","base_pct":40,"bear_label":"$XX","bear_pct":25,"bull_target":216,"base_target":120,"bear_target":86,"bull5yr":450,"base5yr":220,"bear5yr":70,"bull_desc":"Szenario → $XXX","base_desc":"Bankexperten → $XXX","bear_desc":"Szenario → $XX","sentiment":"2 Sätze Gesamt-Community-Stimmung ohne HTML","sentiment_warning":false,"sentiment_reddit":"Bullish|Bearish|Neutral","sentiment_reddit_sub":"1 Satz r/RocketLab Stimmung","sentiment_x":"Bullish|Bearish|Neutral","sentiment_x_sub":"1 Satz X/Twitter Stimmung","sentiment_st":"Bullish|Bearish|Neutral","sentiment_st_sub":"1 Satz StockTwits","sentiment_tg":"Bullish|Bearish|Neutral","sentiment_tg_sub":"1 Satz Telegram Channels","sentiment_fb":"Bullish|Bearish|Neutral","sentiment_fb_sub":"1 Satz Facebook/Instagram"}`,
      asts: `Analysiere ASTS Kursziele. Quellen für Analysten-Kursziele: Goldman Sachs Research, Morgan Stanley, Bank of America, JPMorgan, Needham, Canaccord, Scotiabank, NorthCoast Research, Deutsche Bank, Wedbush Securities, Piper Sandler, Yahoo Finance, MarketWatch, Barron's, TheStreet, InvestorPlace, Benzinga, Motley Fool, Seeking Alpha, Zacks, TipRanks, Simply Wall St, Stockanalysis.com, Finviz, TradingView, Investopedia, 24/7 Wall St, Nasdaq.com, NYSE.com. Für Community-Sentiment: Reddit r/RocketLab r/ASTS r/space r/investing r/wallstreetbets r/stocks, X/Twitter @RocketLab @AST_SpaceMobile #RKLB #ASTS, StockTwits RKLB ASTS, Telegram RKLB/ASTS Channels, Facebook Investor Groups RKLB/ASTS, Instagram @rocketlab @astspacemobile, YouTube @RocketLab @ASTSpaceMobile, Discord RKLB/ASTS Community Servers. Suche auf: ast-science.com/news, X/Twitter (@AST_SpaceMobile), Reddit r/ASTS, r/stocks, StockTwits ASTS, Yahoo Finance, Bloomberg, Reuters, SEC Filings (sec.gov), Seeking Alpha, The Motley Fool. Suche aktuelle Analysten-Kursziele von Scotiabank, ASB Securities, NorthCoast Research. Prüfe auch Reddit r/ASTS und StockTwits für Retail-Sentiment. WICHTIG: bull_pct=100 (immer), opt_pct/base_pct/bear_pct = Balkenlänge 0-100 (KEINE negativen Werte, immer zwischen 0 und 100). Antworte NUR mit JSON, KEIN HTML, keine <cite> Tags: {"intro":"1 Satz ohne HTML","bull_label":"$XXX","bull_pct":100,"opt_label":"$XXX","opt_pct":54,"base_label":"$XX","base_pct":40,"bear_label":"$XX","bear_pct":25,"bull_target":200,"base_target":83,"bear_target":50,"bull5yr":380,"base5yr":120,"bear5yr":25,"bull_desc":"Szenario → $XXX","base_desc":"Bankexperten → $XX","bear_desc":"Szenario → $XX","sentiment":"2 Sätze Gesamt-Community-Stimmung ohne HTML","sentiment_warning":true,"sentiment_reddit":"Bullish|Bearish|Neutral","sentiment_reddit_sub":"1 Satz r/ASTS Stimmung","sentiment_x":"Bullish|Bearish|Neutral","sentiment_x_sub":"1 Satz X/Twitter Stimmung","sentiment_st":"Bullish|Bearish|Neutral","sentiment_st_sub":"1 Satz StockTwits","sentiment_tg":"Bullish|Bearish|Neutral","sentiment_tg_sub":"1 Satz Telegram Channels","sentiment_fb":"Bullish|Bearish|Neutral","sentiment_fb_sub":"1 Satz Facebook/Instagram"}`
    };

    const SECTOR_PROMPTS = {
      rklb: `Analysiere Sektor-Kontext und Abhängigkeiten für RKLB. Analysiere aktuell (Quellen: SpaceNews, Via Satellite, Breaking Defense, ESA.int, JAXA.jp, NASA.gov, defense.gov): 1) SpaceX als Konkurrent UND potenzieller Kunde (Rideshare). 2) Blue Origin/New Glenn als direkter Konkurrent. 3) Amazon Project Kuiper als potenzielle RKLB Launch-Aufträge. 4) US Government (NASA, Space Force, SDA) als Hauptkunde. 5) Golden Dome Raketenabwehr-Budget. Antworte NUR mit JSON, KEIN HTML, keine <cite> Tags: {"intro":"1 Satz ohne HTML","cards":[{"emoji":"🚀","name":"SpaceX","val":"Konkurrent","val_color":"purple","desc":"Falcon 9 vs Electron, Neutron vs Falcon 9 — aktuelle Marktanteile"},{"emoji":"🛡","name":"Golden Dome","val":"Budget $X Mrd","val_color":"green","desc":"Aktuelles Programm-Budget und RKLB Vertragsanteil"},{"emoji":"🛸","name":"SDA Tracking Layer","val":"Status","val_color":"blue","desc":"Space Development Agency Aufträge — RKLB Tranche Status"},{"emoji":"🌕","name":"NASA Aufträge","val":"Status","val_color":"blue","desc":"Aktuelle NASA VCLS, CLPS und sonstige Launch-Aufträge"},{"emoji":"⚔️","name":"Space Force","val":"Budget","val_color":"green","desc":"US Space Force Launch-Aufträge und NSSL Programm"},{"emoji":"📦","name":"Amazon Kuiper","val":"Potenzial","val_color":"amber","desc":"Kuiper Konstellation Launch-Aufträge — Status"}]}`,
      asts: `Analysiere Sektor-Kontext und Abhängigkeiten für ASTS. Analysiere aktuell (Quellen: SpaceNews, Via Satellite, FierceWireless, ESA.int, fcc.gov, T-Mobile/AT&T/Verizon Newsroom): 1) Starlink Direct-to-Cell als direkter Hauptkonkurrent (SpaceX/T-Mobile). 2) AT&T Partnership Status und Umsatzpotenzial. 3) Verizon Partnership Status. 4) Amazon Project Kuiper D2D Pläne. 5) Blue Origin D2D Pläne. 6) T-Mobile Starlink vs ASTS Exklusivität. Antworte NUR mit JSON, KEIN HTML, keine <cite> Tags: {"intro":"1 Satz ohne HTML","cards":[{"emoji":"⚡","name":"Starlink D2D","val":"Konkurrent","val_color":"red","desc":"SpaceX/T-Mobile D2D — aktuelle Abdeckung und Nutzerzahlen vs ASTS"},{"emoji":"📱","name":"AT&T & Verizon","val":"Partner","val_color":"green","desc":"Kommerzieller Rollout-Status, Nutzerzahlen, Revenue-Sharing"},{"emoji":"🌍","name":"Globale Carrier","val":"Anzahl Partner","val_color":"blue","desc":"Aktuelle Anzahl Carrier-Partner weltweit und neue Verträge"},{"emoji":"🛰","name":"Satelliten-Netz","val":"X Satelliten","val_color":"blue","desc":"Aktuelle Anzahl BlueBird Satelliten im Orbit und Abdeckung"},{"emoji":"📡","name":"FCC Lizenzen","val":"Status","val_color":"green","desc":"FCC Frequenz-Lizenzen und regulatorische Genehmigungen"},{"emoji":"📦","name":"Amazon Kuiper D2D","val":"Zeitplan","val_color":"amber","desc":"Kuiper Direct-to-Device Pläne und Bedrohung für ASTS"}]}`
    };

    const CTX_PROMPTS = {
      rklb: `Aktuelle Rocket Lab (RKLB) Firmendaten: Backlog, Revenue, Mitarbeiter, HQ, Gründungsjahr. Quellen: rocketlabusa.com, SEC Filings, letzter Earnings Call. Antworte NUR mit JSON, KEIN HTML, keine <cite> Tags: {"desc":"1-2 Sätze ohne HTML","tags":[{"text":"Tag","type":"green"}],"stats":[{"label":"Backlog","val":"$X Mrd"}]}`,
      asts: `Aktuelle AST SpaceMobile (ASTS) Firmendaten: Cash, Satelliten im Orbit, Partner-Carrier, Gründungsjahr. Quellen: ast-science.com, SEC Filings, letzter Earnings Call. Antworte NUR mit JSON, KEIN HTML, keine <cite> Tags: {"desc":"1-2 Sätze ohne HTML","tags":[{"text":"Tag","type":"green"}],"stats":[{"label":"Cash","val":"$X Mrd"}]}`
    };

    const SPCX_NEWS_PROMPT = `Suche aktuelle SpaceX Nachrichten der letzten 48h. OFFIZIELLE QUELLEN: spacex.com/updates, spacex.com/careers, SEC EDGAR S-1/8-K (wenn IPO erfolgt), Elon Musk X Posts, SpaceX Pressemitteilungen.
FINANZMEDIEN: Reuters, Bloomberg, CNBC, Wall Street Journal, Financial Times, Forbes, Business Insider, The Economist.
BÖRSENPORTALE: Yahoo Finance, MarketWatch, Barron's, Seeking Alpha, TheStreet, Benzinga, TipRanks, Zacks, TradingView, Finviz, Stockanalysis.com.
ANALYSTEN: Goldman Sachs, Morgan Stanley, JPMorgan, Bank of America, ARK Invest (Cathie Wood), Wedbush (Dan Ives), Piper Sandler.
SPACE-MEDIEN: SpaceNews, NASASpaceFlight, SpaceflightNow, Via Satellite, Aviation Week, Ars Technica Space, Payload Space (payload.space), Space Policy Online (spacepolicyonline.com), Space Capital (spacecapital.com), Bryce Tech (brycetech.com), The Orbit Report, Commercial Space News. POLICY: CSIS (csis.org), Secure World Foundation (swfound.org), Space Foundation (spacefoundation.org), Bryce Tech Space Reports.
SOCIAL MEDIA: Reddit r/spacex r/SpaceXLounge r/investing r/wallstreetbets, X @SpaceX @elonmusk #SPCX #SpaceX, StockTwits SPCX, Telegram SpaceX Channels, Facebook SpaceX Groups, Instagram @spacex, YouTube SpaceX Channel, Discord SpaceX Communities.
BEHÖRDEN: nasa.gov, faa.gov (Launch-Lizenzen), defense.gov, spaceforce.mil, sec.gov, ftc.gov.
KONKURRENZ: rocketlabusa.com, blueorigin.com, virgingalactic.com, unitedlaunchalliance.com, arianespace.com. Fokus auf: IPO-Status, Starlink, Starship, NASA Aufträge, FAA Lizenzen, Konkurrenz. Antworte NUR mit gültigem JSON. KRITISCH: Keine <cite> Tags, kein HTML, keine Anführungszeichen in Strings, keine Zeilenumbrüche: {"articles":[{"title":"Titel max 80 Zeichen","sentiment":"pos|neg|neu","body":"2-3 Sätze auf Deutsch ohne jegliche Tags","source":"Exakte Quelle"}]}`;

    const SPCX_SECTOR_PROMPT = `Analysiere SpaceX Marktposition und IPO-Status. OFFIZIELLE QUELLEN: spacex.com/updates, spacex.com/careers, SEC EDGAR S-1/8-K (wenn IPO erfolgt), Elon Musk X Posts, SpaceX Pressemitteilungen.
FINANZMEDIEN: Reuters, Bloomberg, CNBC, Wall Street Journal, Financial Times, Forbes, Business Insider, The Economist.
BÖRSENPORTALE: Yahoo Finance, MarketWatch, Barron's, Seeking Alpha, TheStreet, Benzinga, TipRanks, Zacks, TradingView, Finviz, Stockanalysis.com.
ANALYSTEN: Goldman Sachs, Morgan Stanley, JPMorgan, Bank of America, ARK Invest (Cathie Wood), Wedbush (Dan Ives), Piper Sandler.
SPACE-MEDIEN: SpaceNews, NASASpaceFlight, SpaceflightNow, Via Satellite, Aviation Week, Ars Technica Space, Payload Space (payload.space), Space Policy Online (spacepolicyonline.com), Space Capital (spacecapital.com), Bryce Tech (brycetech.com), The Orbit Report, Commercial Space News. POLICY: CSIS (csis.org), Secure World Foundation (swfound.org), Space Foundation (spacefoundation.org), Bryce Tech Space Reports.
SOCIAL MEDIA: Reddit r/spacex r/SpaceXLounge r/investing r/wallstreetbets, X @SpaceX @elonmusk #SPCX #SpaceX, StockTwits SPCX, Telegram SpaceX Channels, Facebook SpaceX Groups, Instagram @spacex, YouTube SpaceX Channel, Discord SpaceX Communities.
BEHÖRDEN: nasa.gov, faa.gov (Launch-Lizenzen), defense.gov, spaceforce.mil, sec.gov, ftc.gov.
KONKURRENZ: rocketlabusa.com, blueorigin.com, virgingalactic.com, unitedlaunchalliance.com, arianespace.com. Analysiere: IPO-Vorbereitungen (S-1, Roadshow, Bewertung), Starlink Nutzerzahlen/Revenue, Starship Entwicklungsstand, FAA Lizenzen, NASA Artemis Aufträge, Konkurrenz (RKLB, Blue Origin, ULA, Arianespace). WICHTIG: Antworte NUR mit gültigem JSON, KEIN HTML, keine <cite> Tags, keine Zeilenumbrüche in Strings: {"intro":"1 Satz","ipo_status":"aktueller IPO Status","ipo_date":"Datum","bewertung":"$XXX Mrd","cards":[{"emoji":"🛸","name":"Starlink","val":"X Mio Nutzer","val_color":"green","desc":"Revenue und Wachstum"},{"emoji":"🚀","name":"Falcon 9","val":"X Starts","val_color":"blue","desc":"Marktanteil"},{"emoji":"⭐","name":"Starship","val":"Status","val_color":"amber","desc":"Entwicklungsstand"},{"emoji":"🏆","name":"Marktanteil","val":"X%","val_color":"green","desc":"global kommerziell"}]}`;

    const SPCX_CTX_PROMPT = `Aktuelle SpaceX Firmendaten. OFFIZIELLE QUELLEN: spacex.com/updates, spacex.com/careers, SEC EDGAR S-1/8-K (wenn IPO erfolgt), Elon Musk X Posts, SpaceX Pressemitteilungen.
FINANZMEDIEN: Reuters, Bloomberg, CNBC, Wall Street Journal, Financial Times, Forbes, Business Insider, The Economist.
BÖRSENPORTALE: Yahoo Finance, MarketWatch, Barron's, Seeking Alpha, TheStreet, Benzinga, TipRanks, Zacks, TradingView, Finviz, Stockanalysis.com.
ANALYSTEN: Goldman Sachs, Morgan Stanley, JPMorgan, Bank of America, ARK Invest (Cathie Wood), Wedbush (Dan Ives), Piper Sandler.
SPACE-MEDIEN: SpaceNews, NASASpaceFlight, SpaceflightNow, Via Satellite, Aviation Week, Ars Technica Space, Payload Space (payload.space), Space Policy Online (spacepolicyonline.com), Space Capital (spacecapital.com), Bryce Tech (brycetech.com), The Orbit Report, Commercial Space News. POLICY: CSIS (csis.org), Secure World Foundation (swfound.org), Space Foundation (spacefoundation.org), Bryce Tech Space Reports.
SOCIAL MEDIA: Reddit r/spacex r/SpaceXLounge r/investing r/wallstreetbets, X @SpaceX @elonmusk #SPCX #SpaceX, StockTwits SPCX, Telegram SpaceX Channels, Facebook SpaceX Groups, Instagram @spacex, YouTube SpaceX Channel, Discord SpaceX Communities.
BEHÖRDEN: nasa.gov, faa.gov (Launch-Lizenzen), defense.gov, spaceforce.mil, sec.gov, ftc.gov.
KONKURRENZ: rocketlabusa.com, blueorigin.com, virgingalactic.com, unitedlaunchalliance.com, arianespace.com. Antworte NUR mit JSON, KEIN HTML, keine Zeilenumbrüche: {"desc":"1-2 Sätze aktueller Stand","tags":[{"text":"Raketen","type":"blue"},{"text":"Starlink","type":"green"},{"text":"IPO 2026","type":"amber"}],"stats":[{"label":"Bewertung","val":"$XXX Mrd"},{"label":"Mitarbeiter","val":"~13000"},{"label":"Starts 2025","val":"X"}]}`;

    const GLOSSAR_PROMPT = `Analysiere aktuelle RKLB und ASTS News. Quellen: SpaceNews (spacenews.com), NASASpaceFlight (nasaspaceflight.com), SpaceflightNow, Ars Technica Space, Space.com, Aviation Week, Via Satellite (viasatellite.com), Parabolic Arc, SpaceRef, CNBC, Bloomberg, Reuters, Wall Street Journal, Financial Times, Forbes, Business Insider, Fortune, The Economist, Yahoo Finance, MarketWatch, Barron's, TheStreet, InvestorPlace, Benzinga, Motley Fool, Seeking Alpha, Zacks, TipRanks, Simply Wall St, Stockanalysis.com, Finviz, TradingView, Investopedia, 24/7 Wall St, Nasdaq.com, NYSE.com, SEC EDGAR, Reddit r/RocketLab r/ASTS r/space r/investing r/wallstreetbets r/stocks, X/Twitter @RocketLab @AST_SpaceMobile #RKLB #ASTS, StockTwits RKLB ASTS, Telegram RKLB/ASTS Channels, Facebook Investor Groups RKLB/ASTS, Instagram @rocketlab @astspacemobile, YouTube @RocketLab @ASTSpaceMobile, Discord RKLB/ASTS Community Servers, rocketlabusa.com, ast-science.com. Welche 2-4 neue Fachbegriffe aus Space/Finance tauchen auf? Suche auch das aktuelle Budget des US "Golden Dome" Programms auf defense.gov. Antworte NUR mit JSON, KEIN HTML, keine <cite> Tags: {"golden_dome_def":"US-Raketenabwehr (BETRAG). Rocket Lab Lieferant.","terms":[{"term":"Begriff","def":"Kurze Erklärung ohne HTML"}]}`;

    const GOV_RKLB_PROMPT = `Aktuelle US Gov & internationale Aufträge für RKLB. Quellen: defense.gov, sda.mil, spaceforce.mil, nasa.gov, breakingdefense.com, spacenews.com, esa.int, jaxa.jp, SEC EDGAR. Analysiere: 1) Golden Dome Budget + RKLB Anteil. 2) SDA Tracking Layer RKLB Aufträge. 3) NASA VCLS/CLPS Launch-Aufträge. 4) Space Force NSSL Status. 5) ESA/JAXA internationale Kooperationen.
    Antworte NUR mit JSON, KEIN HTML, keine <cite> Tags: {"golden_dome":{"budget":"$X Mrd","rklb_anteil":"$X Mio","status":"Status","desc":"1-2 Sätze RKLB-Relevanz"},"sda":{"budget":"$X Mrd","rklb_auftraege":"X Aufträge / $X Mio","status":"Status","desc":"1-2 Sätze RKLB Tranche Status"},"nasa":{"program":"VCLS/CLPS","wert":"$X Mio","status":"Status","desc":"1 Satz"},"space_force":{"program":"NSSL","wert":"$X Mio","status":"Status","desc":"1 Satz"},"ausblick":"1 Satz RKLB Government Revenue Ausblick"}`;

    const GOV_ASTS_PROMPT = `Aktuelle US & internationale Regulierung für ASTS. Quellen: fcc.gov, itu.int, ntia.gov, defense.gov, esa.int, ofcom.org.uk (UK), bundesnetzagentur.de (DE). Analysiere: 1) FCC Frequenzlizenz-Status. 2) ITU internationale Koordination. 3) DoD/Military Nutzungspotenzial. 4) NTIA Frequenzverwaltung. 5) Europäische Regulierung (ESA, Ofcom, Bundesnetzagentur).
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
      { ticker:'spcx', section:'news',     prompt: SPCX_NEWS_PROMPT },
      { ticker:'spcx', section:'sector',   prompt: SPCX_SECTOR_PROMPT },
      { ticker:'spcx', section:'ctx',      prompt: SPCX_CTX_PROMPT },
      { ticker:'rklb', section:'gov_space', prompt: GOV_RKLB_PROMPT },
      { ticker:'asts', section:'gov_space', prompt: GOV_ASTS_PROMPT },
    ];
    // Filter by scope for faster execution
    const FAST_SECTIONS = ['rec','news','scenarios'];
    const SLOW_SECTIONS = ['sector','gov_space','ctx'];
    // Smart scheduling: check day of week
    const dayOfWeek = new Date().getDay(); // 0=Sun, 6=Sat
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    const isSlowDay = dayOfWeek === 1 || dayOfWeek === 3 || dayOfWeek === 5; // Mon/Wed/Fri
    const isScenariosDay = dayOfWeek === 1 || dayOfWeek === 4; // Mon+Thu only for scenarios

    let calls;
    const ticker = ['rklb','asts','spcx'].includes(scope) ? scope : null;
    if (ticker) {
      if (isWeekend) {
        // Weekend: news only
        calls = allCalls.filter(c => c.ticker === ticker && c.section === 'news');
      } else if (isSlowDay) {
        // Mon/Wed/Fri: rec + news + slow sections (+ scenarios on Mon)
        const sections = ['rec','news','sector','gov_space','ctx'];
        if (isScenariosDay) sections.push('scenarios');
        calls = allCalls.filter(c => c.ticker === ticker && sections.includes(c.section));
      } else {
        // Tue/Thu: rec + news (+ scenarios on Thu)
        const sections = ['rec','news'];
        if (isScenariosDay) sections.push('scenarios');
        calls = allCalls.filter(c => c.ticker === ticker && sections.includes(c.section));
      }
    } else if (scope === 'global') {
      calls = allCalls.filter(c => !c.ticker);
    } else if (scope === 'rklb_news') {
      calls = allCalls.filter(c => c.ticker === 'rklb' && c.section === 'news');
    } else if (scope === 'asts_news') {
      calls = allCalls.filter(c => c.ticker === 'asts' && c.section === 'news');
    } else {
      calls = allCalls;
    }
    console.log(`Running ${calls.length} calls for scope: ${scope}`);

    // Run in parallel batches to stay within timeout
    const batch1 = calls.slice(0, 7);  // first 7
    const batch2 = calls.slice(7);     // remaining 6

    async function runCall(call) {
      try {
        const isLight = ['ctx','gov_space','glossar'].includes(call.section);
        const data = await kiCall(call.prompt, 3, isLight ? 5 : 8, isLight ? 'claude-haiku-4-5' : 'claude-sonnet-4-5');
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

    const duration = ((Date.now() - results.startTime) / 1000).toFixed(1);
    console.log(`Cron done in ${duration}s | OK: ${results.success.join(', ')} | FAIL: ${results.failed.join(', ')}`);

    if (results.failed.length > 0) {
      console.error('CRON FAILURES:', results.failed.join(', '));
      try {
        await fetch(`${SUPABASE_URL}/rest/v1/ki_cache`, {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates',
          },
          body: JSON.stringify({
            ticker: 'system',
            section: 'cron_errors',
            data: { failed: results.failed, scope, duration },
            updated_at: new Date().toISOString()
          })
        });
      } catch(e) { console.error('Error logging failed:', e.message); }
    }

    return res.status(200).json({
      message: 'Sync complete',
      success: results.success.length,
      failed: results.failed,
      duration: duration + 's',
      scope
    });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
