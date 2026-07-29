# My Stocks Dashboard · RKLB · ASTS · SPCX · OKLO

Live-Dashboard für Rocket Lab (RKLB), AST SpaceMobile (ASTS), SpaceX (SPCX, seit Juni 2026 an der NASDAQ) und Oklo (OKLO) mit KI-Analysen (Claude Opus 5), Finanzdaten und Portfolio-Tracking.

**Harte Datenquellen:** Yahoo Finance (Live-Kurse, Charts, Analysten-Konsens, Earnings-Termine, Short Interest via `/api/analyst`) · SEC EDGAR (XBRL-Finanzdaten via `/api/financials`, Form-4-Insider-Trades via `/api/insider`) · KI-Recherche mit Web-Suche für alles Qualitative.

🌐 **Live:** https://space-stocks.vercel.app

---

## Features

### Live-Kursdaten (Yahoo Finance · alle 15s)
- Aktueller Kurs, Tagestief/Tageshoch, Eröffnung
- Handelsvolumen, 52-Wochen-Range, Marktkapitalisierung
- Pre/Post-Market Preise
- Range-Chart mit 7 Zeiträumen (1T · 5T · 1M · 6M · YTD · 1J · 5J)
- CHF/USD Wechselkurs (live, open.er-api.com)

### KI-Analysen (Claude Sonnet 4.5 · täglich 13:00 Uhr Zürich)
- **Empfehlung** — KAUFEN / HALTEN / VERKAUFEN mit Scores (Fundamentals, Momentum, Risiko, Bewertung)
- **Historische Empfehlungen** — Verlauf der letzten 7 Empfehlungen
- **Kursziele & Szenarien** — Bull/Base/Bear + 5-Jahres-Forecast
- **Experten-Konsens** — Analysten-Kursziel (Ø Bank) mit Kaufen/Halten/Verkaufen-Verteilung
- **Social Media Sentiment** — Reddit, X/Twitter, StockTwits, Telegram, FB/IG (5 Plattformen)
- **Nachrichten** — Top News mit Sentiment (positiv/negativ/neutral)
- **Sektor-Kontext** — Konkurrenz, SpaceX, Blue Origin, Starlink, neue Space-IPOs
- **Insider-Trades** — echte SEC EDGAR Form-4-Daten via `/api/insider` (geparst, keine KI-Schätzung), ergänzt um KI-Kontext (alle vier Titel)
- **Gov & Aufträge** — Golden Dome, SDA, NASA, Space Force (RKLB) / FCC, ITU, DoD, NTIA (ASTS) / FAA, NASA, Space Force, SEC (SPCX) / NRC, DOE, DoD, HALEU (OKLO)
- **Börsenlexikon** — Fachbegriffe automatisch aktualisiert
- **Earnings Calendar** — Nächste Quartalszahlen mit Countdown

### Investment-KPIs (alle vier Titel)
- **KI-KPI-Score 0–100** — Gesamtbewertung mit 6 Kategorien (anklickbar)
- **Drill-Down** — Klick auf Kategorie öffnet Details mit Quelle und Datum
- **SEC-Badge** — zeigt welche Daten direkt von SEC EDGAR kommen
- **KI-Badge** — zeigt welche Daten KI-berechnet sind
- **Interpretation** — 2 Sätze Gesamtbild
- **Haupttreiber & Hauptrisiken** — farbige Tags

**RKLB:** Wachstum · Backlog · Marge · Liquidität · Risiko · Bewertung  
**RKLB Meilenstein-Tracker:** Neutron-Status · Launch Cadence · Defense · Risikoampel

**ASTS:** Cash · Umsatz-Ramp · Technologie · Partner · Risiko · Bewertung  
**ASTS Meilenstein-Tracker:** BlueBird Satelliten-Ampel · FCC/ITU · MNO-Partner · Risikoampel

**SPCX:** Wachstum · Starlink · Starship · Liquidität · Risiko · Bewertung  
**SPCX Meilenstein-Tracker:** Starship-Ampel · Starts & Erfolgsquote · Starlink-Nutzer · Risikoampel

