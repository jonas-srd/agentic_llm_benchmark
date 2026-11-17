# Railway-Betrieb

Stand: 27.10.2026. Projekt `clinical-reasoning-study`, Umgebung `production`.

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

Die öffentliche Startseite bietet „Start test session“ ohne Prolific-Link. `PUBLIC_DEMO_STUDY_ID=clinical-150-ae4e477e` am API-Dienst wählt den importierten Pool. Seit 27.10.2026 erhält jede neue Testsitzung fünf Fälle aus allen drei Datensätzen (2/2/1), mit exklusiver Reservierung im separaten Demobereich. Patient und Labor verwenden GPT-6.1 Sol. Erst nach genau drei erfolgreichen Fragerunden pro Fall lässt sich eine Diagnose eingeben. Der Testzugang überspringt die ärztliche Selbstauskunft und beginnt mit den Anweisungen.

Die Migration `002_exclusive_cases_timing` ergänzt exklusive Fallreservierungen und Zeitabschnitte. Vorhandene medizinische Sitzungen werden reserviert; historische Antworten bleiben erhalten. Demo und Live-Pool sind getrennt. Abgebrochene Sitzungen geben keine Fälle frei. Die tatsächlich verfügbare Zahl neuer Sitzungen wird deshalb zusätzlich durch den verbleibenden Fallpool begrenzt (bei 150 freien Fällen höchstens 30 Ärzte mit je fünf Fällen).

Die Tests werden unter einer separaten `demo-`-Studien-ID gespeichert, zählen nicht zur Hauptstudie und haben ab Erstellung dauerhaft `include_in_analysis=false`. Ein manipulierter Abschluss kann das nicht ändern. Es gibt keinen Prolific-Abschlusslink. Nach dem Abschluss kann man eine neue Testsitzung starten; reguläre Prolific-Sitzungen lassen sich darüber nicht zurücksetzen.

`PUBLIC_DEMO_MAX_SESSIONS=100` begrenzt die Zahl erstellter Testsitzungen insgesamt, einschließlich abgebrochener Sitzungen. Die Grenze kann bei Bedarf in `.railway/railway.ts` erhöht werden. Ein leerer Wert für `PUBLIC_DEMO_STUDY_ID` deaktiviert neue Testzugänge; bestehende Sitzungen bleiben fortsetzbar. Lokale `/v1/preview`-Routen bleiben in Produktion gesperrt.

Live geprüft am 23.10.2026: Start ohne Prolific-Parameter, sichere Sitzung, echte Patientenantwort über OpenRouter, fünf Diagnosen, erzwungener Analyse-Ausschluss trotz absichtlich gesetztem `include_in_analysis=true` und Neustart. Ergebnis: `data/direct-access-smoke-results.json`. Die anschließende Datenbankprüfung bestätigte die separate Demo-Studie, alle Tests ausgeschlossen und weiterhin null Einschreibungen in der inaktiven Hauptstudie. API-Deployment: `acfded58-f7af-4417-92f1-a8bd9803912e`; Web-Deployment: `91c270bc-d056-4277-8f89-bfe5197a4151`.

## Protokolländerung vom 27.10.2026

Die früheren Prüfungen vom 23.10.2026 beziehen sich auf das damalige Protokoll mit optionaler früher Diagnose. Seit dem aktuellen Deployment gelten für neue Sitzungen die exklusive Fallvergabe, der Quellenmix und drei verpflichtende Antworten. Bestehende Zuteilungen und Antworten werden nicht nachträglich verändert. Patient und Labor verwenden auch in fortgesetzten Sitzungen GPT-6.1 Sol. Im Hilfemenü kann eine neue Testsitzung begonnen werden.

Erfolgreiche Deployments: API `854caa70-76a5-4c83-8018-d345e95ecb59`, Worker `d7c952f2-6cbe-43ee-978a-0167566ea84a`, Web `da32ac1a-deb4-4ce3-8196-26b490c9271f`. Der öffentliche Healthcheck bestätigt API und Datenbank.

Prüfung mit einem isolierten Schema auf dem produktiven PostgreSQL: 31 gleichzeitige Anmeldungen, 30 vollständige Zuteilungen mit insgesamt 150 verschiedenen Fällen und jeweils 2/2/1 Quellenmix. Eine frühe Diagnose wurde abgelehnt, nach drei erfolgreichen Antworten akzeptiert; Zeitexport geprüft. Das Prüfschema wurde anschließend entfernt. Die Hauptstudie blieb inaktiv und hatte weiterhin null Einschreibungen.

