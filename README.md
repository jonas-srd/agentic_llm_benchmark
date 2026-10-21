# Agentic LLM Benchmark

Backend für eine Prolific-Studie mit **Doctor Agent**, **Patient Agent** und **Lab Agent**. API und Worker werden als getrennte Railway-Dienste betrieben, Daten und Aufträge liegen in PostgreSQL. Eine Teilnehmeroberfläche ist der nächste Ausbauschritt; die API ist unter `/docs` dokumentiert.

## Studienmodell

Jede Sitzung erhält serverseitig zufällig **ein Modell für alle drei Agenten**:

| Modell | Feste OpenRouter-ID |
| --- | --- |
| GPT-6.1 Sol | `openai/gpt-6.1-sol` |
| Claude Sonnet 5.5 | `anthropic/claude-sonnet-5.5` |
| Qwen3.8 2.4T A95B | `qwen/qwen3.8-2.4t-a95b` |

Die IDs wurden am 21.10.2026 im OpenRouter-Modellkatalog geprüft. Es gibt keinen Wechsel auf ein anderes Modell bei Fehlern. Die unabhängige Zufallszuweisung ergibt keine garantiert gleichen Gruppengrößen. Das Modell bleibt für Teilnehmende in der API verborgen; Forschende finden es im Export.

