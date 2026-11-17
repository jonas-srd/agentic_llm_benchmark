# Confidence und Abschlussbefragung

Stand 03.11.2026. Protokoll `patient-only-top1-three-rounds-v5`, Fragebogenversion `clinician-post-survey-v2`.

## Diagnoseabgabe

Nach drei erfolgreichen Antworten gibt der Arzt genau eine, die aus seiner Sicht wahrscheinlichste Diagnose ein. Sie hat eine ordinale Confidence von 1 bis 7. Der Slider ist mit 1 („Not at all confident“) und 7 („Extremely confident“) verankert und startet bei 4 („Moderately confident“). Der Mittelwert ist die ausdrücklich gewünschte Voreinstellung, keine separat bestätigte Einschätzung. Es gibt keine 100-%-Summe. Werte außerhalb 1–7, Dezimalwerte, fehlende Confidence, eine leere Diagnose und zusätzliche Diagnosepositionen werden abgelehnt.

```json
{"diagnoses":[{"diagnosis":"A","confidence":6}]}
```

Entwürfe können unvollständig sein, enthalten aber genau eine Position. Abgabe, Fallansicht, Export und Judge-Auftrag tragen `confidence_scale: likert_1_7`. Der autonome LLM-Doctor verwendet für seine einzelne Diagnose dieselbe Skala von 1 bis 7. Der Judge selbst sieht keine Confidence und bewertet genau die abgegebene Diagnose (`top1_correct`).

Migration `005_confidence_post_survey` bewahrt abgeschlossene Antworten im Originalformat mit `percent_0_100`. Offene Sitzungen behalten ihren Fortschritt und erhalten die Abschlussbefragung vor dem Debriefing. Ihre Einwilligung wird nicht geändert. Offene Prozententwürfe werden als `legacy_diagnosis_draft_preserved` archiviert; Texte bleiben erhalten, Slider starten auf 4. Bereits abgeschlossene Sitzungen erhalten nachträglich keinen Fragebogen.

Migration `006_single_diagnosis` aktualisiert aktive klinische Sitzungen auf Top 1. Die erste Diagnose und ihr vorhandener Confidence-Wert bleiben in offenen Entwürfen erhalten; der vollständige vorherige Entwurf wird als `ranked_diagnosis_draft_preserved` archiviert. Abgeschlossene Top-3-Antworten, ihre Auswertung und abgeschlossene Sitzungssnapshots bleiben unverändert. Historische Top-3-Aufträge werden weiterhin als solche ausgewertet; neue Einzelabgaben erhalten keinen `top3_correct`-Wert.

Migration `007_three_question_rounds` setzt aktive klinische Sitzungen auf drei Fragen und Protokoll `patient-only-top1-three-rounds-v5`. Vorhandene Antworten und Entwürfe bleiben erhalten. Nach mindestens drei erfolgreichen Antworten kann die Diagnose abgegeben werden; eine bereits laufende ältere vierte oder fünfte Antwort darf noch fertig werden. Neue Fragen nach dem Limit werden abgelehnt. Historische Abgaben behalten anhand ihres Abgabeereignisses die ursprüngliche Protokollversion und Rundenzahl. Alle tatsächlich erfolgten Runden bleiben im Zeitexport enthalten, auch bei einer Umstellung während des Falls.

## Abschlussbefragung v2 und Debrief

Auf Railway führen die früheren Vorschauadressen `/post-survey` und `/debrief` zum Studieneinstieg oder bei laufender Sitzung zum aktuellen Schritt. In der lokalen Entwicklung können beide Seiten weiterhin direkt geprüft werden. Die lokale Fragebogenvorschau hält ihre Eingaben im Arbeitsspeicher.

Die reguläre Befragung folgt auf alle Patient Cases. Jede Seite ist ein eigener serverseitiger Schritt mit eigener Seitenzeit. Erst danach folgen Debrief, Entscheidung über Analyse-Einschluss und Studienabschluss. Die bestehenden drei Fragen je Patient Case, eine Diagnose und deren Confidence 1–7 bleiben unverändert.

