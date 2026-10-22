"""Loopback-only development preview, kept separate from Prolific recruitment."""
import secrets
from fastapi import Depends, HTTPException, Request
from sqlalchemy.exc import IntegrityError
from app.clinical import add_case_attempts, assign_cases
from app.models import ParticipantSession, Study
from app.schemas import StudyConfig, StrictModel
from app.security import issue_token
from typing import Literal


def demo_config():
    return StudyConfig.model_validate({
        "id": "clinician-demo-v1", "title": "Clinical Reasoning Study", "workflow": "clinician",
        "is_demo": True, "cases_per_participant": 3,
        "consent_text": "This is a development preview with three fictional cases. It is not a live Prolific study. "
                        "Questions and diagnoses are saved on this server. Questions are sent to the configured "
                        "LLM provider. Do not enter real patient information. The final study information and "
                        "consent materials will be supplied before recruitment.",
        "conditions": ["Human_Clinician"],
        "steps": [{"id": "screening", "title": "About you", "kind": "questionnaire",
                   "instructions": "Tell us a little about your clinical background.", "questions": [
                       {"id": "physician", "label": "I am a qualified medical doctor.", "kind": "boolean"},
                       {"id": "specialty", "label": "Primary specialty", "kind": "choice",
                        "options": ["General practice / Family medicine", "Internal medicine", "Emergency medicine",
                                    "Surgery", "Pediatrics", "Psychiatry", "Other"]},
                       {"id": "years", "label": "Years in clinical practice", "kind": "number",
                        "minimum": 0, "maximum": 70}]},
                  {"id": "final", "title": "Final check", "kind": "final_check"}],
        "cases": [
            {"id": "demo-fatigue", "title": "Fatigue on exertion", "source": "Synthetic",
             "opening": "A 42-year-old woman presents to primary care with progressive fatigue over three months. "
                        "She becomes breathless when climbing stairs. She is comfortable at rest and has no chest pain. "
                        "Blood pressure is 118/74 mmHg, pulse 92/min, temperature 36.7 °C and oxygen saturation 99%.",
             "patient_facts": "42-year-old woman. Fatigue for three months, gradually worsening. Breathlessness on stairs. "
                              "Periods are regular but very heavy, lasting 8 days. No black stool or visible GI bleeding. "
                              "No fever, weight loss, cough or chest pain. Eats little meat. No regular medications. "
                              "No previous illness. Examination shows conjunctival pallor. All other facts unknown.",
             "labs": {"Complete blood count": "Hemoglobin 8.8 g/dL; MCV 69 fL; WBC 6.1 × 10^9/L; platelets 410 × 10^9/L.",
                      "Iron studies": "Ferritin 6 ng/mL; transferrin saturation 5%.",
                      "TSH": "2.1 mIU/L.", "Vitamin B12": "410 pg/mL."},
             "reference_diagnosis": "Iron deficiency anemia associated with heavy menstrual bleeding"},
            {"id": "demo-thirst", "title": "Thirst and weight loss", "source": "Synthetic",
             "opening": "A 23-year-old man reports persistent thirst and unintentional weight loss over four weeks. "
                        "He has no known medical conditions. Blood pressure is 116/72 mmHg, pulse 88/min, "
                        "respiratory rate 16/min and temperature 36.8 °C.",
             "patient_facts": "23-year-old man. Thirst, frequent urination and nocturia for four weeks. Lost 5 kg despite "
                              "increased appetite. No vomiting, abdominal pain, fever, dysuria or medication use. "
                              "No family history known. Alert and well oriented. All other facts unknown.",
             "labs": {"Blood glucose": "Random plasma glucose 326 mg/dL.", "HbA1c": "10.4%.",
                      "Urinalysis": "Glucose 3+; ketones negative; leukocyte esterase negative.",
                      "Metabolic panel": "Sodium 136 mmol/L; potassium 4.1 mmol/L; bicarbonate 24 mmol/L; creatinine 0.9 mg/dL.",
                      "Diabetes autoantibodies": "GAD65 antibodies positive."},
             "reference_diagnosis": "Type 1 diabetes mellitus without ketoacidosis"},
            {"id": "demo-palpitations", "title": "New palpitations", "source": "Synthetic",
             "opening": "A 35-year-old woman presents with intermittent palpitations and difficulty sleeping for six weeks. "
                        "Her pulse is regular at 112/min, blood pressure 132/66 mmHg and temperature 37.0 °C.",
             "patient_facts": "35-year-old woman. Six weeks of palpitations, heat intolerance, sweating and difficulty sleeping. "
                              "Lost 4 kg despite good appetite. Fine hand tremor and diffuse painless thyroid enlargement "
                              "on examination. No neck pain, stimulant use, fever or regular medications. All other facts unknown.",
             "labs": {"Thyroid function": "TSH <0.01 mIU/L; free T4 3.2 ng/dL.",
                      "Thyroid antibodies": "TSH receptor antibodies elevated at 7.8 IU/L.",
                      "ECG": "Sinus tachycardia at 112/min.", "Complete blood count": "Hemoglobin 13.2 g/dL; WBC 6.8 × 10^9/L."},
             "reference_diagnosis": "Graves disease"}]
    }).model_dump()


class PreviewConsent(StrictModel):
    consent: Literal[True]


def register_preview(app, settings, database, session_view):
    def local_only(request):
        if settings.app_env != "development" or not request.client or request.client.host not in ("127.0.0.1", "::1"):
            raise HTTPException(404, "Preview not available")
        origin = request.headers.get("origin")
        if origin and origin != str(request.base_url).rstrip("/"):
            raise HTTPException(403, "Use the local preview page")

    @app.get("/v1/preview")
    def preview_info(request: Request):
        local_only(request)
        config = demo_config()
        return {key: config[key] for key in ("id", "title", "version", "consent_version", "consent_text",
                                            "is_demo", "cases_per_participant", "workflow")}

    @app.post("/v1/preview/sessions", status_code=201)
    def preview_session(request: Request, body: PreviewConsent, db=Depends(database)):
        local_only(request)
        config = demo_config()
        if not db.get(Study, config["id"]):
            db.add(Study(id=config["id"], config=config))
            try:
                db.commit()
            except IntegrityError:
                db.rollback()
        token, token_hash = issue_token(settings.session_secret.get_secret_value())
        participant = ParticipantSession(study_id=config["id"], prolific_pid=secrets.token_hex(12),
            prolific_study_id="0" * 24, prolific_session_id=secrets.token_hex(12), token_hash=token_hash,
            model_id=secrets.choice(config["models"]), condition="Human_Clinician", snapshot=assign_cases(config))
        db.add(participant)
        add_case_attempts(db, participant)
        db.commit()
        return {**session_view(participant), "session_token": token}
