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

Die ursprünglichen Lern-, Trainings-, mehrtägigen Follow-up-, Bonus- und Fingerprinting-Mechanismen werden nicht benötigt. Seit 27.10.2026 verteilt die klinische Zuweisung fünf Fälle als 2/2/1 aus MedQA, NEJM und MediQ. Eine Datenbanksperre und eindeutige Quellfall-Schlüssel verhindern Doppelvergaben über Sitzungen und Studienversionen hinweg. Medizinische Testsitzungen haben einen separaten Reservierungsbereich. Der Patient verwendet fest GPT-6.1 Sol; die klinische Studie verwendet keinen Labor-Agenten. Diagnosen werden erst nach drei erfolgreichen Antworten angenommen.

### Arzt-Patienten-Gespräch und Top-1-Diagnose

Das Frontend sendet `question`; fehlendes `target` wird als `patient` behandelt. Das frühere `auto` wird für offene Clients ebenfalls auf `patient` normalisiert. Neue Laboraufträge und strukturierte Testauswahlen werden abgelehnt. Der Worker bearbeitet auch noch wartende alte Turns mit dem neuen Patienten-Agenten. Es gibt einen Modellaufruf pro Frage und keinen Routing-Aufruf. Bereits abgeschlossene historische Antworten behalten ihre ursprüngliche Zuordnung.

`domain/patient.ts` verwendet das private Faktenpaket aus `domain/facts.ts`: stabile IDs, Status und unveränderter Quelltext. Die Antwort enthält ausschließlich `fact_ids` und `answer`; nur der Antworttext wird angezeigt. Unbekannte/duplizierte IDs und unbelegte Antworten ohne Fakten werden abgelehnt. Die semantische Zuordnung und Regeln wie „nur die erste Frage“ werden durch den Prompt gesteuert und sind keine garantierte Faktenprüfung. Originalbilder werden über separate Bildfakten nach expliziter Anfrage freigegeben; historische Freigaben bleiben erhalten. Referenzdiagnosen und akzeptierte Alternativen stehen nur dem separaten Judge zur Verfügung. [Details](prompts-and-judge.md).

Drei erfolgreiche Antworten sind vor der Diagnoseeingabe erforderlich. `diagnoses` enthält genau eine Position mit nichtleerem `diagnosis` und ganzzahliger `confidence` von 1 bis 7. Der Slider beginnt bei 4; es gibt keine Summenbedingung. Leere oder zusätzliche Diagnosepositionen werden abgelehnt. Enter sendet den Chat; Shift+Enter, IME-Komposition und wiederholte Tastendrücke werden gesondert behandelt. Die Diagnoseeingabe wird damit nicht abgeschickt.

Migration `003_ranked_diagnoses` ergänzt `clinical_cases.diagnoses_json` ohne historische Antworten zu verändern. Die Felder `diagnosis` und `confidence` spiegeln Position 1; maßgeblich ist das vollständige Array. Migration `005_confidence_post_survey` ergänzt `confidence_scale`: frühere Abgaben bleiben als `percent_0_100` unverändert, neue verwenden `likert_1_7`. Historische Einzelantworten behalten `diagnoses: null` und ihre ursprüngliche Rundenanzahl. Migration `006_single_diagnosis` stellt offene Fälle auf `patient-only-top1-likert-v4` um; vorhandene erfolgreiche Fragen zählen mit. In offenen Entwürfen bleiben die erste Diagnose und ihre Confidence erhalten, die vorherige vollständige Liste wird archiviert. Historische Top-3-Abgaben behalten ihr Format und ihre Protokollversion. Die Abschlussbefragung bleibt vor dem letzten Schritt. [Details](confidence-and-survey.md).

Deployments erfolgen API (einschließlich Migrationen) → Worker und Frontend. Die Hauptstudie wird dadurch nicht aktiviert. Ältere Frontends müssen neu geladen werden; das neue Schema lehnt Listen mit mehr als einer Diagnose ab.

`study_timings` speichert kumulative, wiederholbar übermittelbare Zeitabschnitte pro Seitenbesuch und Rundenphase. Sichtbarkeitswechsel trennen sichtbare Bearbeitungszeit von gesamter Aufenthaltszeit. Der Forschungsexport enthält zusätzlich serverseitige LLM-Wartezeiten. Beide Messarten werden getrennt ausgewiesen und nicht zu einer vermeintlich exakten Gesamtzeit addiert.

Die frühere Python-Implementierung liegt unter `legacy/python`. Bestehende SQL-Tabellen bleiben kompatibel; neue Tabellen `task_drafts`, `study_events`, `case_media` und `app_migrations` kommen hinzu. Frühere Konfigurations-Snapshots werden nicht umgeschrieben. Die synthetische Vorschau verwendet `clinician-demo-v2`; die aktuelle medizinische Vorschau verwendet eine getrennte Version `preview-clinical-300-0d303432`. Das [Auswahlprotokoll](case-pool.md) beschreibt die feste Auswahl von 100 Fällen je Quelle.

## Participant information – 03.11.2026

The clinician introduction now describes patient cases and the interview without calling the patient simulated. The long direct-test notice and AI paragraph are removed from the introduction. The debrief explains that the interaction was generated by AI; it is shown before the final analysis decision and again on the completion page. Demo sessions remain excluded from analysis, with their test notice at the end.

New enrollments require two separate declarations: physician or doctor in training (`eligibility_confirmed: true`), and participation/data-use consent (`consent: true`), including publication in anonymized form. The information explicitly states that there is no time limit. The server records both declarations in the enrollment event and saves the exact information and declaration text in the immutable session snapshot under `participant-info-2026-11-03`. All clinician entry routes reject missing eligibility or an outdated consent version; local preview also requires the version. Existing sessions retain their original consent record. The background question also accepts physicians or doctors in training, including zero years of clinical practice.

The canonical copy lives in `packages/shared/src/participant-copy.ts`. This is a change to consent and presentation, not an anonymization pipeline for raw administrator exports. Identified research exports remain protected; publication requires a separately anonymized output.
