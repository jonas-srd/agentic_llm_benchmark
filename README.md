# Clinical Reasoning Study

Studienplattform für Ärzte über Prolific. **Next.js + React im Frontend, TypeScript/Hono als API, separater TypeScript-Agenten-Worker, gemeinsame Zod-Schemas.** Railway nutzt PostgreSQL; lokal funktioniert SQLite. Python ist für den aktuellen Betrieb nicht mehr erforderlich.

Die Struktur orientiert sich am geprüften Repository [Experiment-Next](https://github.com/morit1998/Experiment-Next/tree/3597760cf89662953c81847c170ca6eb6da3aa1c): Workspaces, dynamische Studienphasen, Fortschrittskopf, grüne Stage-Karten, geschützte Sitzungen, Entwurfsspeicherung und Ereignisprotokoll. Einzelheiten und bewusste Abweichungen stehen in [docs/architecture.md](docs/architecture.md).

```text
apps/web/           Next.js App Router, Studienphasen, Cookie und API-Vermittlung
apps/backend/src/   Hono-Routen, Studienlogik, Datenbank, OpenRouter und Worker
packages/shared/    Gemeinsame Schemas, Typen und Phasen-Navigation
scripts/            Lokaler Start und Studienverwaltung
examples/           Importformat und synthetische Pilotkonfigurationen
legacy/python/      Archiv der früheren Python-Anwendung, nicht im Deployment
```

## Studienablauf

1. Information und Einwilligung mit Prolific-Parametern.
2. Ärztlicher Hintergrund und Anleitung.
3. Zufällig zugewiesene Fälle ohne Wiederholung innerhalb der Sitzung.
4. Pro Fall maximal **drei gemeinsame Runden** für Patient und Labor. Eine Patientenfrage oder eine Auswahl von bis zu zehn Tests zählt als eine Runde.
5. Eine endgültige Diagnose mit Konfidenz von 0–100 % ist jederzeit möglich, auch ohne Frage. Nach Runde drei muss sie abgegeben werden. Während einer laufenden Anfrage wird die Antwort abgewartet.
6. Abschließende Wahl über Analyse-Einschluss und Rückkehr zu Prolific. Auch Ausschluss ermöglicht den regulären Abschluss.

**150 Fälle sind der Gesamtpool**, nicht das Pensum pro Arzt. `cases_per_participant` bestimmt die Teilmenge, standardmäßig fünf. Lokal ist der feste Pool `clinical-150-ae4e477e` importiert: **50 MedQA, 50 NEJM, 50 MediQ**, einschließlich 50 NEJM-Originalbildern. Datenquelle ist [MedClarify](https://github.com/AI-in-Management/multiagent-medical-diagnosis-system/tree/b30b35ce56bd0fae3f0d3818e7064025a497532a). Auswahl und Datenaufteilung stehen unter [Falldaten](docs/case-pool.md). Es gibt keine automatische Bewertung freier Diagnosen und keine Auflösung während der Studie.

Jede Sitzung bekommt ein festes, zufälliges Modell für alle Agenten:

| Modell | OpenRouter-ID |
| --- | --- |
| GPT-6.1 Sol | `openai/gpt-6.1-sol` |
| Claude Sonnet 5.5 | `anthropic/claude-sonnet-5.5` |
| Qwen3.8 2.4T A95B | `qwen/qwen3.8-2.4t-a95b` |

Der Workflow `clinician` verwendet den menschlichen Arzt mit Patient und Labor. `agent` betreibt zusätzlich den autonomen Doctor-Agenten für Vergleichsläufe. Modell und Referenzdiagnose bleiben Teilnehmenden verborgen. Zufallszuweisung bedeutet keine garantierten gleichen Gruppen- oder Fallhäufigkeiten. Die IDs wurden im vorherigen Implementierungsschritt am 21.10.2026 im OpenRouter-Katalog geprüft.

## Lokal starten

Voraussetzung: Node.js 24 oder neuer.

```powershell
npm ci
Copy-Item .env.example .env
```

In `.env` getrennte zufällige Werte mit mindestens 32 Zeichen für `ADMIN_API_KEY` und `SESSION_SECRET` eintragen. Einen Wert erzeugen:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

`OPENROUTER_API_KEY` nur als Server-Secret hinterlegen. Ohne ihn funktionieren Oberfläche und frühe Diagnosen, aber keine Agentenantworten. Niemals `NEXT_PUBLIC_` für Secrets verwenden. `.env`, lokale Datenbanken, Exporte unter `data/` und Logs sind von Git ausgeschlossen.

```powershell
npm run dev
```

Dieser Befehl baut die gemeinsamen Typen, aktualisiert die Datenbank und startet Frontend, API und Worker. Frontend: **http://localhost:3000/**. API: **http://localhost:8000/**; deren Startseite leitet zum Frontend weiter. `/health/ready` prüft die Datenbank. Die frühere FastAPI-Seite `/docs` gehört zum archivierten Python-Backend.

Die lokale Startseite bietet eine klar markierte Demo mit echten OpenRouter-Aufrufen. Demo-Endpunkte funktionieren nur in `APP_ENV=development` über eine direkte Loopback-Verbindung. `debug=1` umgeht keine Studienregeln. Lokal verwendet die Anwendung die vorhandene `benchmark.db`; die additive Migration erhält bestehende Tabellen und Daten.

Einzeln starten: `npm run migrate`, `npm run dev:backend`, `npm run dev:worker`, `npm run dev:web`. Gemeinsame Typen zuvor mit `npm run build --workspace @clinical/shared` bauen.

Für PostgreSQL kann alternativ `docker compose up --build` verwendet werden. Docker stellt bewusst keine öffentliche Demo bereit; eine reguläre Teststudie importieren. Die lokale Compose-Webseite verwendet ein HTTP-Cookie für localhost, Railway dagegen ein Secure-Cookie über HTTPS.

## Fallpool und Studienverwaltung

`examples/study.clinician.preview.json` zeigt das Format. Pro Fall: `id`, neutraler `title`, `opening`, `patient_facts`, `labs` (Testname → Originalbefund), `reference_diagnosis`, `source`, `source_id` und optional `media`. Ein Bild verweist mit `asset_id` auf seinen SHA-256-Hash, mit `test` auf eine Laboranforderung und besitzt eine neutrale `caption`. `examples/case.schema.json` beschreibt ein Fallobjekt. Originalbilder werden in der Datenbank gespeichert und erst nach einer erfolgreichen zugehörigen Laboranforderung an die eigene Sitzung ausgeliefert.

Der lokale Pool liegt in `data/clinical-150/study.json`, sein Auswahlprotokoll in `manifest.json`, die Bilder in `media/`. Diese Dateien sind nicht in Git. `PREVIEW_STUDY_FILE=data/clinical-150/study.json` lädt sie in der lokalen Vorschau; ohne diese Variable stehen weiterhin drei synthetische Übungsfälle zur Verfügung. Bestehende Sitzungen behalten ihren bisherigen Fallsnapshot; „Restart preview“ startet die neue Vorschau.

Für eine neue Studienversion das `cases`-Array ersetzen, `cases_per_participant` festlegen und vor dem `final_check` die gewünschten Fragebögen bzw. Informationsschritte konfigurieren. Diagnoseschritte erzeugt der Server. Das Präfix `clinical-` ist reserviert. Eine neue `id`/`version`, finale Einwilligung, `is_demo: false`, echte `prolific_study_id` und `completion_code` setzen.

```powershell
node --env-file=.env scripts/study.mjs import examples/study.clinician.preview.json
# Nach Freigabe der tatsächlichen Studienmaterialien:
node --env-file=.env scripts/study.mjs activate meine-studien-id
node --env-file=.env scripts/study.mjs pause meine-studien-id
node --env-file=.env scripts/study.mjs export meine-studien-id data/export.json
```

Der Import aktiviert keine Studie. Demo-Konfigurationen können nicht aktiviert werden. Der Export überschreibt keine bestehenden Dateien. Importe sind auf 150 Fälle und 8,5 MB pro Admin-Anfrage begrenzt. Das Importwerkzeug lädt benötigte Bilder aus dem benachbarten `media`-Ordner vor der Studienkonfiguration hoch; einzelne Bilder dürfen bis zu 6 MB groß sein.

Teilnehmerlink:

```text
https://<web-domain>/study/intro?study=<studien-id>&PROLIFIC_PID=...&STUDY_ID=...&SESSION_ID=...
```

Die drei Prolific-IDs werden gespeichert; `STUDY_ID` muss zur Konfiguration passen. Dies ist keine Prolific-API-Identitätsprüfung. Rekrutierung, Bezahlung und Freigabe von Submissions bleiben in Prolific. Der Abschlusslink wird erst nach dem gespeicherten finalen Schritt ausgegeben.

## Sitzungen, Entwürfe und Agenten

- Der Browser erhält ein HttpOnly-/SameSite-Cookie für 72 Stunden; in Produktion zusätzlich Secure. Zugriffstoken gelangen nicht in Client-Props oder Browser-Storage. Hono speichert nur ihren HMAC-Hash. Der Browser spricht ausschließlich die eigene Next.js-Origin an; deren Vermittlung prüft POST-Origins und erlaubte Routen.
- Fallentwürfe werden nach 600 ms auf dem Server gespeichert. Separate Entwurfsrevisionen verhindern das Überschreiben durch einen veralteten Tab. Ein Neuladen oder erneutes Öffnen desselben Browsers stellt die Sitzung während der Cookie-Laufzeit wieder her. Nach Cookie-Verlust ist noch eine Wiederherstellung durch die Studienleitung zu ergänzen.
- Alte Python-Sitzungsdaten bleiben erhalten. Frühere Tokens in `sessionStorage` werden wegen des geänderten Frontend-Ports nicht automatisch in das neue Cookie übernommen. Die synthetische Vorschau `clinician-demo-v2` und die medizinische Vorschau `preview-clinical-150-ae4e477e` sind getrennte Studienversionen.
- Reihenfolge, Revisionen, Runden und endgültige Diagnose werden serverseitig geprüft. Identische Wiederholungen einer Submission mit derselben `request_id` erzeugen keine zweite Antwort.
- Persistente Aufträge haben eine 180-Sekunden-Lease. Unterbrochene Modellaufrufe werden nicht automatisch wiederholt. Fehlgeschlagene Patienten-/Laboraufrufe geben ihre Runde genau einmal zurück; höchstens sechs Versuche je Fall verhindern unbegrenzte Wiederholungen.
- Der Doctor erhält nur Eingangsvignette und verfügbare Testnamen, der Patient nur Patientenfakten und Fragen, das Labor nur bestellte Befunde. Referenzdiagnosen und Prolific-IDs gelangen nicht in Modellprompts. In der ärztlichen Oberfläche werden originale Laborwerte angezeigt; die generierte Laborerklärung bleibt im Forschungsexport.
- Provider-Fallback ist deaktiviert. Zurückgemeldetes Modell und vollständiger Antwortabschluss werden geprüft. Gespeichert werden Promptversion, Modell, Anbieter, Generation-ID, Nutzungsdaten und Laufzeit. Prompts können perfekte Faktentreue nicht garantieren.
- Gespeicherte Ereignisse umfassen Einwilligung, Abgaben, Fallbetreten/-verlassen und Sichtbarkeit der Seite. Kein Fingerprinting und keine Erfassung von Tastatureingaben außerhalb der ausdrücklich gespeicherten Fallentwürfe.

## API

| Route | Zweck |
| --- | --- |
| `GET /health/live`, `GET /health/ready` | Prozess und Datenbank |
| `POST /v1/admin/studies` | Inaktive Version importieren; `X-Admin-Key` |
| `POST /v1/admin/media` | Originalbild mit SHA-256-Prüfung importieren; Admin |
| `POST /v1/admin/studies/:id/activate` bzw. `/pause` | Einschreibung steuern; Admin |
| `GET /v1/studies/:id` | Studieninformation; inaktive Versionen nur für Admin |
| `POST /v1/studies/:id/sessions` | Einwilligung und Prolific-Einschreibung |
| `GET /v1/sessions/:id` | Aktueller Stand; Bearer-Sitzungstoken |
| `POST /v1/sessions/:id/steps/:step` | Fragebogen/Informationsschritt/finaler Check |
| `GET /v1/sessions/:id/cases/:step` | Aktueller Fall und Entwurf |
| `GET /v1/sessions/:id/cases/:step/media/:hash` | Bild nach erfolgreicher Anforderung; eigene Sitzung |
| `POST /v1/sessions/:id/cases/:step/questions` | Patientenfrage oder Tests |
| `POST /v1/sessions/:id/cases/:step/diagnosis` | Unveränderliche Diagnose |
| `POST /v1/sessions/:id/cases/:step/draft` | Entwurf mit eigener Revision |
| `POST /v1/sessions/:id/events` | Begrenzte, deduplizierte Ereignisse |
| `POST /v1/sessions/:id/runs`, `GET .../runs/:run` | Autonomer Agentenvergleich |
| `GET /v1/admin/studies/:id/export?limit=50&offset=0` | Forschungsexport einschließlich Modell, Referenz und Ereignissen |
| `GET /v1/admin/models` | Feste Modellliste; Admin |

## Railway

Vier Dienste in einem Projekt: **web + api + worker + PostgreSQL**. Repository-Root für alle Builds beibehalten.

| Dienst | Konfigurationsdatei | Variablen |
| --- | --- | --- |
| web | `/railway.web.json` | `APP_ENV=production`, `BACKEND_URL=http://<api-private-domain>:8000`, `PUBLIC_FRONTEND_URL=https://<web-domain>`, `PORT=3000` |
| api | `/railway.json` | `APP_ENV=production`, `PORT=8000`, `HOST=::`, `DATABASE_URL`, `ADMIN_API_KEY`, `SESSION_SECRET`, `OPENROUTER_API_KEY`, `FRONTEND_URL=https://<web-domain>` |
| worker | `/railway.worker.json` | dieselben Datenbank- und Secret-Werte wie API; kein öffentlicher Port |

`DATABASE_URL` auf die private PostgreSQL-Variable referenzieren. Nur das Web braucht eine öffentliche Domain; administrative API-Aufrufe können über einen gesicherten lokalen Tunnel oder die Railway-Shell erfolgen. Keine Secrets in Buildargumente oder Frontend-Variablen setzen. Die API führt vor dem Start die additive Node-Migration aus; der Worker wartet bei fehlender Migration. Dienste in derselben Region starten und Datenbank-Backups aktivieren. `HOST=::` unterstützt auch IPv6 im [privaten Railway-Netz](https://docs.railway.com/networking/private-networking); die drei Dateien verwenden [Railway Config as Code](https://docs.railway.com/config-as-code/reference).

**Stand 22.10.2026:** Kein bestätigtes Railway-Deployment. Die bestehende App-Verbindung verlangt erneute Authentifizierung. Die Dateien sind vorbereitet, aber nicht als erfolgreich ausgerollt zu verstehen.

## Prüfen

```powershell
npm test
npm run typecheck
npm run build
npm run test:web
```

Tests verwenden simulierte Providerantworten ohne LLM-Kosten. Mit `TEST_DATABASE_URL` läuft dieselbe Backend-Suite zusätzlich gegen PostgreSQL in eigenen temporären Testschemata. GitHub Actions enthält diese Prüfung und beide Docker-Builds. Lokal wurden SQLite-Tests und der Next.js-/Hono-Build ausgeführt; Docker/PostgreSQL stehen auf diesem Rechner derzeit nicht zur Verfügung.

Vor einer echten Rekrutierung fehlen noch die fachliche Freigabe der importierten Fallaufteilung, finale Studien-/Einwilligungstexte, reale Prolific-Konfiguration und das Live-Deployment. Mehrtägige Follow-ups, blockweise Balancierung, automatische Diagnosebewertung, Admin-Weboberfläche, Cookie-Wiederherstellung und Datenlöschungsabläufe sind nicht Bestandteil dieses Umbaus.