Lokale Browserprüfung bei 320 und 390 Pixel Breite: keine horizontale Überbreite, drei echte GPT-Antworten einschließlich Laborbefunden und Originalbild, sichtbare Warteuhr, Diagnose erst nach Runde drei und Wechsel zum nächsten Fall. Die Datenbankprüfung bestätigte den Quellenmix, das Modell sowie Zeitabschnitte für Einleitung, Selbstauskunft, Anweisungen, Fallseite, einzelne Runden, Antwortansicht und Diagnose. Nachweis: `data/protocol-local-results.json`. Automatisiert: 32 Backend-/Schema-Tests und zehn Web-HTTP-Tests erfolgreich; Produktionsbuild erfolgreich.

## Verständliche Anleitung und optionale Laboranfragen

Historischer Zwischenstand; die nachfolgende Änderung ersetzt diese Testauswahl durch Freitext.

Die Startseite beschreibt den Ablauf kurz; vor dem ersten Fall folgt eine Anleitung mit einem Beispiel für Patientenfragen, optionalen Testanforderungen und der Diagnose nach drei Antworten. Dieselbe Anleitung ist über „?“ jederzeit erreichbar. Die Fallansicht zeigt das Diagnoseformular erst nach der dritten Antwort und verzichtet auf wiederholte Erläuterungen. Die englische Sprache für die internationale Prolific-Studie bleibt erhalten.

„Request tests“ öffnet die Auswahl. Nur „Send test request“ löst einen Laborauftrag aus, anschließend steht die Eingabe wieder auf Patient. Drei Patientenfragen ohne Labor bleiben möglich. Der zusätzliche Regressionstest prüft, dass weder das Öffnen eines Falls noch gespeicherte Testauswahlen, leere Laboranforderungen oder Testbegriffe in einer Patientenfrage einen Laboraufruf auslösen. Validierung: 33 Backend-/Schema-Tests, zehn Web-HTTP-Tests, Typecheck und Produktionsbuild erfolgreich. API-Deployment `aa2334a4-3333-4518-a7ed-426033c6ef38`, Web-Deployment `7af4d75d-2693-47d3-8aa9-fa2bf64ec48e`.

## Freie Fragen an den Labor-Agenten

Historischer Zwischenstand mit getrennten Tabs; die folgende Änderung führt beide Agenten in einem gemeinsamen Chat zusammen.

Der anschließende Stand vom 27.10.2026 ersetzt die Testauswahl durch „Ask lab“ mit Freitext. GPT-6.1 Sol formuliert Antworten aus den objektiven Fallbefunden und dem bisherigen Laborverlauf. Der Worker prüft referenzierte Quellpassagen und Bildgruppen, bevor er die Antwort speichert. Patienten- und Laborentwürfe sind getrennt; die vorhandenen drei Runden, Warteuhr und Zeiterfassung gelten auch für freie Laborfragen. Bereits gespeicherte strukturierte Testaufträge bleiben lesbar.

Validierung: 37 Backend-/Schema-Tests sowie zehn Web-HTTP-Tests, darunter freie Laborfragen über die öffentliche Frontend-API, Rückfragen, wiederholte Requests, fehlende Befunde, ungültige Zitate, Rundenrückgabe und Bildzugriff. Produktionsbuild erfolgreich. Ein separater lokaler Browserlauf mit echten GPT-Antworten bestätigte bei einem NEJM-Fall: fehlende Blutwerte als nicht verfügbar, schriftlicher Bildbefund mit Originalbild auf explizite Frage und korrekte kontextbezogene Rückfrage. Quellzitate, Modell und Bildfreigabe wurden anschließend in der Datenbank überprüft (`data/lab-conversation-results.json`). Mobile Eingabe bei 390 Pixel Breite geprüft.

Erfolgreich veröffentlicht in dieser Reihenfolge: Worker `8619a73f-bd99-48b4-91b0-fdb27b2f867d`, API `38c0bb2b-5c56-4183-bfaa-d5128860ecef`, Web `2a46218e-6549-4d62-9a47-57d956aed745`. Eine separate, von der Auswertung ausgeschlossene Testsitzung auf Railway bestätigte die freie Laborfrage über die öffentliche Frontend-API und einen echten Worker-Aufruf; Diagnose nach einer Antwort weiterhin gesperrt. Nachweis: `data/lab-live-results.json`.

