# Prompts und Diagnosebewertung

Stand 20.11.2026. Die Prompts für Patient, Interviewer und Diagnosebewertung stehen in `domain/patient.ts`, `domain/agents.ts` und `domain/judge.ts`.

## Patient: clinical-patient-fact-ids-v4

Eine Frage pro Nachricht, nur die erste bei mehreren Fragen. Ein bis drei Sätze in Alltagssprache; bei offenen Fragen höchstens zwei thematisch passende Fakten. Fehlende Information: „I'm not sure.“. Explizit negative Befunde bleiben negativ; unbekannt wird niemals als normal oder nein ausgegeben. Untersuchung, Tests und Bilder nur bei ausdrücklicher Nachfrage. Keine Diagnose, Interpretation oder ungefragten Fakten.

Seit Version 4 darf der Patient auf eine gezielte Frage sichtbare Veränderungen aus allen Abschnitten der Fallakte beschreiben. Bei einer teilweise beantwortbaren Frage benennt er die Unsicherheit und die einschlägige Beobachtung. Ein zeitlicher Zusammenhang kann so beschrieben werden, auch wenn die Ursache unbekannt ist. Laborwerte, Bilder und Befunde, die eine ärztliche Untersuchung erfordern, werden weiterhin erst auf Anfrage freigegeben. Der Export weist die verwendete Patientenversion pro Antwort aus.

Die Umstellung erfolgte während der Datenerhebung. Version 4 wurde anhand der 17 zuvor mit „I'm not sure.“ beantworteten Fragen aus den ersten beiden zur Auswertung freigegebenen Teilnahmen geprüft. Diese erneuten Modellaufrufe dienten der Funktionsprüfung und sind keine zusätzlichen Studienbeobachtungen.

Das private Record enthält `{id, status, text}`. Bestehende Fälle werden deterministisch zeilen- und satzweise aus `opening`, `patient_facts` und `labs` abgeleitet. Feldnamen, Dezimalzahlen, Einheiten und explizite Negationen bleiben im Quellwortlaut. `recorded` bedeutet dokumentierter Quelltext und ist keine positive Symptomklassifikation. Dieser Adapter macht keine semantische Zerlegung zusammengesetzter Quellsätze. Für fachlich kuratierte atomare Fakten kann ein Fall optional `fact_pack` mit `present`, `absent`, `unknown` oder `recorded` importieren. Ein vorhandenes Paket ersetzt die automatische Ableitung. Untersuchung/Testart sollte im Text stehen. Referenzdiagnose und akzeptierte Alternativen werden nie in den Record übernommen; kuratierte Pakete müssen diese Trennung ebenfalls einhalten.

Rückgabe exakt `{"fact_ids":[...],"answer":"..."}`. Nur `answer` geht an den Arzt. Unbekannte oder doppelte IDs sowie unbelegte Antworten mit leerer ID-Liste werden als fehlerhafter Aufruf behandelt; die Runde wird zurückgegeben. Eine unbekannte Antwort ohne IDs muss exakt „I'm not sure.“ sein. Separate Bildfakten erlauben die Freigabe der vorhandenen Originaldateien. Modell bekommt keine Bildpixel. Alte Bildfreigaben bleiben gültig.

Exportiert werden ausgewählte IDs, zugehörige Fakten, `source-facts-v1`, SHA-256 des Pakets, Promptversion, Modell, Anbieter, Generation-ID, Nutzung und Laufzeit. Die ID-Prüfung bestätigt die Herkunft, nicht automatisch die semantische Richtigkeit oder Vollständigkeit der LLM-Antwort.

## Doctor: doctor-patient-top1-three-rounds-closed-ended-prompt10-truncate15-v10

