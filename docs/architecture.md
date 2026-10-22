# Architekturabgleich mit Experiment-Next

Referenz: [morit1998/Experiment-Next, Commit 3597760](https://github.com/morit1998/Experiment-Next/tree/3597760cf89662953c81847c170ca6eb6da3aa1c), geprüft am 22.10.2026. Verwendet wurden Struktur und Gestaltungsmuster. Fremde Teilnehmerdaten, Zugangsdaten, institutionelle Logos und das ursprüngliche Versuchsprotokoll wurden nicht übernommen.

| Muster der Referenz | Umsetzung für die klinische Studie |
| --- | --- |
| npm-Workspaces `apps/web`, `apps/backend`, `packages/shared` | Dieselbe Trennung; vollständig TypeScript |
| Next.js App Router mit `/study/[stage]` | Server prüft Sitzung und leitet auf den aktuellen erlaubten Schritt um |
| Gemeinsame Stufen-Definitionen und Komponenten-Zuordnung | Gemeinsame Schema-/Navigationstypen, eigene klinische Phasen in `components/stages` |
| Fixierter Studienkopf, Schrittzähler, grüner Fortschritt | Eigene Clinical-Reasoning-Marke; responsives graues Grundlayout mit weißen Karten |
| HttpOnly-Sitzungscookie | Next.js-Cookie, Hono-Autorisierung über gehashten Bearer-Token |
| Server Actions für Datenzugriff und kleine Hono-Zuweisungs-API | Hono verantwortet die gesamte Studienlogik; Next.js vermittelt nur sichere Browser-Anfragen |
| Serverseitige Entwürfe mit 600-ms-Verzögerung | Frage, Testauswahl, Diagnose und Konfidenz; Revisionen gegen Konflikte zwischen Tabs |
| Append-only Studienereignisse | Einwilligung, Abgaben, Fallwechsel und Seitensichtbarkeit; deduplizierte Client-IDs |
| Mehrteilige Studie mit finalem Analyse-Einschluss | Einwilligung → Hintergrund → Anleitung → Fallteilmenge → finaler Check → Prolific |

Die zusätzliche Worker-Anwendung hält Modellaufrufe aus Web-Requests heraus. API und Worker teilen eine persistente Datenbank. OpenRouter-Aufträge bleiben bei API-Neustarts erhalten; ein unterbrochener, möglicherweise bereits berechneter Aufruf wird nicht still wiederholt. Kein Modellwechsel bei Fehlern.

Im Original dient Hono vor allem der blockweisen Randomisierung, während umfangreiche Datenlogik im Next.js-Projekt liegt. Hier ist die explizit gewünschte Hono-API die zentrale Stelle für Speicherung und Studienregeln. Damit können menschliche Teilnehmer und autonome Doctor-Agenten denselben Datenvertrag nutzen.

Die ursprünglichen Lern-, Trainings-, mehrtägigen Follow-up-, Bonus- und Fingerprinting-Mechanismen werden nicht benötigt. Die klinische Zuweisung ist unabhängig zufällig und bleibt pro Sitzung unveränderlich; eine exakt ausbalancierte Verteilung wäre eine separate Protokollentscheidung.

Die frühere Python-Implementierung liegt unter `legacy/python`. Bestehende SQL-Tabellen bleiben kompatibel; neue Tabellen `task_drafts`, `study_events`, `case_media` und `app_migrations` kommen hinzu. Frühere Konfigurations-Snapshots werden nicht umgeschrieben. Die synthetische Vorschau verwendet `clinician-demo-v2`; die aktuelle medizinische Vorschau verwendet eine getrennte Version `preview-clinical-150-ae4e477e`. Das [Auswahlprotokoll](case-pool.md) beschreibt die feste Auswahl von 50 Fällen je Quelle.
