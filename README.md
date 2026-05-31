# Space Stocks Dashboard · RKLB · ASTS · SPCX

Live-Dashboard für Rocket Lab (RKLB), AST SpaceMobile (ASTS) und SpaceX (SPCX, IPO ausstehend) mit KI-Analysen, Finanzdaten und Portfolio-Tracking.

🌐 **Live:** https://space-stocks.vercel.app

---

## Features

### Live-Kursdaten (Yahoo Finance · alle 15s)
- Aktueller Kurs, Tagestief/Tageshoch, Eröffnung
- Handelsvolumen, 52-Wochen-Range, Marktkapitalisierung
- Pre/Post-Market Preise
- Range-Chart mit 7 Zeiträumen (1T · 5T · 1M · 6M · YTD · 1J · 5J)

### KI-Analysen (Claude Sonnet/Haiku · täglich 13:00 Uhr Zürich)
- **Empfehlung** — KAUFEN / HALTEN / VERKAUFEN mit Scores (Fundamentals, Momentum, Risiko, Bewertung)
- **Historische Empfehlungen** — Verlauf der letzten 7 Empfehlungen
- **Kursziele & Szenarien** — Bull/Base/Bear + 5-Jahres-Forecast
- **Social Media Sentiment** — Reddit, X/Twitter, StockTwits, Telegram, FB/IG (5 Plattformen)
- **Nachrichten** — Top News aus 100+ Quellen
- **Sektor-Kontext** — Konkurrenz, SpaceX, Blue Origin, Starlink, neue Space-IPOs
- **Insider-Trades** — SEC Form 4 Käufe & Verkäufe (RKLB + ASTS)
- **US Gov Aufträge** — Golden Dome, SDA, NASA, Space Force (RKLB) / FAA, FCC, SEC (SPCX)
- **US Regulierung** — FCC, ITU, DoD, NTIA (ASTS)
- **Börsenlexikon** — Fachbegriffe automatisch aktualisiert
- **Earnings Calendar** — Nächste Quartalszahlen (automatisch via Cron)

### Investment-KPIs (RKLB + ASTS)
- **KI-KPI-Score 0–100** — Gesamtbewertung mit 6 Kategorien (anklickbar)
- **Drill-Down** — Klick auf Kategorie öffnet Details mit Quelle und Datum
- **SEC-Badge** — zeigt welche Daten direkt von SEC EDGAR kommen
- **KI-Badge** — zeigt welche Daten KI-berechnet sind
- **Interpretation** — 2-3 Sätze Gesamtbild
- **Haupttreiber & Hauptrisiken** — farbige Tags

**RKLB Investment-KPIs:** Wachstum · Backlog · Marge · Liquidität · Risiko · Bewertung

**RKLB Meilenstein-Tracker:** Neutron-Status · Launch Cadence · Defense · Risikoampel

**ASTS Meilenstein-Tracker:** BlueBird Satelliten-Ampel · FCC/ITU · MNO-Partner · Risikoampel

**ASTS Investment-KPIs:** Cash · Umsatz-Ramp · Technologie · Partner · Risiko · Bewertung

### Finanzdaten (SEC EDGAR · direkt)
- Revenue, Bruttomarge, Cash, Debt, Nettoverlust
- Direkt von SEC EDGAR XBRL — keine KI-Interpretation
- Quellenangabe mit Datum bei jedem Datenpunkt

### Portfolio
- Transaktionen erfassen (Käufe & Verkäufe)
- Unrealisierter G/V, Portfolio-Wert
- CHF/USD Toggle mit Live-Wechselkurs
- CSV-Export
- Cloud-Sync via Supabase (Magic Link Login)

### Weitere Features
- **Dark Mode** — in Einstellungen aktivierbar
- **Push-Notifications** — bei neuen KI-Daten (PWA)
- **PWA** — als App auf Homescreen installierbar (iOS + Android)
- **Error Alerting** — Cron-Fehler werden in Supabase geloggt
- **Tooltips** — ? Icon erklärt jeden KPI für Laien
- **SpaceX Tab** — vorbereitet für IPO, wird mit Live-Kursen erweitert

---

## Technischer Stack