Version 10 verlangt ausschließlich geschlossene Fragen. Gemeint sind Ja/Nein-Fragen oder Fragen mit ausdrücklich genannten Antwortalternativen. Aufforderungen zu Beschreibungen, Erklärungen oder Erzählungen sind ausgeschlossen; suggestive Fragen sollen vermieden werden. Auch Fragen nach Untersuchungsbefunden, Tests oder Bildern müssen geschlossen formuliert werden. Jede der drei Frageanweisungen wiederholt ausdrücklich „one closed-ended question“. Der Schlussaufruf bleibt unverändert. Die Vorgabe ist eine Prompt-Instruktion; die Anwendung klassifiziert den Fragetyp nicht automatisch und verwirft oder wiederholt keine Antwort aufgrund einer heuristischen Einstufung. Die Antwortregeln des Patienten werden nicht auf Ja/Nein beschränkt, sondern bleiben unverändert.

Für den nächsten Vergleich gilt wieder `complete_facts`: Der Patient erhält sämtliche ursprünglichen Fakten und Fact-IDs einschließlich der Bildfreigabe-Fakten. Die Eingangsbeschreibung bleibt gleich. Der Doctor erhält weiterhin nur die Eingangsbeschreibung und die erfragten Antworten beziehungsweise freigegebenen Bilder. Referenzdiagnose und vollständiger privater Record werden nicht an den Doctor übergeben. Patient und Judge bleiben unverändert; ebenso die drei Fragen, eine finale Diagnose, Confidence 1–7, 10 Wörter im Prompt und die technische Kürzung nach 15 Wörtern.

Vorbereitung ohne Modellaufrufe: `node --env-file=.env --import tsx scripts/doctor-benchmark.mjs INPUT.sqlite OUTPUT.sqlite prepare all` (ohne Ablationsmanifest). Ein späterer expliziter Start verwendet dieselben Argumente mit `run` statt `prepare`. Version 10 wird getrennt von den bisherigen Ergebnissen gespeichert. Die abgeschlossenen v8-Kontroll- und Ablationsläufe sowie die v9-Läufe werden nicht verändert. `doctor-prompt-v8.ts` und `doctor-prompt-v9.ts` halten deren exakte Prompts und Rundenanweisungen für den versionierten Offline-Audit fest.

### Historischer Doctor-Prompt v9

Version 9 verlangt ausschließlich offene Fragen, die eine beschreibende Antwort ermöglichen. Ja/Nein-, Auswahl- und suggestive Fragen sind im Systemprompt ausgeschlossen. Auch Fragen nach Untersuchungsbefunden, Tests oder Bildern müssen offen formuliert werden. Jede der drei Frageanweisungen wiederholt ausdrücklich „one open-ended question“. Die v9-Läufe wurden mit vollständigen Fakten durchgeführt und behalten ihre ursprüngliche Promptversion.

### Historischer Doctor-Prompt v8

Version 8 übernimmt am 20.11.2026 den vorgegebenen Doctor-Prompt mit „Each question must be at most 10 words long.“. Die technische Grenze bleibt ausdrücklich bei 15 Wörtern: Fragen mit 11 bis 15 Wörtern werden unverändert verwendet; erst nach dem 15. Wort wird abgeschnitten. Gezählt werden durch Leerraum getrennte Wörter nach Entfernen äußerer Leerzeichen. Zeilenumbrüche, Tabs und geschützte Leerzeichen trennen ebenfalls Wörter. Kontraktionen und Bindestrichwörter zählen jeweils als ein Wort. Die vier Rundenanweisungen werden getrennt vom Systemprompt und einzeln je Aufruf gesendet.

Die Anwendung kürzt längere Fragen vor dem Aufruf des Patienten und führt das Interview fort. Sie verwendet den gekürzten Text im Verlauf beider Agenten und im Benchmark-Feld `llm_rounds.doctor_question`. Die vollständige Modellausgabe bleibt in `llm_calls` gespeichert. Die Kürzung erhält Wortlaut und Leerraum bis zum Ende des 15. Wortes, auch wenn dadurch ein unvollständiger Satz entsteht. Diagnose und Confidence werden separat validiert. Die Begrenzung gilt für den autonomen Doctor-Agenten. Historische Läufe behalten ihre ursprüngliche Promptversion: v5 ohne Wortgrenze, v7 mit 15 Wörtern im Prompt und einer technischen Grenze von 15.