## Gemeinsamer Chat mit automatischer Zuordnung

Historischer Zwischenstand; das nachfolgend beschriebene Patientenprotokoll ersetzt die Zuordnung und den Labor-Agenten.

Das Frontend enthält ein Chatfeld ohne Tabs oder Agentenauswahl. Die API setzt fehlendes `target` auf `auto`. GPT-6.1 Sol entscheidet anhand der Frage und des Gesprächsverlaufs, ob Patient, Labor oder beide antworten. Bei gemischten Nachrichten werden getrennte Teilfragen bearbeitet, beide Antworten gemeinsam angezeigt und genau eine Runde gezählt. Der Patient erhält keine Laborbefunde, das Labor keine Patientenfakten oder Referenzdiagnose. Zuordnungen und Modellaufrufe sind im Export nachvollziehbar. Alte direkte Patienten-/Laboraufrufe bleiben für bereits geöffnete Clients möglich.

Validierung: 42 Backend-/Schema-Tests und zehn Web-HTTP-Tests erfolgreich. Die HTTP-Suite sendet Fragen ohne Agentenangabe. Tests prüfen außerdem gemischte Antworten, Rundenrückgabe bei Teilfehlern, Bilder nach automatischer Zuordnung, idempotente Wiederholungen und ausgelaufene Worker-Leases. Acht echte GPT-Zuordnungen auf Englisch und Deutsch bestanden, darunter verneinte Laboranforderungen, Anamnesefragen über frühere Tests, Rückfragen und gemischte Nachrichten (`data/chat-routing-live-results.json`). Im Browser: ein Chatfeld, keine Tabs, 390 Pixel ohne horizontalen Überlauf, echte Patientenantwort und kombinierte Patienten-/Laborantwort innerhalb einer Runde. Die Datenbankprüfung bestätigte drei Turns und die verwendeten Agenten (`data/unified-chat-local-results.json`).

Erfolgreich veröffentlicht in dieser Reihenfolge: Worker `3f67795f-75f5-41a6-b793-350d4c3edcbb`, API `5c20da03-c684-4a98-a977-0ea5c31f94f6`, Web `242bdcac-84c7-4877-b03d-19dea959a4f7`. Eine separate, dauerhaft von der Auswertung ausgeschlossene Testsitzung auf Railway bestätigte die automatische Laborantwort auf eine Blutwertfrage ohne Agentenangabe; eine Runde gezählt, Diagnose weiterhin gesperrt (`data/unified-chat-live-results.json`). Die veröffentlichte Oberfläche zeigt ein einziges Chatfeld ohne Tabs; öffentlicher Healthcheck erfolgreich. Die Hauptstudie bleibt inaktiv.

## Impressum

Die öffentliche, statische Seite `/impressum` nennt Prof. Dr. Stefan Feuerriegel als Studienkontakt und Verantwortlichen für die Studieninhalte sowie die LMU als Anbieterin. Der gemeinsame Seitenfuß verlinkt sie auf Start-, Studien-, Abschluss- und Fehlerseiten. Der Link öffnet einen neuen Tab, damit laufende Formulare und Fragen erhalten bleiben. Ein Prolific-Link oder eine Sitzung ist für das Impressum nicht erforderlich.