| Komponente | Technologie |
|--|--|
| Frontend | Vanilla HTML/CSS/JS, Chart.js |
| Backend | Vercel Serverless Functions |
| KI (komplex) | Claude Sonnet 4.5 + Web-Search |
| KI (einfach) | Claude Haiku 4.5 (CTX, GOV, Glossar) |
| Finanzdaten | SEC EDGAR XBRL API (direkt, kostenlos) |
| Datenbank | Supabase (PostgreSQL) |
| Auth | Supabase Magic Link |
| Kursdaten | Yahoo Finance API |
| Wechselkurs | open.er-api.com |
| Hosting | Vercel Pro |

---

## Projektstruktur

```
space-dashboard/
├── public/
│   ├── index.html              ← Dashboard (Single-Page-App)
│   ├── supabase.js             ← Supabase Client (lokal)
│   ├── chart.min.js            ← Chart.js (lokal)
│   ├── rklb-logo.png           ← Rocket Lab Logo
│   ├── asts-logo.png           ← AST SpaceMobile Logo
│   ├── spacex-logo.svg         ← SpaceX Logo
│   ├── icon-192.png            ← PWA Icon
│   ├── icon-512.png            ← PWA Icon
│   ├── apple-touch-icon.png    ← iOS Homescreen Icon
│   ├── favicon.ico             ← Browser Favicon
│   ├── favicon.png             ← Browser Favicon (HD)
│   └── manifest.json           ← PWA Manifest
├── api/
│   ├── cron.js                 ← KI-Analyse (täglich via Vercel Cron)
│   ├── financials.js           ← SEC EDGAR Finanzdaten
│   ├── quote.js                ← Yahoo Finance Proxy
│   ├── history.js              ← Kursverlauf API
│   ├── ki-data.js              ← Supabase Cache API (inkl. History)
│   ├── sync-status.js          ← Sync Status
│   └── sync-toggle.js          ← Sync Toggle
├── vercel.json                 ← Routing + Cron-Konfiguration
└── package.json                ← Node.js Config (type: module)
```

---

## Setup & Deploy

### 1. Voraussetzungen
- Vercel Account (Pro empfohlen für lange Cron-Laufzeiten)
- Supabase Account (kostenlos)
- Anthropic API Key (console.anthropic.com)