Der versionierte Benchmark speichert den vollständigen Systemprompt, seinen SHA-256, die vier Rundenanweisungen, die Promptvorgabe und die technische Wortgrenze in `llm_prompts`. Jeder Lauf verweist über `llm_runs.doctor_prompt_version` darauf und enthält zusätzlich `doctor_prompt_question_words` (10) sowie `doctor_max_question_words` (15). Die Eindeutigkeit eines Laufs berücksichtigt Fall, Modell, Wiederholung und Promptversion, sodass alte und neue Ergebnisse gemeinsam aufbewahrt werden können.

Für Prolific gilt weiterhin: genau drei erfolgreiche Antworten, danach Diagnoseeingabe. Die Anleitung erklärt die Beschränkung auf eine Frage und die explizite Anforderung von Befunden.

Der autonome Interviewer stellt drei einzelne Fragen. Nach der dritten Patientenantwort folgt ein eigener Aufruf für die Diagnose. Beide Gruppen sehen die Eingangsvignette, die Antworten auf ihre Fragen und die dazu freigegebenen Originalbilder mit Bildunterschrift. Die Bilder bleiben im Gesprächsverlauf verfügbar. Die Fragen verwenden das Format `{"question":"..."}`. Beispiel einer Schlussantwort:

```json
{"diagnoses":[{"diagnosis":"A","confidence":6}]}
```

Ärzte und LLMs geben eine Diagnose mit ganzzahliger Confidence von 1 bis 7 ab (`likert_1_7`). Der Export speichert bei neuen Modellläufen die Skala, das Interviewermodell und die Protokollversion. Ältere Modellläufe mit Prozentwerten behalten ihre ursprüngliche Einheit. Der Judge erhält ausschließlich Diagnose und Referenzangaben.

### Mistral-Benchmark ab 20.11.2026

`scripts/doctor-benchmark.mjs` unterstützt die gezielte Modellauswahl als weiteres Argument nach Eingabe, Ausgabe und Betriebsart, z. B. `node --env-file=.env --import tsx scripts/doctor-benchmark.mjs INPUT.sqlite OUTPUT.sqlite run mistralai/mistral-large-4-0`. Ohne Modellauswahl verwendet der Runner GPT-6.1 Sol, Claude Fable 5.2, Mistral Large 4 und Kimi K3.1 Pro. Eine bestehende Ergebnisdatei wird nur bei übereinstimmenden Metadaten fortgesetzt.

Mistral Large 4 (`mistralai/mistral-large-4-0`) erhält Temperatur 1 und `reasoning.effort: "high"`. Das ist laut OpenRouter-Modellkatalog vom 20.11.2026 die höchste unterstützte Stufe; `max` wird für dieses Modell nicht angeboten. Das Ausgabelimit bleibt wie im bisherigen Benchmark bei 32.768 Tokens je Doctor-Aufruf. Bildzugriff erfolgt ausschließlich über im Patientengespräch freigegebene Bilder. Patient und Judge behalten ihre bisherigen Einstellungen.

Pro verwendetem Fall gibt es drei unabhängige Wiederholungen. Der neue Durchlauf verwendet für alle vier Doctor-Modelle v8 mit derselben Promptvorgabe von 10 Wörtern und technischen Grenze von 15 Wörtern. GPT, Claude und Kimi verwenden `max`; Mistral verwendet die höchste unterstützte Stufe `high`. Kimi und Mistral erhalten Temperatur 1 explizit. Für GPT und Claude bleibt das Temperaturfeld wie bisher ausgelassen, weil der Anbieter bei maximalem Reasoning nur seinen Standardwert akzeptiert. Historische v5- und v7-Gespräche werden nicht nachträglich bearbeitet. Ein kombinierter Export muss Promptversionen trennen; für den aktuellen Vergleich sind die v8-Ansichten vorgesehen.

