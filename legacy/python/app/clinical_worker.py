import json
import time
from sqlalchemy import select, update
from app.agents import PATIENT, LAB
from app.models import ClinicalCase, ClinicalTurn, ParticipantSession
from app.openrouter import ProviderError

PROMPT_VERSION = "clinician-interaction-v1"
LEASE_SECONDS = 180


def claim_turn(factory, worker_id):
    now = time.time()
    with factory() as db:
        expired = db.scalars(select(ClinicalTurn.id).where(
            ClinicalTurn.status == "running", ClinicalTurn.lease_until < now)).all()
        for turn_id in expired:
            # Conditional update prevents two workers refunding the same round twice.
            changed = db.execute(update(ClinicalTurn).where(
                ClinicalTurn.id == turn_id, ClinicalTurn.status == "running", ClinicalTurn.lease_until < now
            ).values(status="interrupted", error_code="worker_lease_expired", finished_at=now))
            if changed.rowcount:
                turn = db.get(ClinicalTurn, turn_id)
                db.execute(update(ClinicalCase).where(ClinicalCase.id == turn.case_attempt_id)
                           .values(rounds_used=ClinicalCase.rounds_used - 1))
        candidate = db.scalar(select(ClinicalTurn.id).where(ClinicalTurn.status == "queued")
                              .order_by(ClinicalTurn.created_at, ClinicalTurn.id).limit(1))
        if not candidate:
            db.commit()
            return None
        changed = db.execute(update(ClinicalTurn).where(
            ClinicalTurn.id == candidate, ClinicalTurn.status == "queued").values(
                status="running", worker_id=worker_id, lease_until=now + LEASE_SECONDS))
        db.commit()
        return candidate if changed.rowcount == 1 else None


def process_turn(factory, provider, turn_id, worker_id):
    with factory() as db:
        turn = db.get(ClinicalTurn, turn_id)
        if turn.status != "running" or turn.worker_id != worker_id or turn.lease_until <= time.time():
            return
        attempt = db.get(ClinicalCase, turn.case_attempt_id)
        session = db.get(ParticipantSession, attempt.session_id)
        case = next(c for c in session.snapshot["cases"] if c["id"] == attempt.case_id)
        model = session.model_id
        if turn.target == "patient":
            history = db.scalars(select(ClinicalTurn).where(
                ClinicalTurn.case_attempt_id == attempt.id, ClinicalTurn.target == "patient",
                ClinicalTurn.status == "succeeded").order_by(ClinicalTurn.created_at)).all()
            payload = {"patient_facts": case["patient_facts"], "question": turn.question,
                       "previous_questions": [{"question": t.question, "answer": t.response} for t in history]}
            prompt = PATIENT
        else:
            payload = {"requested_results": {key: case["labs"][key] for key in turn.tests}}
            prompt = LAB
    try:
        reply = provider.complete(model, [{"role": "system", "content": prompt},
                                         {"role": "user", "content": json.dumps(payload, ensure_ascii=False)}])
        content = reply.pop("content")
        # Display canonical values independently of the model's wording.
        if turn.target == "lab":
            reply["lab_explanation"] = content
            content = "\n".join(f"{key}: {value}" for key, value in payload["requested_results"].items())
        state = {"status": "succeeded", "response": content,
                 "metadata_json": {**reply, "prompt_version": PROMPT_VERSION}}
    except ProviderError as exc:
        state = {"status": "failed", "error_code": str(exc)}
    except Exception:
        state = {"status": "failed", "error_code": "invalid_agent_output_or_processing_error"}
    with factory() as db:
        changed = db.execute(update(ClinicalTurn).where(
            ClinicalTurn.id == turn_id, ClinicalTurn.worker_id == worker_id, ClinicalTurn.status == "running",
            ClinicalTurn.lease_until > time.time()).values(**state, finished_at=time.time(), lease_until=None))
        if changed.rowcount and state["status"] != "succeeded":
            db.execute(update(ClinicalCase).where(ClinicalCase.id == turn.case_attempt_id)
                       .values(rounds_used=ClinicalCase.rounds_used - 1))
        db.commit()