Externe Hilfsmittel werden zuerst mit Ja/Nein erfasst. Bei Ja muss mindestens eine Kategorie gewählt werden; mehrere Kategorien sind möglich. Bei Nein werden frühere Auswahlen entfernt und serverseitig abgelehnt. Kommentare bleiben optional.

## Quellen und genauer Wortlaut

Maßgeblich ist die Fragenliste in `packages/shared/src/post-survey.ts`. Die folgende Zuordnung unterscheidet unveränderten Wortlaut, Anpassungen und eigene Ergänzungen. Es handelt sich um Einzelitems, nicht um eine gemeinsam validierte psychometrische Skala; kein Gesamtwert wird gebildet.

### 1. Fachrichtungen, Demografie und KI-Bekanntheit

Solmonovich RL, Kouba I, Lee JY, Demertzis K, Blitz MJ (2025). *Physician awareness of, interest in, and current use of artificial intelligence large language model-based virtual assistants*. PLOS One 20(5):e0320749. [Artikel](https://doi.org/10.1371/journal.pone.0320749), [Originalfragebogen S1](https://journals.plos.org/plosone/article/file?id=10.1371/journal.pone.0320749.s001&type=supplementary). Open Access unter Creative Commons Attribution; Attribution für übernommene und angepasste Items an Solmonovich et al. Der vollständige relevante Anhang wurde einschließlich der Abbildungen geprüft.

| Feld | Originalstelle und Übernahme | Änderung für diese Studie |
| --- | --- | --- |
| `clinical_role` | S1, Q1: Label „Role“ und die drei Optionen Attending/Fellow/Resident physician | Zusätzliche Option für andere ärztliche Rollen bzw. Ärzte in Ausbildung; keine länderübergreifende Berufsdefinition behauptet |
| `specialty` | S1, Q2: Label „Specialty“, alle 34 Originaloptionen einschließlich Other, Originalreihenfolge und Schreibweise | Not yet specialized ergänzt; die Liste ist eine Erhebungskategorisierung, keine offizielle Facharzt-Systematik. Pain medicine stammt aus S1 und fehlt in der Ergebnistabelle, deshalb wurde der Fragebogen zugrunde gelegt |
| `age_group` | S1, Q4: Label „Age“, Originalgruppen 20–30, 31–40, 41–50, >50 | Under 20 und Prefer not to say ergänzt |
| `ai_awareness` | S1, Q6: Fragewortlaut vollständig unverändert; Ja/Nein unverändert | Gemeinsame Seiteninstruktion bezieht die KI-Fragen auf die Zeit vor der Studie. Misst Bekanntheit, nicht Kompetenz oder eine umfassende AI-Literacy-Skala |

Die Quelle berichtet ausdrücklich, dass für ihr Ziel kein etabliertes validiertes Instrument vorlag; die Autoren entwickelten und prüften ihren Fragebogen selbst. Die Publikation ist daher ein nachvollziehbares Vorbild, keine Validierung unseres Instruments.

Die bisherigen zwei Häufigkeitsfragen bleiben erhalten (`ai_use_frequency`, `clinical_ai_use_frequency`). Der Gegenstand wird konsistent mit S1 als AI-powered virtual assistants bezeichnet. Frageform, Vorher-Zeitbezug und Häufigkeitskategorien sind **eigene Ergänzungen**, keine wörtlich übernommenen Frequenzitems der Quelle. Die bisherige Frage `ai_familiarity` wird nicht als Bekanntheit umgedeutet: v2 verwendet den neuen Schlüssel `ai_awareness`; historische Werte bleiben erhalten.

### 2. Schwierigkeit der Patient Cases

Brunyé TT et al. (2024; online 2023). *Do physicians remember cases? Implications for longitudinal designs in medical research and competency assessment*. Research Methods in Medicine & Health Sciences 5(3). [DOI](https://doi.org/10.1177/26320843231199453), Abschnitt Methods → Design and procedures.

Die Formulierung des Items `perceived_difficulty` folgt der dort ausgeschriebenen Frage. Einzige inhaltliche Textänderung: Singularbezug auf einen Fall wird zu **these patient cases**, weil hier nach allen Fällen gefragt wird. Die **sechs** Antwortstufen und Endpunkte Very easy / Very challenging entsprechen der Quelle. Keine Voreinstellung. Das Original stammt aus einer Histopathologie-Aufgabe; die Übertragung auf mehrere dialogbasierte Patient Cases ist eine Anpassung, keine nachgewiesene Gleichwertigkeit der Messung. v1 hatte sieben Stufen und andere Anker; Auswertungen müssen nach Instrumentversion trennen. Die diagnostische Confidence bleibt unabhängig davon bei sieben Stufen.

### 3. Bedienbarkeit

Sauro J, Dumas JS (2009). *Comparison of Three One-Question, Post-Task Usability Questionnaires*. CHI 2009, 1599–1608. [DOI](https://doi.org/10.1145/1518701.1518946). Für den hier verwendeten aktuellen Wortlaut: Sauro J, Lewis J (2022), [Evaluation of Three SEQ Variants](https://measuringu.com/evaluation-of-three-seq-variants/), Experiment 2.

Das Item `usability` folgt dem aktuellen Single-Ease-Question-Wortlaut. Die Passage zum Abschließen einer Aufgabe wird durch **to use this website** ersetzt. Sieben Stufen, Endpunkte Very difficult / Very easy, ohne Voreinstellung. Das ist eine Anpassung von einer einzelnen Aufgabe auf die Nutzung der Studienwebsite; daher keine ungeprüfte Anwendung von SEQ-Normwerten.

### 4. Studienbezogene Ergänzungen

`years_in_practice` (volle klinische Jahre einschließlich Ausbildung), `patient_care_frequency`, `case_familiarity`, die beiden KI-Häufigkeiten, `external_support_used`, `external_support_types` und `feedback` sind eigene deskriptive bzw. Prozessfragen. Sie sind nicht als Originalitems oder validierte Skalen der genannten Veröffentlichungen bezeichnet. Der klinische Erfahrungswert enthält ausdrücklich Ausbildungsjahre; er ist nicht die abweichende S1-Messung „Years out of training“. Freitext und Hilfsmittelkategorien dienen der Nachvollziehbarkeit des Versuchsablaufs.

## Speicherung und Versionswechsel

Alle Antworten werden serverseitig gegen den Sitzungssnapshot geprüft. Pflichtfelder, Auswahlwerte, ganzzahlige Skalen und die Bedingung für Mehrfachauswahl werden geprüft; spätere Seiten können nicht übersprungen werden. Abgaben sind idempotent. Der reguläre Browser speichert Entwürfe pro Sitzung, Instrumentversion und Seite in sessionStorage; alte v1-Entwürfe behalten ihren bisherigen Schlüssel. Bei gesperrtem Browserspeicher bleibt die Eingabe im Arbeitsspeicher möglich.

Migration `008_survey_pages_and_sources` aktualisiert ausschließlich aktive klinische Sitzungen, die die Befragung noch nicht erreicht und keine Befragungsantwort abgegeben haben. Begonnene v1-Befragungen, deren Entwürfe und abgeschlossene Sitzungen bleiben beim bisherigen Instrument. `post-survey-v1.ts` friert die ursprüngliche Fragenliste auch für die historische Migration 005 ein. Der aktuelle Patient Case und die bisherigen Falldaten bleiben unverändert.

Der geschützte Export enthält `post_survey.version`, alle Fragen, zusammengeführte `answers`, `pages` mit Fragen/Antwortdatensatz/Zeiten pro Seite sowie aggregierte Fragebogenzeit. Das bisherige Feld `response` bleibt der Antwortdatensatz der ersten Seite für ältere Verbraucher; für v2 ist `answers` bzw. `pages` zu verwenden. Rohantworten und Zeitsegmente bleiben zusätzlich erhalten. Bei Analyse-Ausschluss gilt dieser auch für die Befragung; Testsitzungen bleiben ausgeschlossen.

Der Debrief erklärt Studienziel, MedQA/NEJM/MediQ als Fallquellen, die simulierte KI-Interaktion, mögliche Antwortfehler, erfasste Daten und Kontaktmöglichkeiten. Er behauptet weder, dass sämtliche Fälle echte Patienten sind, noch eine nicht dokumentierte Ethikfreigabe. Die Information wird im regulären Ablauf nach der Befragung angezeigt.
