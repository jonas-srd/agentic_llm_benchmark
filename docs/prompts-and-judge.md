# Prompts und Diagnosebewertung

Stand 13.11.2026. Die Prompts für Patient, Interviewer und Diagnosebewertung stehen in `domain/patient.ts`, `domain/agents.ts` und `domain/judge.ts`.

## Patient: clinical-patient-fact-ids-v4

Eine Frage pro Nachricht, nur die erste bei mehreren Fragen. Ein bis drei Sätze in Alltagssprache; bei offenen Fragen höchstens zwei thematisch passende Fakten. Fehlende Information: „I'm not sure.“. Explizit negative Befunde bleiben negativ; unbekannt wird niemals als normal oder nein ausgegeben. Untersuchung, Tests und Bilder nur bei ausdrücklicher Nachfrage. Keine Diagnose, Interpretation oder ungefragten Fakten.

Seit Version 4 darf der Patient auf eine gezielte Frage sichtbare Veränderungen aus allen Abschnitten der Fallakte beschreiben. Bei einer teilweise beantwortbaren Frage benennt er die Unsicherheit und die einschlägige Beobachtung. Ein zeitlicher Zusammenhang kann so beschrieben werden, auch wenn die Ursache unbekannt ist. Laborwerte, Bilder und Befunde, die eine ärztliche Untersuchung erfordern, werden weiterhin erst auf Anfrage freigegeben. Der Export weist die verwendete Patientenversion pro Antwort aus.

Die Umstellung erfolgte während der Datenerhebung. Version 4 wurde anhand der 17 zuvor mit „I'm not sure.“ beantworteten Fragen aus den ersten beiden zur Auswertung freigegebenen Teilnahmen geprüft. Diese erneuten Modellaufrufe dienten der Funktionsprüfung und sind keine zusätzlichen Studienbeobachtungen.

Das private Record enthält `{id, status, text}`. Bestehende Fälle werden deterministisch zeilen- und satzweise aus `opening`, `patient_facts` und `labs` abgeleitet. Feldnamen, Dezimalzahlen, Einheiten und explizite Negationen bleiben im Quellwortlaut. `recorded` bedeutet dokumentierter Quelltext und ist keine positive Symptomklassifikation. Dieser Adapter macht keine semantische Zerlegung zusammengesetzter Quellsätze. Für fachlich kuratierte atomare Fakten kann ein Fall optional `fact_pack` mit `present`, `absent`, `unknown` oder `recorded` importieren. Ein vorhandenes Paket ersetzt die automatische Ableitung. Untersuchung/Testart sollte im Text stehen. Referenzdiagnose und akzeptierte Alternativen werden nie in den Record übernommen; kuratierte Pakete müssen diese Trennung ebenfalls einhalten.

Rückgabe exakt `{"fact_ids":[...],"answer":"..."}`. Nur `answer` geht an den Arzt. Unbekannte oder doppelte IDs sowie unbelegte Antworten mit leerer ID-Liste werden als fehlerhafter Aufruf behandelt; die Runde wird zurückgegeben. Eine unbekannte Antwort ohne IDs muss exakt „I'm not sure.“ sein. Separate Bildfakten erlauben die Freigabe der vorhandenen Originaldateien. Modell bekommt keine Bildpixel. Alte Bildfreigaben bleiben gültig.

Exportiert werden ausgewählte IDs, zugehörige Fakten, `source-facts-v1`, SHA-256 des Pakets, Promptversion, Modell, Anbieter, Generation-ID, Nutzung und Laufzeit. Die ID-Prüfung bestätigt die Herkunft, nicht automatisch die semantische Richtigkeit oder Vollständigkeit der LLM-Antwort.

## Doctor: doctor-patient-top1-three-rounds-vision-v5

Für Prolific gilt weiterhin: genau drei erfolgreiche Antworten, danach Diagnoseeingabe. Die Anleitung erklärt die Beschränkung auf eine Frage und die explizite Anforderung von Befunden.