**OKLO:** Cash · Pipeline · Lizenzierung · Technologie · Risiko · Bewertung  
**OKLO Meilenstein-Tracker:** Aurora-INL-Ampel · NRC/DOE · Kunden-Pipeline (GW) · Risikoampel

### Finanzdaten (SEC EDGAR · direkt)
- Revenue, Bruttomarge, Cash, Debt, Nettoverlust
- Direkt von SEC EDGAR XBRL — keine KI-Interpretation
- Quellenangabe mit Datum bei jedem Datenpunkt

### Portfolio
- Transaktionen erfassen (Käufe & Verkäufe mit Datum und Notiz)
- Unrealisierter G/V, Portfolio-Wert, Ø Kaufpreis
- CHF/USD Toggle mit Live-Wechselkurs
- Bull/Bear Szenario-Vorschau
- CSV-Export
- Cloud-Sync via Supabase (Magic Link Login)

### Weitere Features
- **Dark Mode** — Toggle in Einstellungen
- **Push-Notifications** — Toggle in Einstellungen (PWA)
- **PWA** — als App auf Homescreen installierbar (iOS + Android), `viewport-fit=cover`
- **Error Alerting** — Cron-Fehler werden in Supabase geloggt und im Dashboard angezeigt
- **Tooltips** — `?` Icon erklärt jeden KPI verständlich
- **Responsive** — Desktop, Tablet, Mobile optimiert
- **SpaceX Tab** — vorbereitet für IPO, wird mit Live-Kursen erweitert

---

## Technischer Stack

| Komponente | Technologie |
|--|--|
| Frontend | Vanilla HTML/CSS/JS, Chart.js · Single-Page-App |
| Fonts | DM Sans + DM Mono (Google Fonts) |
| Backend | Vercel Serverless Functions (Node.js ESM) |
| KI | Claude Sonnet 4.5 + Web-Search Tool |
| Finanzdaten | SEC EDGAR XBRL API (direkt, kostenlos) |
| Datenbank | Supabase (PostgreSQL) |
| Auth | Supabase Magic Link |
| Kursdaten | Yahoo Finance API (query1 + query2 Fallback) |
| Wechselkurs | open.er-api.com + frankfurter.app Fallback |
| Hosting | Vercel Pro |

---

## Projektstruktur

```
space-dashboard/
├── public/
│   ├── index.html              ← Dashboard (Single-Page-App, ~4000 Zeilen)
│   ├── supabase.js             ← Supabase Client (lokal gebündelt)
│   ├── chart.min.js            ← Chart.js (lokal gebündelt)
│   ├── manifest.json           ← PWA Manifest
│   ├── sw.js                   ← Service Worker (Cache-Clearing)
│   ├── rklb-logo.png / asts-logo.png / spacex-logo.svg
│   ├── icon-192.png / icon-512.png / apple-touch-icon.png
│   └── favicon.ico / favicon.png
├── api/
│   ├── cron.js                 ← KI-Analyse (Cron, parallele Batches à 3)
│   ├── financials.js           ← SEC EDGAR Finanzdaten
│   ├── quote.js                ← Yahoo Finance Proxy (inkl. 1J History)
│   ├── history.js              ← Range-Chart API (query1+query2 Fallback)
│   ├── ki-data.js              ← Supabase Cache-Leser
│   ├── sync-status.js          ← Sync Status
│   └── sync-toggle.js          ← Sync Toggle
├── vercel.json                 ← Routing + Cron-Konfiguration
└── package.json                ← Node.js Config (type: module)
```

---

## Setup & Deploy

### 1. Voraussetzungen
- Vercel Account (Pro empfohlen für 300s Cron-Laufzeit)
- Supabase Account (kostenlos reicht)
- Anthropic API Key (console.anthropic.com · Stufe 2+)

### 2. Supabase Tabellen erstellen