Die [Referenzstudie](https://experimentnext.vercel.app/study/test-probe?debug=1&domain=Deduction&condition=Control_Group) dient als Vorbild für Einwilligung, Gruppenzuweisung, sequenzielle Phasen, Fragebögen, Wiederaufnahme und den abschließenden Analyse-Einschluss. Das ist eine eigene Implementierung anhand des sichtbaren Ablaufs; der Quellcode der Referenz lag nicht vor. Beliebige Baseline-, Trainings-, Test- und Follow-up-Schritte können in der Studienkonfiguration angelegt werden. Mehrtägige Terminfreigaben und automatische Einladungen sind noch nicht implementiert.

Der technische Pilot enthält einen **synthetischen Demonstrationsfall und Platzhalter für die Einwilligung**, keine validierten medizinischen Benchmark-Fälle und keinen fertigen Forschungsfragebogen. Er ist standardmäßig inaktiv.

## Ablauf und Daten

1. Studieninformation lesen, Einwilligung anzeigen.
2. `PROLIFIC_PID`, `STUDY_ID`, `SESSION_ID`, Einwilligung und deren Version an die API senden.
3. Die API erstellt Sitzung, Modellzuweisung und einen unveränderlichen Konfigurations-Snapshot. Den einmal ausgegebenen Sitzungstoken clientseitig sicher speichern.
4. Aktuellen Schritt beantworten. Die API prüft Reihenfolge, Datentypen und Revision; `request_id` ermöglicht identische Wiederholungen ohne doppelte Speicherung.
5. Bei einer Simulation einen Auftrag anlegen und Status/Transkript abfragen. Ein Auftrag je Sitzung und Schritt verhindert doppelte Agentenläufe.
6. Im `final_check` frei über den Analyse-Einschluss entscheiden. Sowohl `true` als auch `false` ermöglichen den Abschluss; die Studie speichert diese Wahl getrennt.
7. Erst nach Speicherung des letzten Schritts wird die Prolific-Abschluss-URL ausgegeben.

Die Prolific-URL-Parameter werden gespeichert und gegen die konfigurierte Studie geprüft. **Sie sind keine kryptografische Identitätsprüfung**. Eine Verifikation beim Prolific-API-Server sowie Rekrutierung, Auszahlungen und Freigabe von Submissions sind nicht Teil dieser ersten Integration. Das Frontend muss die von Prolific bereitgestellten URL-Parameter übernehmen; siehe [Prolific-Integration](https://researcher-help.prolific.com/en/articles/445178-what-survey-experimental-software-is-compatible-with-prolific).

Der Doctor kennt anfangs nur die Fall-Eröffnung und verfügbare Testnamen. Der Patient erhält ausschließlich Patientenfakten und die jeweilige Frage. Das Lab erhält ausschließlich bestellte Ergebnisse; originale Laborwerte werden zusammen mit seiner Erklärung weitergegeben. Die Referenzdiagnose wird keinem Agenten übergeben. Promptregeln reduzieren erfundene Aussagen, garantieren aber keine perfekte Faktentreue; Halluzinationen sind ein mögliches Benchmark-Ergebnis. Nur synthetische bzw. entsprechend freigegebene Fälle verwenden.

Gespeichert werden Agentenantworten, angefragtes und zurückgemeldetes Modell, Anbieter, Generation-ID, Token-/Kostenfelder aus OpenRouter, Laufzeit und Promptversion. Versteckte Reasoning-Inhalte werden nicht angefordert oder gespeichert. Prolific-IDs werden nicht in Modellprompts übernommen.

## Lokal starten

Python 3.12 oder neuer installieren. In PowerShell:

```powershell
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.lock
.venv/Scripts/python -m pip install --no-deps -e .
Copy-Item .env.example .env
```

In `.env` eigene, zufällige Werte mit mindestens 32 Zeichen für `ADMIN_API_KEY` und `SESSION_SECRET` setzen. Den OpenRouter-Schlüssel ausschließlich als Secret/Umgebungsvariable hinterlegen. `.env` ist von Git und Docker ausgeschlossen. Schlüssel lassen sich mit `python -c "import secrets; print(secrets.token_urlsafe(48))"` erzeugen.

```powershell
.venv/Scripts/python -m alembic upgrade head
.venv/Scripts/python -m app.server
```

In einem zweiten Terminal:

```powershell
.venv/Scripts/python -m app.worker
```

API: <http://localhost:8000/docs>. SQLite ist ausschließlich für die lokale Entwicklung vorgesehen. Für lokales PostgreSQL: `docker compose up --build` mit ausgefüllter `.env`.

Der inaktive Pilot lässt sich mit `.venv/Scripts/python scripts/seed_preview.py` anlegen. Für Zugriff und Testeinschreibung `X-Admin-Key` mitsenden. Die Beispiel-IDs zum Testen müssen jeweils 24 alphanumerische Zeichen besitzen. Es findet dadurch keine Prolific-Rekrutierung statt.

## API-Vertrag

| Methode / Pfad | Zweck / Authentifizierung |
| --- | --- |
| `GET /health/live`, `GET /health/ready` | Prozess bzw. Datenbankmigration erreichbar |
| `POST /v1/admin/studies` | Unveränderliche Studienversion anlegen; `X-Admin-Key` |
| `POST /v1/admin/studies/{id}/activate` | Einschreibung freigeben; Prolific-ID, Abschlusscode und OpenRouter-Key erforderlich |
| `POST /v1/admin/studies/{id}/pause` | Neue öffentliche Einschreibungen stoppen; laufende Sitzungen bleiben nutzbar |
| `GET /v1/studies/{id}` | Öffentliche Einwilligung und Schrittübersicht; inaktive Studien nur mit Admin-Key |
| `POST /v1/studies/{id}/sessions` | Einschreiben; keine Modell-/Bedingungs-Auswahl durch Client |
| `GET /v1/sessions/{id}` | Aktueller Stand; `Authorization: Bearer <session_token>` |
| `POST /v1/sessions/{id}/steps/{step}` | `{request_id, revision, answers, include_in_analysis}` |
| `POST /v1/sessions/{id}/runs` | Simulation einreihen; wiederholter Aufruf liefert denselben Auftrag |
| `GET /v1/sessions/{id}/runs/{run}` | Status, bisherige Nachrichten und Ergebnis |
| `GET /v1/admin/models` | Festgelegte Modelle; Admin-Key |
| `GET /v1/admin/studies/{id}/export?limit=50&offset=0` | Paginierter Forschungsexport mit Prolific-Zuordnung; Admin-Key |

Ein Aufruf von `/runs` kann `queued`, `running`, `succeeded`, `failed` oder `interrupted` liefern. Fehlercodes sind bereinigt; Provider-Fehlermeldungen und Schlüssel werden nicht ausgegeben. Ausgefallene/abgelaufene Läufe werden **nicht automatisch wiederholt**, weil eine beim Anbieter bereits berechnete Antwort sonst erneut Kosten verursachen könnte. Die Studienleitung muss solche Sitzungen manuell prüfen und gegebenenfalls die Vergütung in Prolific behandeln; ein Reparatur-/Wiederholungs-UI ist noch offen.

## Railway

Vorgesehen: **api + worker + Postgres**, keine öffentlichen Datenbankports. [Railway-Konfiguration](https://docs.railway.com/config-as-code/reference).

1. Projekt `agentic-llm-benchmark` anlegen, PostgreSQL-Vorlage hinzufügen.
2. Zwei Dienste aus diesem Repository und demselben Commit erstellen.
3. API: Konfigurationspfad `/railway.json`; Worker: `/railway.worker.json`.
4. Beide: `APP_ENV=production`, `DATABASE_URL=${{Postgres.DATABASE_URL}}`, sichere `ADMIN_API_KEY` und `SESSION_SECRET` setzen. `OPENROUTER_API_KEY` als Railway-Variable setzen. Keine Schlüssel in GitHub, Docker-Buildargumenten oder Frontend-Variablen.
5. API: `CORS_ORIGINS` als JSON-Liste der tatsächlichen Frontend-URLs konfigurieren; `PUBLIC_BASE_URL` auf die API-URL setzen. Nur dem API-Dienst eine öffentliche Domain geben.
6. API führt vor dem Start `alembic upgrade head` aus. Worker wartet bei fehlender Datenbank/Migration und verarbeitet danach die persistente Warteschlange.
7. Zunächst je eine Instanz verwenden; beide Dienste in dieselbe Region legen, beispielsweise EU. PostgreSQL-Backups im Railway-Projekt konfigurieren.
8. `GET /health/ready` prüfen, danach einen privaten Pilotlauf ausführen. Erst nach genehmigtem Studienmaterial eine neue Version mit echter `prolific_study_id` und `completion_code` anlegen und aktivieren.

**Deployment-Stand 21.10.2026:** Railway-Konto erfolgreich verbunden. Das Anlegen des Projekts wurde vom Railway-Dienst mit `Deploys have been paused temporarily` abgelehnt. Daher besteht noch kein bestätigtes Live-Deployment.

Der Teilnehmer-Link wird später auf die **Frontend-Seite** zeigen, z. B. `/study/intro?PROLIFIC_PID=...&STUDY_ID=...&SESSION_ID=...`. Diese API alleine ist noch kein nutzbarer Prolific-Studienlink.

## Tests und Grenzen

```powershell
.venv/Scripts/python -m pytest -q
```

Automatisierte Tests nutzen simulierte LLM-Antworten und verursachen keine API-Kosten. Sie prüfen den kompletten Studienfluss, getrennte Rolleninformationen, feste Modellzuweisung, Zugriffsschutz, Idempotenz, Parallelität, Kapazitätsgrenzen, Fehlerbehandlung und den von Analyse-Einschluss unabhängigen Abschluss.

GitHub Actions führt dieselben Tests zusätzlich gegen PostgreSQL in isolierten Testschemata aus und prüft Migrationen und Docker-Build. Lokal kann dafür `TEST_DATABASE_URL` auf eine PostgreSQL-Testdatenbank gesetzt werden; die Tests erstellen und entfernen ausschließlich ihre eigenen zufällig benannten `test_...`-Schemata.

`python scripts/check_openrouter.py` führt bewusst drei kleine kostenpflichtige Modellanfragen aus. [OpenRouter-API](https://openrouter.ai/docs/api/reference/overview).

Teilnehmerzahl und maximale Doctor-Turns begrenzen die Zahl an Modellaufrufen: maximal `2 × max_doctor_turns − 1` Aufrufe je Simulation. Das ist kein garantierter Euro-/Dollar-Kostenrahmen. Zusätzlich ein OpenRouter-Schlüsselbudget setzen. Fehlende Teilnahmeprüfung, IP-Rate-Limiting, Token-Wiederherstellung und Datenlöschungsabläufe sind vor einer breiten öffentlichen Rekrutierung projektspezifisch zu ergänzen. Die Konfiguration sollte bis dahin inaktiv bleiben.