## Faktenablation vom 20.11.2026

Zwei weitere Bedingungen verwenden denselben Doctor-Prompt v8, dieselben vier Modelle und jeweils drei Wiederholungen pro Fall. Der bestehende v8-Durchlauf mit vollständigen Fakten bleibt die Kontrolle und wird nicht neu ausgeführt. Die Startbeschreibung und sämtliche mit `Initial presentation:` markierten Fakten bleiben unverändert. Aus den übrigen Fakten-IDs einschließlich der Bildfreigabe-Fakten werden nominell 25 % bzw. 50 % entfernt. Die Referenzdiagnose und ihre akzeptierten Alternativen bleiben ausschließlich für den Judge unverändert verfügbar.

`scripts/plan-fact-ablation.mjs` erzeugt einmalig einen zufälligen 256-Bit-Seed und ordnet die infrage kommenden IDs pro Fall nach `HMAC-SHA256(seed, JSON.stringify(["fact-ablation-v1", case_id, fact_id]))`. Beide Bedingungen verwenden dieselbe Rangfolge; die 25-%-Entfernungen sind daher vollständig in den 50-%-Entfernungen enthalten. Eine feste Auswahl gilt für alle Modelle und alle drei Wiederholungen desselben Falls. Die Anzahl wird pro Fall auf die nächste ganze Zahl gerundet, bei halben Zahlen aufgerundet. Von insgesamt 1.701 infrage kommenden IDs werden dadurch 445 bzw. 888 entfernt; die tatsächlichen Anteile und Zählwerte werden pro Fall gespeichert.

Der Filter wird auf den fertig aufgebauten Patienten-Record angewendet. Text, Status, Reihenfolge und IDs der verbleibenden Fakten werden beibehalten. Entfernte Bild-Fakten verlieren auch ihre Bildfreigaberechte; verbleibende Bild-IDs werden nicht neu nummeriert. Der Patient erhält in jedem Aufruf ausschließlich den reduzierten Record. Antworten mit entfernten IDs werden abgelehnt. Verwandte oder mehrfach vorkommende Informationen in anderen Fakten werden nicht zusätzlich semantisch bereinigt: Die Ablationseinheit ist eine vorhandene Fakten-ID, die mehrere klinische Details enthalten kann.

Die Manifeste sind in `llm_conditions` gespeichert. `llm_case_fact_sets` hält entfernte, erhaltene und geschützte IDs sowie Original- und Effektivhashes fest; `llm_case_fact_masks` enthält den Originaltext und die Auswahlkennzeichen jeder ID. Jeder Lauf hat eine `condition_id`, einen `original_fact_pack_sha256` und den tatsächlich verwendeten `fact_pack_sha256`. Damit ist die Ablation von der unveränderten Promptversion getrennt. Der Offline-Audit rekonstruiert die exakten Modellanfragen und prüft, dass der Patient nur den zugehörigen reduzierten Record erhielt.

Die v8-Ablationen wurden mit `node --env-file=.env --import tsx scripts/doctor-benchmark.mjs INPUT.sqlite OUTPUT.sqlite run all MANIFEST.json` ausgeführt. Ein Manifest ist an seine Doctor-Promptversion gebunden; die historischen v8-Manifeste werden mit dem aktuellen v10-Prompt nicht akzeptiert. `prepare` legt nur das Manifest, die Faktenauswahl und die Warteschlange an. Alte Exporte werden nicht verändert. Für die abgeschlossene Ablationsauswertung sind ausschließlich v8 und die drei Bedingungen `complete_facts`, `fact_drop_25` und `fact_drop_50` zu verwenden.

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
