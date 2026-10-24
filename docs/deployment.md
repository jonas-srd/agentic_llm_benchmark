# Railway-Betrieb

Stand: 23.10.2026. Projekt `clinical-reasoning-study`, Umgebung `production`.

- Projekt: https://railway.com/project/1f9973c7-d6af-4a11-9293-208d0830e266
- Webseite: https://web-production-9fa3b.up.railway.app
- Erreichbarkeit mit Datenbankprüfung: https://web-production-9fa3b.up.railway.app/api/health
- Projekt-ID: `1f9973c7-d6af-4a11-9293-208d0830e266`
- Umgebungs-ID: `a9f669fa-ba93-47f4-b0ea-6adc80a8fbb7`

| Dienst | Dienst-ID | Betrieb |
| --- | --- | --- |
| web | `4da8fb02-4b49-49ea-9173-7bffcca4cbb4` | Next.js, öffentliches HTTPS, Port 3000 |
| api | `5ef29856-2696-49ae-aac8-f918ce3d72f7` | Hono, privates Netzwerk, Port 8000 |
| worker | `5640734b-d3a1-4730-8047-4e6cee000692` | persistente Agentenaufträge, kein öffentlicher Port |
| Postgres | `37e1709c-e677-4226-8563-44918e796066` | PostgreSQL 18, privates Netzwerk, 5-GB-Volume |

Alle Dienste laufen in `sfo`. Das bestehende Volume `postgres-volume` wird in der IaC-Datei erhalten. Die API führt vor jedem Deployment die additive Migration aus. Das Frontend prüft bei seinem Healthcheck auch API und Datenbank.

## Änderungen veröffentlichen

Die offizielle Railway CLI ist lokal für diesen Workspace und dieses Projekt autorisiert. Der Connector in Codex war beim Deployment weiterhin nicht authentifiziert. Die Dienste erhalten ihre Quellen durch CLI-Uploads; GitHub-Autodeploys sind nicht eingerichtet.

```powershell
railway link --project 1f9973c7-d6af-4a11-9293-208d0830e266 --environment production
railway config plan
railway config apply --yes
railway up --service api --detach
railway up --service worker --detach
railway up --service web --detach
railway service list --json
```

Nur betroffene Dienste neu veröffentlichen. Upload-Abschluss bedeutet noch nicht erfolgreichen Start; Deployment-Status und `/api/health` prüfen. Die nativen CLI-Binärdateien müssen unter Windows im `PATH` liegen; das TypeScript-SDK prüft die Version mit `railway --version`.

Admin- und Sitzungsschlüssel wurden für Produktion neu erzeugt und ausschließlich in Railway sowie der Git-ignorierten lokalen Datei `data/railway-production-secrets.json` gespeichert. Der OpenRouter-Schlüssel stammt aus der lokalen `.env`. Keine Schlüssel in Logs, Frontend-Variablen oder Quellcode kopieren. Die Railway-SSH-Verbindung nutzt einen eigens angelegten lokalen Schlüssel `~/.ssh/id_ed25519_railway_clinical`.

## Datenimport und Prüfung

Der feste Pool `clinical-150-ae4e477e` wurde über die authentifizierte private API importiert: 50 MedQA, 50 NEJM, 50 MediQ und 50 Originalbilder. Der Import lief per Railway-SSH innerhalb des API-Containers. Dateien wurden als Archiv übertragen, weil der parallele Einzeldatei-Upload in ein Timeout lief. Alle 50 Bild-Hashes wurden nach dem Import in PostgreSQL erneut geprüft.

Bei erneuten Imports `scripts/study.mjs` innerhalb des API-Containers ausführen. Das Skript muss dort unterhalb von `/workspace` liegen, damit es das gemeinsame Paket auflösen kann. `BACKEND_URL=http://127.0.0.1:8000`; `ADMIN_API_KEY` ist bereits als Laufzeitvariable vorhanden. Studie und Bilder bleiben außerhalb der Docker-Images und des Git-Repositories. Das Importwerkzeug überschreibt keine bestehende Studien-ID und aktiviert keine Studie.

Die Liveprüfung erzeugte separate Studien mit dem Präfix `railway-qa-`, `is_demo: true` und deaktivierter Einschreibung. Drei vollständige Sitzungen verwendeten je ein anderes Modell und endeten mit `include_in_analysis: false`. Ein vorzeitig abgebrochener QA-Lauf wurde ebenfalls vom Analyse-Einschluss ausgeschlossen. Diese Sitzungen gehören nicht zur eigentlichen Studie. Lokale Nachweise: `data/railway-smoke-results.json`, `data/railway-deployment-audit.json`.

## Vor dem Teilnehmerstart

Die Hauptstudie bleibt inaktiv. Prolific-ID, Abschlusscode und freigegebene Studienmaterialien müssen in einer passenden Studienversion hinterlegt werden.

## Direkter Testzugang

Die öffentliche Startseite bietet „Start test session“ ohne Prolific-Link. `PUBLIC_DEMO_STUDY_ID=clinical-150-ae4e477e` am API-Dienst wählt den importierten Pool. Jede Testsitzung erhält fünf zufällige Fälle und ein zufälliges Modell für alle Agenten, mit maximal drei Fragerunden pro Fall. Der Testzugang überspringt die ärztliche Selbstauskunft und beginnt mit den Anweisungen.

Die Tests werden unter einer separaten `demo-`-Studien-ID gespeichert, zählen nicht zur Hauptstudie und haben ab Erstellung dauerhaft `include_in_analysis=false`. Ein manipulierter Abschluss kann das nicht ändern. Es gibt keinen Prolific-Abschlusslink. Nach dem Abschluss kann man eine neue Testsitzung starten; reguläre Prolific-Sitzungen lassen sich darüber nicht zurücksetzen.

`PUBLIC_DEMO_MAX_SESSIONS=100` begrenzt die Zahl erstellter Testsitzungen insgesamt, einschließlich abgebrochener Sitzungen. Die Grenze kann bei Bedarf in `.railway/railway.ts` erhöht werden. Ein leerer Wert für `PUBLIC_DEMO_STUDY_ID` deaktiviert neue Testzugänge; bestehende Sitzungen bleiben fortsetzbar. Lokale `/v1/preview`-Routen bleiben in Produktion gesperrt.

Live geprüft am 23.10.2026: Start ohne Prolific-Parameter, sichere Sitzung, echte Patientenantwort über OpenRouter, fünf Diagnosen, erzwungener Analyse-Ausschluss trotz absichtlich gesetztem `include_in_analysis=true` und Neustart. Ergebnis: `data/direct-access-smoke-results.json`. Die anschließende Datenbankprüfung bestätigte die separate Demo-Studie, alle Tests ausgeschlossen und weiterhin null Einschreibungen in der inaktiven Hauptstudie. API-Deployment: `acfded58-f7af-4417-92f1-a8bd9803912e`; Web-Deployment: `91c270bc-d056-4277-8f89-bfe5197a4151`.

## Datensicherung

Railway hat tägliche/wöchentliche Volume-Backups im aktuellen Tarif abgelehnt; sie erfordern einen Pro-Workspace. Es gibt derzeit **keine automatische Datenbanksicherung**. Die lokale Fallpool-Kopie sichert nur die Ausgangsdaten, keine späteren Teilnehmerantworten. Es wurde kein Upgrade gebucht.