```sql
-- KI Cache (Upsert via unique constraint)
CREATE TABLE ki_cache (
  id bigserial PRIMARY KEY,
  ticker text NOT NULL DEFAULT 'global',
  section text NOT NULL,
  data jsonb,
  updated_at timestamptz DEFAULT now(),
  UNIQUE (ticker, section)
);
CREATE INDEX ON ki_cache(ticker, section, updated_at DESC);

-- Portfolio Transaktionen
CREATE TABLE transactions (
  id bigserial PRIMARY KEY,
  user_id uuid REFERENCES auth.users,
  ticker text,
  type text,
  qty numeric,
  price numeric,
  date date,
  note text,
  created_at timestamptz DEFAULT now()
);
```

> **Wichtig:** Der `UNIQUE (ticker, section)` Constraint ist zwingend — der Cron nutzt Supabase Upsert mit `resolution=merge-duplicates`.

### 3. Supabase RLS aktivieren

```sql
-- Transactions: nur eigene Daten
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own data" ON transactions
  USING (auth.uid() = user_id);

-- ki_cache: öffentlich lesbar
ALTER TABLE ki_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public read" ON ki_cache FOR SELECT USING (true);
```

### 4. Umgebungsvariablen in Vercel

```
ANTHROPIC_API_KEY=sk-ant-...
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_ANON_KEY=eyJ...          ← für ki-data.js (public read)
SUPABASE_SERVICE_KEY=eyJ...       ← für cron.js (write)
```

### 5. Deploy

```bash
git push origin main
# Vercel deployed automatisch via GitHub Integration
```

### 6. Erste Datenbefüllung

Nach erstem Deploy in Vercel Dashboard unter **Deployments → Functions → Cron Jobs**:

1. `scope=all_slow` → Run Now (Sector, Gov, KPI, Milestone, Insider, Glossar · ~2 Min)
2. `scope=all_fast` → Run Now (Rec, News, Scenarios · ~1 Min)

---

## Cron-Jobs

| Job | Zeitplan (UTC) | Inhalt |
|--|--|--|
| `scope=rklb` | Mo–Fr 11:00 | RKLB: alle Sektionen |
| `scope=asts` | Mo–Fr 11:00 | ASTS: alle Sektionen |
| `scope=spcx` | Di+Fr 11:00 | SpaceX: News, Sector, Gov, CTX |
| `scope=global` | Mo+Do 11:00 | Börsenlexikon |
| `scope=rklb_news` | Sa+So 11:00 | Nur RKLB News/Rec/Scenarios |
| `scope=asts_news` | Sa+So 11:00 | Nur ASTS News/Rec/Scenarios |
| `scope=all_fast` | Manuell | Rec + News + Scenarios (alle Ticker) |
| `scope=all_slow` | Manuell | Sector + Gov + CTX + Insider + KPI + Milestone + Glossar |

**Laufzeit:** ~120s (parallele Batches à 3 Calls), Limit: 300s  
**Kosten:** ~$15–25/Monat (Anthropic API, abhängig von Testfrequenz)  
**Rate Limit:** Stufe 2 = tägliches Limit; bei viel manuellem Testen → Stufe 3 empfohlen

---

## Cron-Architektur

```
kiCall(prompt)
  ├── fetch Anthropic API (max_tokens: 2048, web_search tool)
  ├── Strip markdown code fences
  ├── Extract JSON (first { to last })
  ├── Strategy 1: JSON.parse()
  ├── Strategy 2: sanitizeJson() → entfernt cite-Tags, fixt Newlines, trailing commas
  ├── Strategy 3: flatten newlines
  ├── Strategy 4: salvageJson() → extrahiert bekannte Strukturen (articles/cards/trades)
  └── Error → retry (max 3×, 15s Pause)

saveToCache(section, ticker, data)
  └── Supabase POST + Prefer: resolution=merge-duplicates (Upsert)
```

---

## KPI-Sektionen

### RKLB
| Section | Inhalt |
|--|--|
| `rec` | Empfehlung, Scores, Kursziel, Analysten |
| `news` | Top News mit Sentiment |
| `scenarios` | Bull/Base/Bear, 5J-Forecast, Sentiment |
| `sector` | Sektor-Kontext, 6 Karten |
| `gov_space` | Golden Dome, SDA, NASA, Space Force |
| `ctx` | Firmenbeschreibung, Tags, Stats |
| `insider` | SEC Form 4 Trades, Signal |
| `kpi` | Score, Backlog, Marge, Neutron, Defense |

