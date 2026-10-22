"""Human clinician workflow. Hidden case data stays in the server-side snapshot."""
import copy
import secrets
import time
from fastapi import Depends, Header, HTTPException
from sqlalchemy import select, update
from app.models import ClinicalCase, ClinicalTurn, ParticipantSession
from app.schemas import ClinicalDiagnosis, ClinicalQuestion


def assign_cases(config):
    snapshot = copy.deepcopy(config)
    if config.get("workflow") != "clinician":
        return snapshot
    selected = secrets.SystemRandom().sample(config["cases"], config["cases_per_participant"])
    snapshot["cases"] = selected
    case_steps = [{"id": f"clinical-{i + 1}", "title": f"Case {i + 1}", "kind": "diagnosis",
                   "instructions": "", "questions": [], "case_id": case["id"]}
                  for i, case in enumerate(selected)]
    # Keep the published protocol immutable; only each session gets expanded steps.
    if {s["id"] for s in snapshot["steps"]} & {s["id"] for s in case_steps}:
        raise HTTPException(422, "Step IDs starting clinical- are reserved")
    snapshot["steps"] = snapshot["steps"][:-1] + case_steps + snapshot["steps"][-1:]
    return snapshot


def add_case_attempts(db, participant):
    db.flush()
    for step in participant.snapshot["steps"]:
        if step["kind"] == "diagnosis":
            db.add(ClinicalCase(session_id=participant.id, step_id=step["id"], case_id=step["case_id"]))


def turn_view(turn):
    return {k: getattr(turn, k) for k in ("id", "round_number", "target", "question", "tests", "status",
                                         "response", "created_at", "finished_at")}


def attempt_view(db, attempt, session):
    case = next(c for c in session.snapshot["cases"] if c["id"] == attempt.case_id)
    turns = db.scalars(select(ClinicalTurn).where(ClinicalTurn.case_attempt_id == attempt.id)
                      .order_by(ClinicalTurn.created_at, ClinicalTurn.id)).all()
    return {"id": attempt.id, "step_id": attempt.step_id, "title": case["title"], "opening": case["opening"],
            "available_tests": list(case["labs"]), "rounds_used": attempt.rounds_used, "max_rounds": 3,
            "can_ask": attempt.diagnosis is None and attempt.rounds_used < 3 and len(turns) < 6
                       and not any(t.status in ("queued", "running") for t in turns),
            "pending": any(t.status in ("queued", "running") for t in turns),
            "turns": [turn_view(t) for t in turns], "diagnosis": attempt.diagnosis,
            "confidence": attempt.confidence, "completed_at": attempt.completed_at}


def clinical_export(db, session):
    output = []
    for attempt in db.scalars(select(ClinicalCase).where(ClinicalCase.session_id == session.id)
                             .order_by(ClinicalCase.step_id)):
        case = next(c for c in session.snapshot["cases"] if c["id"] == attempt.case_id)
        item = {**attempt_view(db, attempt, session), "case_id": case["id"],
                "source": case.get("source"), "source_id": case.get("source_id"),
                "reference_diagnosis": case["reference_diagnosis"], "started_at": attempt.started_at}
        turns = db.scalars(select(ClinicalTurn).where(ClinicalTurn.case_attempt_id == attempt.id)
                          .order_by(ClinicalTurn.created_at, ClinicalTurn.id))
        item["turns"] = [{**turn_view(t), "metadata": t.metadata_json, "error_code": t.error_code} for t in turns]
        output.append(item)
    return output


def register_clinical_routes(app, database, owned, session_view):
    def get_attempt(db, session, step_id, current=True):
        attempt = db.scalar(select(ClinicalCase).where(
            ClinicalCase.session_id == session.id, ClinicalCase.step_id == step_id))
        if not attempt:
            raise HTTPException(404, "Case not found")
        if current and (session.status != "active" or
                        session.snapshot["steps"][session.step_index]["id"] != step_id):
            raise HTTPException(409, "This is not the current case")
        return attempt

    def reserve_revision(db, session, revision):
        changed = db.execute(update(ParticipantSession).where(
            ParticipantSession.id == session.id, ParticipantSession.revision == revision,
            ParticipantSession.status == "active").values(revision=ParticipantSession.revision + 1))
        if changed.rowcount != 1:
            raise HTTPException(409, "Session changed. Reload to continue.")

    @app.get("/v1/sessions/{session_id}/cases/{step_id}")
    def case_state(session_id: str, step_id: str, authorization: str | None = Header(default=None),
                   db=Depends(database)):
        session = owned(db, session_id, authorization)
        attempt = get_attempt(db, session, step_id)
        db.execute(update(ClinicalCase).where(ClinicalCase.id == attempt.id, ClinicalCase.started_at.is_(None))
                   .values(started_at=time.time()))
        db.commit()
        return attempt_view(db, attempt, session)

    @app.post("/v1/sessions/{session_id}/cases/{step_id}/questions", status_code=202)
    def question(session_id: str, step_id: str, body: ClinicalQuestion,
                 authorization: str | None = Header(default=None), db=Depends(database)):
        session = owned(db, session_id, authorization)
        attempt = get_attempt(db, session, step_id, current=False)
        previous = db.scalar(select(ClinicalTurn).where(
            ClinicalTurn.case_attempt_id == attempt.id, ClinicalTurn.request_id == body.request_id))
        if previous:
            if (previous.target, previous.question, previous.tests) != (body.target, body.question, body.tests):
                raise HTTPException(409, "Request ID already used for another question")
            return {"session": session_view(session), "case": attempt_view(db, attempt, session)}
        get_attempt(db, session, step_id)
        reserve_revision(db, session, body.revision)
        db.refresh(attempt)
        current = attempt_view(db, attempt, session)
        if not current["can_ask"]:
            raise HTTPException(409, "Wait for the response or submit your diagnosis")
        if set(body.tests) - set(current["available_tests"]):
            raise HTTPException(422, "Select available tests")
        attempt.rounds_used += 1
        attempt.started_at = attempt.started_at or time.time()
        db.add(ClinicalTurn(case_attempt_id=attempt.id, request_id=body.request_id,
                           round_number=attempt.rounds_used, target=body.target,
                           question=body.question, tests=body.tests))
        db.commit()
        db.refresh(session)
        return {"session": session_view(session), "case": attempt_view(db, attempt, session)}

    @app.post("/v1/sessions/{session_id}/cases/{step_id}/diagnosis")
    def diagnosis(session_id: str, step_id: str, body: ClinicalDiagnosis,
                  authorization: str | None = Header(default=None), db=Depends(database)):
        session = owned(db, session_id, authorization)
        attempt = get_attempt(db, session, step_id, current=False)
        if attempt.diagnosis is not None:
            if (attempt.diagnosis_request_id, attempt.diagnosis, attempt.confidence) == (
                    body.request_id, body.diagnosis, body.confidence):
                return session_view(session)
            raise HTTPException(409, "Diagnosis already submitted")
        get_attempt(db, session, step_id)
        reserve_revision(db, session, body.revision)
        if attempt_view(db, attempt, session)["pending"]:
            raise HTTPException(409, "Wait for the current response before diagnosing")
        attempt.diagnosis = body.diagnosis
        attempt.confidence = body.confidence
        attempt.diagnosis_request_id = body.request_id
        attempt.started_at = attempt.started_at or time.time()
        attempt.completed_at = time.time()
        session.step_index += 1
        db.commit()
        db.refresh(session)
        return session_view(session)
