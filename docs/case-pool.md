# Medizinischer Fallpool

Quelle: [AI-in-Management/multiagent-medical-diagnosis-system](https://github.com/AI-in-Management/multiagent-medical-diagnosis-system/tree/b30b35ce56bd0fae3f0d3818e7064025a497532a), Commit `b30b35ce56bd0fae3f0d3818e7064025a497532a`. Experiment-Next ist die strukturelle Frontend-Referenz; es enthält keine medizinischen Fälle.

## Auswahl

| Datensatz | Datei unter diagnosis_experiment/dataset | Vorhanden | Geeignet nach Auswahlregel | Ausgewählt |
| --- | --- | ---: | ---: | ---: |
| MedQA | medqa.jsonl | 170 | 101 | 100 |
| NEJM | structural_nejm.jsonl | 170 | 170 | 100 |
| MediQ | structural_mediq.jsonl | 129 | 101 | 100 |

Die konservative Auswahlregel in `scripts/medical-pool.mjs` lässt bei MedQA/MediQ nur direkte Diagnosefragen mit passender Frageformulierung zu. Therapie-, Bestätigungs- und ähnliche Fragen haben keine passende Referenzdiagnose für diesen Ablauf. Fälle mit Verweisen auf nicht mitgelieferte Bilder werden ausgelassen. Einige anders formulierte Diagnosefragen können ebenfalls ausgeschlossen werden; das ist eine dokumentierte Auswahlregel und kein Anspruch auf Vollständigkeit. NEJM enthält Originalbild-URLs und wird vollständig berücksichtigt. Version 2 erkennt bei MediQ zusätzliche direkte Diagnosefragen wie „What was the most likely diagnosis …?“ und „These findings support a diagnosis of which of the following?“. Sie prüft zusätzlich auf das Wort „picture“. Die ausgeschlossenen IDs und Gründe sind im Manifest dokumentiert.

Innerhalb jeder Quelle werden die geeigneten IDs mit HMAC-SHA-256 und einem einmalig zufällig erzeugten 256-Bit-Seed geordnet; die ersten 100 werden gewählt. Alle 150 Fälle der vorigen Auswahl sind enthalten. Reihenfolge der Quelldateien beeinflusst die Auswahl nicht. Es gibt keine Auswahl nach Modellleistung oder Diagnose. Der lokale Seed in `data/clinical-300/seed.txt` bleibt unverändert. Manifest `0d303432cf542d86deddf7a0851bab838c08675996c0c0b7013675c974850488` protokolliert Quelle, Commit, Dateihashes, IDs, Rohdatenhashes, Ausschlüsse und Bildhashes. Der Pool wird pro Studie eingefroren. Seit 27.10.2026 erhält jede neue Sitzung fünf Fälle aus allen drei Quellen, verteilt als 2/2/1. Die Zuteilung berücksichtigt den verbleibenden Bestand, mischt die Reihenfolge und reserviert jeden Fall exklusiv für einen Arzt. Abgebrochene Sitzungen behalten ihre Reservierungen; Demo und Live-Pool sind getrennt. Verschiedene Quellen können verwandte Vignetten enthalten; die Exklusivität bezieht sich auf die ursprüngliche Fall-ID je Quelle.

## Datenaufteilung

- Eingang: neutrale Überschrift und erste MedQA-Fallinformation bzw. Demografie und Hauptsymptom der strukturierten Quellen.
- Patient: Anamnese, Symptome, körperliche Untersuchung, Labor-/Funktionstests, Bildgebungsbefunde und dokumentierte Eingriffe aus der Quelle. Die Importfelder `patient_facts` und `labs` bleiben als Quellbereiche erhalten; beide werden dem einzigen Patienten-Agenten gegeben, ohne Referenzlösung oder Antwortoptionen. Die Quellabschnitte werden ohne LLM-Umschreiben in Fakten mit stabilen IDs und Quellwortlaut geteilt. GPT-6.1 Sol antwortet nur auf die erste Frage und nennt intern die verwendeten Fakten-IDs. Ungültige IDs werden abgelehnt und geben die Runde zurück. Die Prüfung der IDs ersetzt keine vollständige semantische Prüfung des Antworttexts. Ein optionales `fact_pack` ermöglicht fachlich kuratierte Fakten mit explizitem Status. Pro Fall sind drei erfolgreiche Patientenfragen nötig.
- NEJM-Bilder: 100 Originaldateien vom in der Quelle angegebenen NEJM-Endpunkt, ohne generierte Ersatzbilder. Bei Fragen nach Bildern oder Bildgebung kann der Patienten-Agent passende Bildgruppen auswählen; nur validierte Bildverweise einer erfolgreichen Antwort werden für diese Sitzung freigegeben. Mehrteilige Originalabbildungen werden vollständig angezeigt. Bilder werden nicht vom Patienten-LLM neu interpretiert; Ärzte sehen die Originale. Historische Auswahlen behalten ihren Zugriff. Der autonome Doctor-Benchmark erhält dieselben freigegebenen Originaldateien und Bildunterschriften über OpenRouter.
- Referenzdiagnose: ausschließlich für den Judge und Studienverwaltung/Export, niemals Teil der Patienten- oder Doctor-Prompts. `accepted_alternatives` enthält nur ausdrücklich freigegebene gleichwertige Diagnosen, keine Multiple-Choice-Ablenker; ohne Liste wird „none“ an den Judge übermittelt.

MedQA besitzt in diesem Repository keine entsprechende strukturierte Datei. Die ausgewählten 100 Fälle werden daher über geprüfte Faktenindizes aufgeteilt; der Text wird nicht durch ein weiteres LLM umformuliert. Laborwerte im Feld `objective` werden zusätzlich übernommen, weil sie sonst verloren gingen. Die anderen beiden Quellen verwenden die bereits im Repository aufbereiteten Felder. Diese Aufteilung ist technisch kontrolliert, ersetzt aber nicht die fachliche Freigabe des Studienmaterials. Eine neue Zufallsauswahl mit bisher nicht aufgeteilten MedQA-IDs bricht ab und verlangt die Ergänzung der Aufteilung.

## Reproduzieren und übertragen

```powershell
npm run build --workspace @clinical/shared
# Identische Auswahl mit dem Seed des veröffentlichten Pools:
New-Item -ItemType Directory data/neuer-pool
Copy-Item data/clinical-300/seed.txt data/neuer-pool/seed.txt
node scripts/prepare-medical-pool.mjs data/sources/medclarify data/neuer-pool
node --env-file=.env scripts/study.mjs import data/clinical-300/study.json
```

Das Werkzeug überschreibt keine fertige Studie oder ihr Manifest. Es lädt nur Bilder vom festgelegten NEJM-Endpunkt, mit Größen- und Dateitypgrenzen; beim Import werden Hash und Bildsignatur geprüft. Die Datenbank hält die Bilder dauerhaft, sodass Railway dafür kein lokales Dateivolumen benötigt. Der Import von Studie und Bildern auf Railway erfolgt mit demselben Werkzeug gegen deren administrativen Zugang. Der aktuelle Pool ist lokal und auf Railway importiert; die Hauptstudie bleibt inaktiv. Prolific-Kennung, Abschlusscode und endgültige Einwilligung sind noch nicht gesetzt.

Die Quelle enthält eine MIT-Lizenz für das Projekt. Die Bildprovenienz wird je Datei mitgeführt; daraus wird keine eigenständige Lizenz der NEJM-Abbildungen abgeleitet. Rohdaten, Bilddateien, Exporte und Quellen-Checkout verbleiben im ignorierten `data/`-Verzeichnis und werden nicht im öffentlichen Frontend-Bundle abgelegt.