### ASTS
| Section | Inhalt |
|--|--|
| `rec` | Empfehlung, Scores, Kursziel, Analysten |
| `news` | Top News mit Sentiment |
| `scenarios` | Bull/Base/Bear, 5J-Forecast, Sentiment |
| `sector` | Sektor-Kontext, 6 Karten |
| `gov_space` | FCC, ITU, DoD, NTIA |
| `ctx` | Firmenbeschreibung, Tags, Stats |
| `insider` | SEC Form 4 Trades, Signal |
| `milestone` | Score, BlueBird-Status, MNOs, Risiken |

### SPCX / Global
| Section | Inhalt |
|--|--|
| `spcx/news` | SpaceX News |
| `spcx/sector` | Marktposition, IPO-Status |
| `spcx/gov_space` | FAA, NASA, Space Force, SEC |
| `spcx/ctx` | Firmendaten |
| `global/glossar` | Börsenlexikon, Golden Dome Update |

---

## Design-System

### Typografie
| Stufe | Grösse | Verwendung |
|--|--|--|
| xs | 11px | Icons, Fine Print |
| sm | 12px | Timestamps, Tags, Meta |
| md | 13px | Sekundärer Content, Labels |
| base | 14px | Primärer UI-Text |
| lg | 15px | Werte, Inputs |
| xl | 16px | Prominente Werte |
| 2xl | 17px | Card-Titel |

### CSS-Variablen
```css
--font-sans: 'DM Sans', system-ui, sans-serif;
--font-mono: 'DM Mono', 'Fira Mono', monospace;
--text-xs: 11px; --text-sm: 12px; --text-md: 13px;
--text-base: 14px; --text-lg: 15px; --text-xl: 16px; --text-2xl: 17px;
```

---

## Pending (nach SpaceX IPO)
- Live-Kurse für SPCX Tab
- SPCX Insider-Trades aktivieren
- SPCX Portfolio-Tracking

---

## Hinweise
- **Keine Anlageberatung** — KI-Analysen sind informativ, keine professionelle Beratung
- Kursdaten alle 15 Sekunden via Yahoo Finance (query1 + query2 Fallback)
- KI-Daten täglich um 13:00 Uhr Zürich (11:00 UTC)
- SEC EDGAR Finanzdaten laden live bei jedem Seitenaufruf
- Supabase Anon Key im Frontend ist öffentlich — RLS schützt die Daten
- Alle Zeiten in UTC; Cron auf Vercel Pro mit `maxDuration: 300s`

---

## Eigene Titel hinzufügen

Über den **`+`-Button** in der Tab-Leiste lassen sich beliebige Aktien selbst ins Dashboard aufnehmen:

1. Börsenkürzel eingeben (z.B. `LUNR`, `RDW`, `FLY`) — wird sofort gegen Yahoo Finance validiert
2. Firmenname optional (wird sonst automatisch übernommen)
3. SEC CIK-Nummer optional — nur nötig für Bilanzdaten und Insider-Trades aus SEC EDGAR
   (zu finden über EDGAR Company Search auf sec.gov)

Sofort verfügbar: Live-Kurs, alle Chart-Zeiträume, Tagesprognose (ATR/RSI/Momentum), Portfolio-Tracking,
Analysten-Konsens, Earnings-Termin und Short Interest. Die KI-Analysen (Empfehlung, News, Szenarien,
Sektor, KPIs) erscheinen nach dem nächsten Cron-Lauf (`scope=custom`, werktags 11:25 UTC) oder sofort
über den manuellen Aktualisieren-Button.

Gespeichert wird im Browser (localStorage). Für geräteübergreifende Synchronisation optional diese
Tabelle in Supabase anlegen:

```sql
create table user_tickers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  ticker text not null,
  symbol text not null,
  name text,
  cik text,
  color text,
  created_at timestamptz default now()
);
alter table user_tickers enable row level security;
create policy "own tickers" on user_tickers
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
```

Ohne diese Tabelle funktioniert alles weiterhin — die Titel bleiben dann nur lokal im jeweiligen Browser.
