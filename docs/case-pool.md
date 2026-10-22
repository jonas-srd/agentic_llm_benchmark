# Medizinischer Fallpool

Quelle: [AI-in-Management/multiagent-medical-diagnosis-system](https://github.com/AI-in-Management/multiagent-medical-diagnosis-system/tree/b30b35ce56bd0fae3f0d3818e7064025a497532a), Commit `b30b35ce56bd0fae3f0d3818e7064025a497532a`. Experiment-Next ist die strukturelle Frontend-Referenz; es enthält keine medizinischen Fälle.

## Auswahl

| Datensatz | Datei unter diagnosis_experiment/dataset | Vorhanden | Geeignet nach Auswahlregel | Ausgewählt |
| --- | --- | ---: | ---: | ---: |
| MedQA | medqa.jsonl | 170 | 102 | 50 |
| NEJM | structural_nejm.jsonl | 170 | 170 | 50 |
| MediQ | structural_mediq.jsonl | 129 | 92 | 50 |

Die konservative Auswahlregel in `scripts/medical-pool.mjs` lässt bei MedQA/MediQ nur direkte Diagnosefragen mit passender Frageformulierung zu. Therapie-, Bestätigungs- und ähnliche Fragen haben keine passende Referenzdiagnose für diesen Ablauf. Fälle mit Verweisen auf nicht mitgelieferte Bilder werden ausgelassen. Einige anders formulierte Diagnosefragen können ebenfalls ausgeschlossen werden; das ist eine dokumentierte Auswahlregel und kein Anspruch auf Vollständigkeit. NEJM enthält Originalbild-URLs und wird vollständig berücksichtigt. Die ausgeschlossenen IDs und Gründe sind im Manifest dokumentiert.

Innerhalb jeder Quelle werden die geeigneten IDs mit HMAC-SHA-256 und einem einmalig zufällig erzeugten 256-Bit-Seed geordnet; die ersten 50 werden gewählt. Reihenfolge der Quelldateien beeinflusst die Auswahl nicht. Es gibt keine Auswahl nach Modellleistung oder Diagnose. Der lokale Seed in `data/clinical-150/seed.txt` bleibt unverändert. Manifest `ae4e477e16c3cb6ce9f939b66d529630db574c6898c954b05aacb60d35378ea5` protokolliert Quelle, Commit, Dateihashes, IDs, Rohdatenhashes, Ausschlüsse und Bildhashes. Der Pool wird pro Studie eingefroren; erst daraus wird pro Sitzung eine Teilmenge gezogen. Die Teilmenge ist nicht zusätzlich nach Quellen ausbalanciert, und verschiedene Quellen können verwandte Vignetten enthalten.

## Datenaufteilung

- Eingang: neutrale Überschrift und erste MedQA-Fallinformation bzw. Demografie und Hauptsymptom der strukturierten Quellen.
- Patient: Anamnese und Symptome aus der Quelle, ohne Referenzlösung oder Antwortoptionen. Der Prompt beantwortet nur die gestellte Frage; fehlende Informationen bleiben unbekannt.
- Lab: körperliche Untersuchung, Labor-/Funktionstests, Bildgebungsbefunde und dokumentierte Eingriffe. Die Werte werden unverändert angezeigt, die generierte Laborerklärung separat protokolliert. Ein Befundpaket kann mehrere Werte enthalten; eine Auswahl von Paketen zählt als eine Runde.
- NEJM-Bilder: 50 Originaldateien vom in der Quelle angegebenen NEJM-Endpunkt, ohne generierte Ersatzbilder. Mehrteilige Originalabbildungen werden vollständig als „Original case images“ angefordert. Bilder werden nicht vom Lab-LLM neu interpretiert; Ärzte sehen die Originale. Der separate autonome Doctor-Benchmark arbeitet weiterhin mit Textbefunden.
- Referenzdiagnose: ausschließlich für Studienverwaltung/Export, niemals Teil der Patient-/Laborprompts oder Teilnehmerantworten.

MedQA besitzt in diesem Repository keine entsprechende strukturierte Datei. Die ausgewählten 50 Fälle werden daher über geprüfte Faktenindizes aufgeteilt; der Text wird nicht durch ein weiteres LLM umformuliert. Laborwerte im Feld `objective` werden zusätzlich übernommen, weil sie sonst verloren gingen. Die anderen beiden Quellen verwenden die bereits im Repository aufbereiteten Felder. Diese Aufteilung ist technisch kontrolliert, ersetzt aber nicht die fachliche Freigabe des Studienmaterials. Eine neue Zufallsauswahl mit bisher nicht aufgeteilten MedQA-IDs bricht ab und verlangt die Ergänzung der Aufteilung.

## Reproduzieren und übertragen

```powershell
npm run build --workspace @clinical/shared
# Lokales Checkout der oben genannten Quelle und bereits gewählter Commit:
node scripts/prepare-medical-pool.mjs data/sources/medclarify data/neuer-pool
# Für identische Auswahl vorher den vorhandenen seed.txt in den Zielordner kopieren.
node --env-file=.env scripts/study.mjs import data/clinical-150/study.json
```

Das Werkzeug überschreibt keine fertige Studie oder ihr Manifest. Es lädt nur Bilder vom festgelegten NEJM-Endpunkt, mit Größen- und Dateitypgrenzen; beim Import werden Hash und Bildsignatur geprüft. Die Datenbank hält die Bilder dauerhaft, sodass Railway dafür kein lokales Dateivolumen benötigt. Der Import von Studie und Bildern auf Railway erfolgt nach Bereitstellung der API mit demselben Werkzeug gegen deren administrativen Zugang. Der aktuelle Import ist lokal und inaktiv. Prolific-Kennung, Abschlusscode und endgültige Einwilligung sind noch nicht gesetzt.

Die Quelle enthält eine MIT-Lizenz für das Projekt. Die Bildprovenienz wird je Datei mitgeführt; daraus wird keine eigenständige Lizenz der NEJM-Abbildungen abgeleitet. Rohdaten, Bilddateien, Exporte und Quellen-Checkout verbleiben im ignorierten `data/`-Verzeichnis und werden nicht im öffentlichen Frontend-Bundle abgelegt.
