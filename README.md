# Space Stocks Dashboard · RKLB · ASTS · SPCX

Live-Dashboard für Rocket Lab (RKLB), AST SpaceMobile (ASTS) und SpaceX (SPCX, IPO ausstehend) mit KI-Analysen, News und Portfolio-Tracking.

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
- **Aktuelle Lage** — Tagesaktuelle Zusammenfassung
- **Kursziele & Szenarien** — Bull/Base/Bear + 5-Jahres-Forecast
- **Social Media Sentiment** — Reddit, X/Twitter, StockTwits, Telegram, FB/IG (5 Plattformen)
- **Nachrichten** — Top News aus 100+ Quellen
- **Sektor-Kontext** — Konkurrenz, SpaceX, Blue Origin, Starlink, neue Space-IPOs
- **Insider-Trades** — SEC Form 4 Käufe & Verkäufe (RKLB + ASTS)
- **US Gov Aufträge** — Golden Dome, SDA, NASA, Space Force (RKLB) / FAA, FCC, SEC (SPCX)
- **US Regulierung** — FCC, ITU, DoD, NTIA (ASTS)
- **Börsenlexikon** — Fachbegriffe automatisch aktualisiert
- **Historische Empfehlungen** — Verlauf KAUFEN/HALTEN/VERKAUFEN
- **Earnings Calendar** — Nächste Quartalszahlen (automatisch via Cron)

### Portfolio
- Transaktionen erfassen (Käufe & Verkäufe)
- Unrealisierter G/V, Portfolio-Wert
- CHF/USD Toggle mit Live-Wechselkurs
- CSV-Export

### Weitere Features
- **Dark Mode** — in Einstellungen aktivierbar
- **Push-Notifications** — bei neuen KI-Daten (PWA)
- **PWA** — als App auf Homescreen installierbar (iOS + Android)
- **Error Alerting** — Cron-Fehler werden in Supabase geloggt
- **SpaceX Tab** — vorbereitet für IPO, wird mit Live-Kursen erweitert

---

## Technischer Stack

| Komponente | Technologie |
|--|--|
| Frontend | Vanilla HTML/CSS/JS, Chart.js |
| Backend | Vercel Serverless Functions |
| KI (komplex) | Claude Sonnet 4.5 + Web-Search |
| KI (einfach) | Claude Haiku 4.5 (CTX, GOV, Glossar) |
| Datenbank | Supabase (PostgreSQL) |
| Kursdaten | Yahoo Finance API |
| Wechselkurs | open.er-api.com (Fallback: frankfurter.app) |
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
│   └── manifest.json           ← PWA Manifest
├── api/
│   ├── cron.js                 ← KI-Analyse (täglich via Vercel Cron)
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

### 2. Supabase Tabelle erstellen
```sql
CREATE TABLE ki_cache (
  id bigserial PRIMARY KEY,
  ticker text,
  section text NOT NULL,
  data jsonb,
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX ON ki_cache(section, ticker, updated_at DESC);
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

---

## Cron-Jobs

| Job | Zeitplan | Was läuft |
|--|--|--|
| `scope=rklb` | Mo–Fr 13:00 | Rec + News + Scenarios (+ Sector/Gov/CTX/Insider Mo/Mi/Fr) |
| `scope=asts` | Mo–Fr 13:00 | Rec + News + Scenarios (+ Sector/Gov/CTX/Insider Mo/Mi/Fr) |
| `scope=spcx` | Di+Fr 13:00 | News + Sector + Gov + CTX |
| `scope=global` | Mo+Do 13:00 | Börsenlexikon |
| `scope=rklb_news` | Sa+So 13:00 | Nur News |
| `scope=asts_news` | Sa+So 13:00 | Nur News |
| `scope=all_fast` | Manuell (1. Jan) | Rec + News + Scenarios (alle Ticker) |
| `scope=all_slow` | Manuell (1. Jan) | Sector + Gov + CTX + Insider + Glossar |

**Smart-Scheduling:** Der Cron entscheidet täglich selbst welche Sektionen laufen:
- Wochenende → nur News
- Di/Do → Rec + News
- Mo/Mi/Fr → Rec + News + Sector + Gov + CTX + Insider
- Mo/Do → zusätzlich Scenarios + Glossar

**Kosten:** ~$18/Monat (Anthropic API)

---

## Quellenübersicht (100+ Quellen)

**Offizielle:** rocketlabusa.com, ast-science.com, spacex.com, SEC EDGAR (Form 4, S-1)

**Finanzmedien:** Reuters, Bloomberg, CNBC, WSJ, Financial Times, Forbes, Business Insider

**Börsenportale:** Yahoo Finance, Seeking Alpha, TipRanks, Zacks, Finviz, TradingView, Morningstar, Visible Alpha

**Analysten:** Goldman Sachs, Morgan Stanley, JPMorgan, Bank of America, Needham, Canaccord, Deutsche Bank, Wedbush, Piper Sandler

**Space-Investment Research:** Payload Space, Bryce Tech, Space Capital Quarterly, Beyond Earth Ventures, Exo Swan, Gainify.io, CSIS, Secure World Foundation

**Space-Medien:** SpaceNews, NASASpaceFlight, SpaceflightNow, Via Satellite, Aviation Week, Ars Technica Space, Parabolic Arc

**ETF-Flows:** ARKX, UFO (Procure Space), ITA (iShares Aerospace), ROKT (SPDR Space)

**Telecom (ASTS):** FierceWireless, Light Reading, RCR Wireless, GSMA Intelligence, Mobile World Live

**Behörden:** FAA, FCC, ITU, NTIA, NASA, Space Force, SDA, ESA, JAXA, defense.gov

**Konkurrenz-Monitoring:**
- RKLB: Firefly Aerospace, Intuitive Machines (LUNR), Karman Space, Voyager Technologies, Relativity Space
- ASTS: Starlink D2D, Lynk Global, OmniSpace, Eutelsat/OneWeb, Amazon Kuiper D2D

**Social:** Reddit (r/RocketLab, r/ASTS, r/spacex, r/wallstreetbets), X/Twitter, StockTwits, Telegram, Facebook, Instagram, YouTube, Discord

**Insider-Trades:** openinsider.com, SEC EDGAR Form 4, finviz.com/insidertrading

---

## Hinweise
- **Kein Anlageberatung** — KI-Analysen sind informativ, keine professionelle Beratung
- Kursdaten werden alle 15 Sekunden aktualisiert
- KI-Daten täglich um 13:00 Uhr Zürich (11:00 UTC)
- SpaceX Tab wird nach IPO mit Live-Kursen und Insider-Trades erweitert
- Alle Zeitangaben in UTC; Cron läuft auf Vercel Pro mit maxDuration: 300s