### 2. Supabase Tabellen erstellen
```sql
-- KI Cache
CREATE TABLE ki_cache (
  id bigserial PRIMARY KEY,
  ticker text,
  section text NOT NULL,
  data jsonb,
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX ON ki_cache(section, ticker, updated_at DESC);

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

### 3. Umgebungsvariablen in Vercel
```
ANTHROPIC_API_KEY=sk-ant-...
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_KEY=eyJ...
```

### 4. Deploy
```bash
git push origin main
# Vercel deployed automatisch
```

### 5. Erste Befüllung
Nach erstem Deploy in Vercel:
1. **Cron Jobs → scope=all_fast → Run Now** (Rec, News, Scenarios ~2 Min)
2. **Cron Jobs → scope=all_slow → Run Now** (Sector, Gov, KPI, Milestone ~5 Min)

---

## Cron-Jobs

| Job | Zeitplan | Was läuft |
|--|--|--|
| `scope=rklb` | Mo–Fr 13:00 | Rec + News (+ Sector/Gov/CTX/Insider/KPI Mo/Mi/Fr) |
| `scope=asts` | Mo–Fr 13:00 | Rec + News (+ Sector/Gov/CTX/Insider/Milestone Mo/Mi/Fr) |
| `scope=spcx` | Di+Fr 13:00 | News + Sector + Gov + CTX |
| `scope=global` | Mo+Do 13:00 | Börsenlexikon |
| `scope=rklb_news` | Sa+So 13:00 | Nur News |
| `scope=asts_news` | Sa+So 13:00 | Nur News |
| `scope=all_fast` | Manuell (1. Jan) | Rec + News + Scenarios (alle Ticker) |
| `scope=all_slow` | Manuell (1. Jan) | Sector + Gov + CTX + Insider + KPI + Milestone + Glossar |

**Smart-Scheduling:** Der Cron entscheidet täglich selbst welche Sektionen laufen:
- Wochenende → nur News
- Di/Do → Rec + News
- Mo/Mi/Fr → Rec + News + Sector + Gov + CTX + Insider + KPI/Milestone

**Kosten:** ~$22/Monat (Anthropic API)

---

## KPI-System

### Datenquellen pro Datenpunkt
| Badge | Quelle | Beispiel |
|--|--|--|
| `SEC` | SEC EDGAR XBRL direkt | Revenue, Cash, Debt |
| `KI` | Claude Web-Search | Backlog, Neutron-Status, Scores |

### RKLB Sektionen
| Section | Inhalt |
|--|--|
| `rec` | Empfehlung, Scores, Kursziel, Earnings-Datum |
| `news` | Top 3-5 News mit Sentiment |
| `scenarios` | Bull/Base/Bear Kursziele, 5J-Forecast |
| `sector` | Sektor-Kontext, Konkurrenz |
| `gov_space` | Golden Dome, SDA, NASA, Space Force |
| `ctx` | Firmendaten (Haiku) |
| `insider` | SEC Form 4 Insider-Trades |
| `kpi` | KI-KPI-Score, Backlog, Neutron, Defense |

### ASTS Sektionen
| Section | Inhalt |
|--|--|
| `rec` | Empfehlung, Scores, Kursziel, Earnings-Datum |
| `news` | Top 3-5 News mit Sentiment |
| `scenarios` | Bull/Base/Bear Kursziele, 5J-Forecast |
| `sector` | Sektor-Kontext, D2D-Konkurrenz |
| `gov_space` | FCC, ITU, DoD, NTIA |
| `ctx` | Firmendaten (Haiku) |
| `insider` | SEC Form 4 Insider-Trades |
| `milestone` | KI-KPI-Score, BlueBird-Status, MNOs, Risiken |

---

## Quellenübersicht (100+ Quellen)

**Offizielle:** rocketlabusa.com, ast-science.com, spacex.com, SEC EDGAR (Form 4, 10-Q, S-1)

**Finanzmedien:** Reuters, Bloomberg, CNBC, WSJ, Financial Times, Forbes, Business Insider

**Börsenportale:** Yahoo Finance, Seeking Alpha, TipRanks, Zacks, Finviz, TradingView, Morningstar, Visible Alpha

**Analysten:** Goldman Sachs, Morgan Stanley, JPMorgan, Bank of America, Needham, Canaccord, Deutsche Bank, Wedbush, Piper Sandler

**Space-Investment Research:** Payload Space, Bryce Tech, Space Capital Quarterly, Beyond Earth Ventures, Exo Swan, Gainify.io, CSIS, Secure World Foundation

**Space-Medien:** SpaceNews, NASASpaceFlight, SpaceflightNow, Via Satellite, Aviation Week, Ars Technica Space

**ETF-Flows:** ARKX, UFO (Procure Space), ITA (iShares Aerospace), ROKT (SPDR Space)

**Telecom (ASTS):** FierceWireless, Light Reading, RCR Wireless, GSMA Intelligence

**Behörden:** FAA, FCC, ITU, NTIA, NASA, Space Force, SDA, ESA, JAXA, defense.gov

**Konkurrenz-Monitoring:**
- RKLB: Firefly Aerospace, Intuitive Machines (LUNR), Karman Space, Voyager Technologies, Relativity Space
- ASTS: Starlink D2D, Lynk Global, OmniSpace, Eutelsat/OneWeb, Amazon Kuiper D2D

**Social:** Reddit, X/Twitter, StockTwits, Telegram, Facebook, Instagram, YouTube

**Insider-Trades:** openinsider.com, SEC EDGAR Form 4, finviz.com/insidertrading

---

## Pending (nach SpaceX IPO)
- Insider-Trades für SPCX aktivieren
- Live-Kurse für SPCX Tab
- SPCX Portfolio-Tracking

---

## Hinweise
- **Kein Anlageberatung** — KI-Analysen sind informativ, keine professionelle Beratung
- Kursdaten alle 15 Sekunden aktualisiert
- KI-Daten täglich um 13:00 Uhr Zürich (11:00 UTC)
- SEC EDGAR Finanzdaten laden live bei jedem Seitenaufruf
- Alle Zeitangaben in UTC; Cron läuft auf Vercel Pro mit maxDuration: 300s