Der autonome Interviewer stellt drei einzelne Fragen. Nach der dritten Patientenantwort folgt ein eigener Aufruf für die Diagnose. Beide Gruppen sehen die Eingangsvignette, die Antworten auf ihre Fragen und die dazu freigegebenen Originalbilder mit Bildunterschrift. Die Bilder bleiben im Gesprächsverlauf verfügbar. Die Fragen verwenden das Format `{"question":"..."}`. Beispiel einer Schlussantwort:

```json
{"diagnoses":[{"diagnosis":"A","confidence":6}]}
```

Ärzte und LLMs geben eine Diagnose mit ganzzahliger Confidence von 1 bis 7 ab (`likert_1_7`). Der Export speichert bei neuen Modellläufen die Skala, das Interviewermodell und die Protokollversion. Ältere Modellläufe mit Prozentwerten behalten ihre ursprüngliche Einheit. Der Judge erhält ausschließlich Diagnose und Referenzangaben.

## Judge: diagnosis-equivalence-v1

GPT-6.1 Sol bewertet jede benannte Diagnose separat, auch bei 0 %. Der Prompt verwendet die gelieferten Kriterien: gleiche Erkrankung, Synonym/Abkürzung oder spezifischere Form gilt als korrekt; andere Erkrankung, bloßer Befund oder unspezifische Oberkategorie als inkorrekt. Nur `correct` oder `incorrect` sind gültig; äußere Leerzeichen werden entfernt. Keine freie Begründung, kein JSON. Akzeptierte Alternativen stammen aus `accepted_alternatives` des Falls, standardmäßig `[]` → „none“. Keine automatischen Synonymlisten, keine falschen Antwortoptionen als Alternativen.

Der Judge erhält ausschließlich Vorhersage, Referenz und freigegebene Alternativen. Wahrscheinlichkeit, Modellidentität, Teilnehmer-ID und Gespräch fehlen, um die Beurteilung nicht damit zu beeinflussen. Neue Einzelabgaben werden einmal bewertet und liefern `top1_correct`. Nur für historische Listen mit mehreren Positionen wird weiterhin `top3_correct` berechnet; darin erhalten leere Alternativen `status: not_provided`, `verdict: null` ohne Modellaufruf. Das sind automatische Urteile; die fachliche Güte muss für die Studie separat geprüft werden.

Migration `004_diagnosis_judge` ergänzt die Tabelle `diagnosis_judgments`. Nach jeder neuen finalen menschlichen Abgabe bzw. erfolgreichen Simulation wird genau ein Auftrag atomar mit dem Ergebnis gespeichert. Historische abgeschlossene Fälle werden nicht nachträglich automatisch bewertet. Eingaben, Modell und Promptversion werden im Auftrag eingefroren. Der Worker verarbeitet die Bewertung unabhängig vom Studienfortschritt mit Lease-Schutz und ohne automatische Wiederholung bezahlter Aufrufe. Fehler/ungültige Ausgabe: `failed`, abgelaufene Lease: `interrupted`; `result: null` statt einer falschen Bewertung. Originaldiagnose, Runden und Fortschritt bleiben erhalten.

Die Bewertung ist ausschließlich unter `clinical_cases[].judgment` bzw. `runs[].judgment` im geschützten Forschungsexport enthalten. Keine Bewertung oder Referenzlösung in Teilnehmer-Endpunkten. Expliziter administrativer Neuversuch:

```text
POST /v1/admin/studies/:studyId/judgments/:judgmentId/retry
X-Admin-Key: <admin key>
```

Nur `failed`/`interrupted` und passende Studie zulässig. Dieser Neuversuch kann weitere LLM-Kosten verursachen; er erfolgt nicht automatisch. Tests decken Einmaligkeit, Besitzprüfung, Fehler, abgelaufene Leases, Export und Teilnehmer-Datentrennung ab.