Am 27.10.2026 mit offiziellen LMU-Quellen abgeglichen: [Fakultätsprofil und Institutsanschrift](https://www.som.lmu.de/de/fakultaet/personenuebersicht/kontaktseite/stefan-feuerriegel-840c1071.html), [persönliche E-Mail](https://www.osc.lmu.de/people/people/stefan-feuerriegel.html), [Institutssekretariat](https://www.som.lmu.de/ai/de/institut/index.html) sowie [zentrales LMU-Impressum](https://www.lmu.de/de/footer/impressum/index.html) für Rechtsform, Vertretung, Aufsicht und USt-ID. Verantwortungszuordnung entsprechend der Projektvorgabe; keine inhaltlichen Haftungsausschlüsse übernommen.

Validierung: Web-Produktionsbuild mit TypeScript-Prüfung erfolgreich, lokaler Aufruf ohne Sitzung HTTP 200, genau ein Impressumslink auf der Startseite mit separatem Tab, Desktop- und Mobilansicht bei 390 Pixel Breite ohne horizontalen Überlauf geprüft.

Web-Deployment `b6b82a6e-99d1-4591-9861-8698b010d706` erfolgreich. Öffentliche Impressumsseite ohne Sitzung, Startseitenlink und Healthcheck auf Railway geprüft; veröffentlichte Kontaktangaben zusätzlich im Browser bestätigt. API und Worker blieben beim bestehenden Stand.

## Fünf Runden, Patienten-Agent und Top-3-Diagnosen

Das Protokoll `patient-only-top3-v2` verwendet ausschließlich einen Patienten-Agenten mit GPT-6.1 Sol. Er erhält Anamnese und objektive Befunde und beantwortet auch Fragen zu Laborwerten und Bildern. Der separate Routing-Aufruf entfällt. Enter sendet eine Chatfrage, Shift+Enter fügt einen Zeilenumbruch ein; gehaltene Tasten und IME-Komposition erzeugen keine zusätzlichen Absendungen.

Nach genau fünf erfolgreichen Antworten erscheinen drei Diagnosepositionen. Position 1 ist erforderlich, Positionen 2 und 3 dürfen leer bleiben und müssen dann 0 % enthalten. Auch benannte Diagnosen mit 0 % sind zulässig. Die Summe muss bei der endgültigen Abgabe exakt 100 % ergeben. Entwürfe dürfen unvollständig sein. API und Oberfläche erzwingen dieselben Regeln. Die Zeiterfassung und der Export umfassen alle fünf Runden.

Migration `003_ranked_diagnoses` ergänzt die JSON-Spalte `diagnoses_json`. Historische abgeschlossene Fälle werden nicht nachträglich verändert und bleiben als Einzelantworten mit ihrem bisherigen Rundenlimit erkennbar. Offene Fälle zählen vorhandene Antworten zu den jetzt fünf erforderlichen Runden. Historische Laborantworten bleiben im gespeicherten Verlauf erhalten; neue Antworten stammen vom Patienten.

Validierung: 39 Backend-/Schema-Tests und zehn Web-HTTP-Tests erfolgreich, einschließlich 100-%-Prüfung, fehlender Diagnosen, 0 %, endgültiger und wiederholbarer Speicherung, Migration alter Antworten, Bildberechtigung, Fehlerrückgabe und Exklusivität der 150 Fälle. Produktionsbuild mit TypeScript-Prüfung erfolgreich. Im Browser mit echtem GPT: Enter/Shift+Enter, fortgesetzter Fall von drei auf fünf Runden, 80 % gesperrt, 80/20/0 und 100/0/0 zulässig, benannte Alternative mit 0 %, Entwurf nach Neuladen, endgültige Abgabe, nächster Fall und originale NEJM-Bildfreigabe durch den Patienten. Mobile Ansicht bei 390 Pixel Breite ohne horizontalen Überlauf. Lokaler Datenbanknachweis: `data/patient-only-local-results.json`.

Erfolgreich veröffentlicht: Worker `df07df4b-8d64-4b9f-8970-8f53eb378ac3`, API `fc03dafc-8c57-4029-a46f-e2c68d6a7aeb` und Web `baed3d19-c17f-476c-9b5a-a04f2df11326`. Eine ausgeschlossene öffentliche Testsitzung absolvierte fünf echte Patientenaufrufe auf Railway, frühe Diagnose und sechste Frage wurden abgelehnt, 99 % ebenso. 80/20/0 überstand Entwurf, Neuladen und idempotente endgültige Abgabe (`data/patient-only-live-results.json`). Eine anschließende Prüfung direkt im produktiven PostgreSQL bestätigte die Migration, genau fünf GPT-6.1-Sol-Patientenaufrufe ohne Routing, das gespeicherte vollständige Diagnosearray und die weiterhin inaktive Hauptstudie mit null Einschreibungen. Öffentlicher und lokaler Healthcheck erfolgreich.

## Datensicherung

Railway hat tägliche/wöchentliche Volume-Backups im aktuellen Tarif abgelehnt; sie erfordern einen Pro-Workspace. Es gibt derzeit **keine automatische Datenbanksicherung**. Die lokale Fallpool-Kopie sichert nur die Ausgangsdaten, keine späteren Teilnehmerantworten. Es wurde kein Upgrade gebucht.

## Patienten-Fakten und Judge – 29.10.2026

Die neuen Patienten-/Doctor-Prompts und der Diagnose-Judge sind lokal und in Produktion verfügbar. Migration `004_diagnosis_judge` wurde auf Railway PostgreSQL erfolgreich angewendet. Deployments:

- API: `bf542018-d054-4f8a-87c0-fc93bc6ddcd0` (SUCCESS)
- Worker: `cb81ed76-dcf8-425d-9fb0-c08512afbad1` (SUCCESS)
- Web: `d7685d2e-457e-4a5b-bb75-4e09a4d670e9` (SUCCESS)

Validiert: 45 Backend-/Schema-Prüfungen, 10 Webprüfungen, Typecheck und Produktionsbuild. Alle 150 vorhandenen Fälle lassen sich in private Faktenpakete überführen. Ein isolierter synthetischer Test mit fünf echten Patientenantworten und zwei Judge-Aufrufen prüft unbekannte/absente Angaben, die erste Frage, offene Fragen und angeforderte Blutwerte (`data/fact-prompt-smoke-results.json`).

Der öffentliche Ablauf wurde separat in der ausgeschlossenen Demo-Sitzung `a1b1e0af-7021-4a90-bbc7-020bd6ed8417` mit fünf echten Patientenaufrufen, gesperrter früher/sechster Runde, Top-3-Abgabe, idempotenter Wiederholung und zwei erfolgreichen Judge-Aufrufen geprüft. Die zwei absichtlich inhaltslosen QA-Diagnosen wurden `incorrect`, die leere dritte Position `not_provided` mit `verdict: null`. Datenbankprüfung bestätigt neue Promptversionen, gespeicherte Fakten-IDs, Bewertungen und unverändert inaktive Hauptstudie mit null Einschreibungen. Nachweise: `data/fact-judge-live-results.json`, `data/fact-judge-railway-audit.mjs`. Der technische Test ist keine fachliche Validierung der Judge-Genauigkeit.

Historische abgeschlossene Fälle wurden nicht automatisch nachbewertet. Details zum Datenformat, Zugriff und administrativen Neuversuch stehen in [Prompts und Judge](prompts-and-judge.md).

## Einstieg, Einwilligung und Debriefing – 03.11.2026

Veröffentlicht: API `353500a7-b390-4f83-bf46-0aef94389dc2` und Web `ce7ca0bb-fed0-44c3-9fdd-0055a989d419`, beide SUCCESS. Worker/LLM-Prompts unverändert. Lokale Vorschau auf `http://localhost:3001/`.

56 Tests, Typecheck und Produktionsbuild erfolgreich. Neue Prüfungen decken die getrennte Berufsbestätigung und Datennutzungseinwilligung, fehlende/alte Einwilligungen, Persistenz der Erklärungen, Ärzte in Ausbildung mit null Praxisjahren und das Debriefing vor der Abschlussentscheidung ab. Die öffentliche Einstiegsseite und die vom Backend gelieferte Informationsversion wurden nach dem Deployment geprüft. Hauptstudie weiterhin inaktiv, null Einschreibungen. Bestehende Sitzungen und historische Einwilligungen bleiben erhalten.

## Kürzere Anleitung und Warteanzeige – 03.11.2026

Veröffentlicht: API `c50263ae-3860-4777-b66e-9e8b27a5f811` und Web `34f44ccb-21d5-41d8-aaa5-a6e13cb0bbf5`, beide SUCCESS. Die Anleitung beschreibt den Besuch eines Patienten in der Praxis und die nötigen Rückfragen. Zusätzliche Tastaturerklärungen im Einstieg, die Erklärung zu Runden und der graue Hinweis zu fehlenden Befunden entfallen. Die Oberfläche verwendet „Patient case“, „Dialogue“ und „Ask the patient“; der Fortschritt zählt beantwortete Fragen.

Die sichtbare Warteuhr wurde entfernt. Der Ladekreis rotiert kontinuierlich, bei reduzierter Bewegung langsamer statt vollständig stillzustehen. Zeiterfassung im Hintergrund, fünf verpflichtende Antworten und Diagnoseregeln bleiben unverändert.

Produktionsbuild, Typecheck und zehn Webprüfungen erfolgreich. Eine isolierte lokale Sitzung mit einer Datenbank im Arbeitsspeicher und ohne LLM-Aufrufe bestätigte die Anleitung, Beschriftungen, Enter zum Senden und den dauerhaften Ladezustand ohne Uhr. Zwei zeitlich getrennte Browserbeobachtungen zeigten verschiedene Rotationswinkel bei unverändert laufender Animation; auch mit reduzierter Bewegung. Mobilansicht bei 390 Pixeln ohne horizontalen Überlauf. Öffentlicher Healthcheck und neuer Einstiegstext sowie die Backend-Anleitung nach Veröffentlichung geprüft. Hauptstudie weiterhin inaktiv, null Einschreibungen.

## Siebenstufige Confidence und Abschlussbefragung – 03.11.2026

Veröffentlicht (alle SUCCESS):

- API `f303a112-a0a2-4ff8-bb88-ee94faafef53`
- Worker `0e82887b-6162-4d9d-8166-dece33ab8231`
- Web `5dac945a-359a-4ff8-81cf-4cadc7d8ce1e`

Jede menschliche Diagnose hat eine eigene Confidence von 1–7, voreingestellt auf 4, ohne Prozent-Summe. Leere optionale Diagnosepositionen werden mit `null` gespeichert. Nach allen Fällen folgt die erforderliche Befragung mit zwölf Fragen zu demografischem/klinischem Hintergrund, KI-Erfahrung und Studienerfahrung sowie optionalem Freitext. Neue Sitzungen fragen den klinischen Hintergrund erst am Ende ab. Details und Exportvertrag stehen unter [Confidence und Abschlussbefragung](confidence-and-survey.md).

Migration `005_confidence_post_survey` wurde erfolgreich auf PostgreSQL angewendet. Die Prüfung direkt in Produktion bestätigte 16 frühere abgeschlossene Fälle mit `percent_0_100`, die neue Befragung in allen zwölf aktiven klinischen Testsitzungen sowie die unverändert inaktive Hauptstudie mit null Einschreibungen. Abgeschlossene Sitzungen, Einwilligungen und historische Antworten werden nicht umgeschrieben. Offene alte Prozententwürfe sind vor dem Zurücksetzen der Slider archiviert.

Validierung: 47 Backend-/Schema-Prüfungen, zehn Webprüfungen, Typecheck und Produktionsbuild. Ein isolierter Browserlauf mit synthetischem Fall und deterministischem Worker bestätigte fünf Fragen, Slidergrenzen 1/7 und Schrittweite 1, Standard 4, Entwurf nach Neuladen, Abgabe 6/4/null ohne Summenzwang, Pflichtbefragung, Wiederherstellung der Formularantworten und vollständigen Abschluss. Der Export enthält beide Confidence-Werte, den leeren dritten Rang, die Befragungsantworten, Fragebogenversion und Seitenzeit; auch der Judge-Auftrag wurde erfolgreich verarbeitet (`data/ui-confidence-results.json`). Mobilansicht bei 390 Pixeln ohne horizontalen Überlauf. Die öffentliche Seite kündigt die Befragung an; öffentlicher und lokaler Healthcheck erfolgreich. Keine neuen bezahlten Modellaufrufe oder Forschungsanmeldungen für diese UI-Prüfung.

## Eine Diagnose pro Patient Case – 03.11.2026

Veröffentlicht (alle SUCCESS):

- API `21ba4921-1a31-4114-bc35-f7049197caeb`
- Worker `4ddfeb1b-346e-45e8-9586-9a42d78c61bd`
- Web `1e475e38-7711-49a6-a728-344de332cb62`

Das Protokoll `patient-only-top1-likert-v4` verlangt nach fünf beantworteten Fragen genau eine Diagnose. Confidence bleibt bei 1–7, voreingestellt auf 4. Einstieg, Anleitung, Diagnoseformular und Bestätigung verwenden die Einzahl. Der autonome Doctor-Agent gibt ebenfalls genau eine Diagnose ab; seine separate Prozentskala bleibt bestehen, ohne Summenzwang. Der Judge bewertet neue Einzelantworten mit `top1_correct`; `top3_correct` wird nur noch für historische mehrteilige Antworten erzeugt.

Migration `006_single_diagnosis` wurde auf PostgreSQL erfolgreich angewendet. Alle zwölf aktiven klinischen Testsitzungen verwenden das neue Protokoll. Offene Entwürfe behalten ihre erste Diagnose und deren Confidence; vollständige frühere Entwürfe werden vor der Umstellung als Ereignis archiviert. Die 16 abgeschlossenen historischen Fälle, darunter drei mit mehreren Diagnosepositionen, bleiben unverändert auf ihrer bisherigen Prozentskala. Die Hauptstudie ist weiterhin inaktiv und hat null Einschreibungen.

Validierung: 48 Backend-/Schema-Prüfungen, zehn Webprüfungen, Typecheck und Produktionsbuild erfolgreich. Migrationstests prüfen historische Antworten, Entwurfsarchivierung und wiederholte Anwendung. Ein isolierter Browserlauf ohne externe Modellaufrufe bestätigte fünf Fragen, genau ein Diagnosefeld, Confidence 1–7 mit Standard 4, Wiederherstellung von Diagnose und Confidence 6 nach Neuladen, endgültige Abgabe, Abschlussbefragung und Studienende. Der Export enthält eine Diagnose, einen erfolgreichen Judge-Auftrag mit genau einer Bewertung und die Befragung (`data/ui-top1-results.json`). Mobile Ansicht bei 390 Pixeln ohne horizontalen Überlauf. Die öffentliche Einstiegsseite nennt eine Diagnose pro Patient Case; öffentlicher und lokaler Healthcheck erfolgreich. Tastaturhinweis und zusätzliche Fußzeilentexte bleiben entfernt.

## Drei Fragerunden pro Patient Case – 03.11.2026

Veröffentlicht (alle SUCCESS):

- API `7ac0c97e-e87e-49d5-9494-1fe607d0fb38`
- Worker `712066a6-16ed-429c-a8fd-104d39f1d248`
- Web `06f82d73-8809-4762-898e-dff07fd39f74`

Protokoll `patient-only-top1-three-rounds-v5` erlaubt drei Fragen pro Patient Case. Nach der dritten erfolgreichen Antwort wird die einzelne Diagnose mit Confidence 1–7 freigeschaltet; eine vierte Frage wird auch von der API abgelehnt. Einstieg, Anleitung, Fortschrittsanzeige und Doctor-Prompt verwenden drei Fragen. Der autonome Doctor verwendet `doctor-patient-top1-three-rounds-v4` und erhält nach spätestens drei Patientenantworten einen separaten Diagnoseaufruf.

Migration `007_three_question_rounds` wurde auf PostgreSQL angewendet; alle 14 zum Prüfzeitpunkt aktiven klinischen Testsitzungen verwenden drei Runden und die neue Version. Ältere offene Fälle mit bereits drei oder mehr erfolgreichen Antworten können ihre Diagnose abgeben. Eine schon laufende vierte oder fünfte Antwort darf noch fertig werden. Historische Abgaben behalten ihre Protokollversion und Rundenzahl; alle tatsächlich durchgeführten Runden bleiben im Zeitexport enthalten. Die Hauptstudie ist weiterhin inaktiv mit null Einschreibungen.

Validierung: 49 Backend-/Schema-Prüfungen, zehn Webprüfungen und Produktionsbuild einschließlich TypeScript-Prüfung erfolgreich. Die Tests prüfen die Sperre vor der dritten Antwort, die Ablehnung einer vierten Frage, den vollständigen Abschluss und die wiederholbare Migration mit einer alten laufenden vierten Antwort sowie einem abgeschlossenen Fünf-Runden-Fall. Ein isolierter Browserlauf ohne externe Modellaufrufe bestätigte 0/3 bis 3/3, Diagnosefreigabe erst nach der dritten Antwort und Abgabe mit anschließender Post-Survey. Die öffentliche Website zeigt 0/3; öffentlicher und lokaler Healthcheck erfolgreich. Die lokale Post-Survey-Vorschau bleibt unter Port 3003 erreichbar.

Der erste Worker-Versuch `cb67a7fe-4599-4083-b81a-4f8d095f13db` meldete wiederholt „failed to fetch snapshot“. Ein erneuter Upload desselben geprüften Stands wurde erfolgreich gebaut und veröffentlicht.

## Direkter Post-Survey-Zugang – 03.11.2026

Web-Deployment `d87fd1ca-43f8-42aa-8505-4efa92d2b349` ist SUCCESS. Die öffentliche Route `/post-survey` zeigt den vollständigen Fragebogen ohne Anmeldung oder vorherige Fallbearbeitung. Im Kopfbereich aller Testsitzungen, einschließlich des Einstiegs, führt „Post-survey“ in einem neuen Tab zur Vorschau. Die Vorschau ist ausfüllbar und prüft Pflichtfelder, speichert aber keine Antworten oder Zeitdaten und verändert keine Sitzung. Formularfelder und Fragenliste werden mit der echten Abschlussbefragung geteilt. Die reguläre Studienreihenfolge bleibt bestehen.

Validierung: Produktionsbuild mit TypeScript-Prüfung und elf Webprüfungen erfolgreich. Geprüft wurden anonymer Zugriff ohne neue Sitzung oder Cookie, Zugriff bei laufender Sitzung ohne Fortschrittsänderung sowie der vollständige Studienabschluss. Im Browser wurden der Direktlink im Testmodus, die Pflichtfeldprüfung, alle zwölf Pflichtantworten, die Bestätigung ohne Speicherung, das Zurücksetzen nach Neuladen und 390 Pixel Breite ohne horizontalen Überlauf geprüft. Öffentlicher Direktaufruf ohne Sitzung liefert HTTP 200; die veröffentlichte Seite und der Healthcheck sind bestätigt. API und Worker wurden für diese Änderung nicht neu veröffentlicht.


## Quellenbasierte Post-Survey und Debrief – 03.11.2026

Veröffentlicht, alle SUCCESS:

- API `09e0cbdb-1ec5-40e1-8296-1260622660a2`
- Web `4bb8037b-1ab6-452d-81d5-7dd283ede789`
- Worker `85d46b11-a066-4068-b890-8c55a951ea23`

Fragebogenversion `clinician-post-survey-v2` besteht aus drei erforderlichen Seiten. Externe Hilfsmittel werden mit Ja/Nein und bedingter Mehrfachauswahl erfasst; Kommentare stehen auf derselben separaten letzten Seite. Die Specialty-Liste und demografischen Optionen folgen dem Originalanhang von Solmonovich et al. (2025), ergänzt um ausdrücklich dokumentierte Auffangoptionen. Die KI-Bekanntheitsfrage übernimmt S1 Q6 wörtlich. Fallschwierigkeit folgt Brunyé et al. mit sechs Stufen, Bedienbarkeit dem SEQ-Wortlaut mit sieben Stufen und Website-Bezug. Die Diagnose-Confidence bleibt bei 1–7. Herkunft und jede Anpassung bzw. eigene Ergänzung sind in `confidence-and-survey.md` dokumentiert; keine Behauptung einer validierten Gesamtskala.

Die Vorschau ist unter `/post-survey` öffentlich, der neue Debrief unter `/debrief`. Beide verändern weder Studie noch Antworten. Im regulären Ablauf folgt der Debrief nach allen drei Seiten und vor Studienabschluss. Er erklärt Studienziel, Fallquellen, KI-Interaktion, Daten und Kontakt.

Migration `008_survey_pages_and_sources` wurde in PostgreSQL bestätigt. Zum Prüfzeitpunkt haben 14 aktive Testsitzungen v2; vier bereits abgeschlossene Sitzungen bleiben unverändert ohne nachträgliche Befragung. Die Hauptstudie ist weiterhin inaktiv und hat null Einschreibungen. Bereits erreichte v1-Fragebögen werden von der Migration bewusst nicht verändert.

Validierung: 52 Backend-/Schema-Prüfungen auf SQLite, elf Webprüfungen und vollständiger Produktionsbuild mit TypeScript-Prüfung erfolgreich. Die neue Migration wurde anschließend direkt in Railway/PostgreSQL geprüft. Browserprüfung einer isolierten Testsitzung ohne Modellaufrufe: Entwurfswiederherstellung nach Neuladen, drei gespeicherte Seiten, Mehrfachauswahl, Debrief und Abschluss. Öffentliche Vorschau: Pflichtauswahl nach Ja, mehrere Optionen, Löschen verborgener Auswahl bei Nein und erneute Auswahl bei Rückkehr zu Ja; Navigation zurück erhält andere Antworten. Mobile Formularprüfung bei 390 Pixeln ohne horizontalen Überlauf. Beide veröffentlichten Direktlinks im Browser geprüft. Keine zusätzlichen Forschungsanmeldungen oder bezahlten Modellaufrufe.

## Fallpool vom 11.11.2026

Die öffentliche Demo und die lokale Vorschau verwenden den Pool `clinical-300-0d303432` mit je 100 Fällen aus MedQA, NEJM und MediQ. Die Hauptstudie ist inaktiv. Die öffentliche Startseite meldete 300 Fälle und fünf Fälle pro Teilnahme. Alle 100 NEJM-Bilder wurden nach dem Import in PostgreSQL anhand ihrer SHA-256-Prüfsummen verifiziert. Auswahlregel, Fallzahlen und Manifest sind im [Auswahlprotokoll](case-pool.md) dokumentiert.
