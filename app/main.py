import secrets
import time
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import select, text, update
from sqlalchemy.exc import IntegrityError
from app.config import get_settings
from app.db import session_factory
from app.models import AgentMessage, AgentRun, ParticipantSession, StepResponse, Study
from app.schemas import Answer, Enroll, MODEL_IDS, StudyConfig
from app.security import check_admin, check_session, issue_token


def public_step(session):
    steps = session.snapshot["steps"]
    if session.step_index >= len(steps):
        return None
    step = dict(steps[session.step_index])
    step.pop("case_id", None)
    return step


def session_view(session):
    result = {"id": session.id, "status": session.status, "step_index": session.step_index,
              "total_steps": len(session.snapshot["steps"]), "revision": session.revision,
              "step": public_step(session), "include_in_analysis": session.include_in_analysis}
    if session.status == "completed":
        code = session.snapshot.get("completion_code")
        result["completion_url"] = f"https://app.prolific.com/submissions/complete?cc={code}" if code else None
    return result


def validate_answers(step, payload):
    questions = {q["id"]: q for q in step["questions"]}
    if set(payload) - set(questions):
        raise HTTPException(422, "Unknown question")
    for key, question in questions.items():
        value = payload.get(key)
        if value is None or value == "":
            if question["required"]:
                raise HTTPException(422, f"Answer required: {key}")
            continue
        kind = question["kind"]
        valid = (kind == "boolean" and isinstance(value, bool)) or (
            kind == "text" and isinstance(value, str) and len(value) <= 6000
        ) or (kind == "choice" and isinstance(value, str) and value in question["options"])
        if kind == "number":
            valid = isinstance(value, (int, float)) and not isinstance(value, bool)
            if valid:
                valid = (question["minimum"] is None or value >= question["minimum"]) and (
                    question["maximum"] is None or value <= question["maximum"])
        if not valid:
            raise HTTPException(422, f"Invalid answer: {key}")


def create_app(settings=None, factory=None):
    settings = settings or get_settings()
    factory = factory or session_factory()
    app = FastAPI(title="Agentic LLM Benchmark API", version="0.1.0", docs_url="/docs", redoc_url=None)
    app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins,
                       allow_methods=["GET", "POST"],
                       allow_headers=["Authorization", "Content-Type", "X-Admin-Key"])

    @app.middleware("http")
    async def limits_and_headers(request: Request, call_next):
        # Count the actual streamed body, including requests without Content-Length.
        if request.method in ("POST", "PUT", "PATCH"):
            chunks, size = [], 0
            async for chunk in request.stream():
                size += len(chunk)
                if size > 256_000:
                    return JSONResponse({"detail": "Request too large"}, status_code=413)
                chunks.append(chunk)
            request._body = b"".join(chunks)
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        return response

    def database():
        with factory() as db:
            yield db

    def admin(x_admin_key: str | None = Header(default=None)):
        check_admin(x_admin_key, settings)

    def owned(db, session_id, authorization):
        session = db.get(ParticipantSession, session_id)
        check_session(authorization, session, settings)
        return session

    @app.get("/")
    def root():
        return {"service": "Agentic LLM Benchmark", "version": "0.1.0", "docs": "/docs"}

    @app.get("/health/live")
    def live():
        return {"status": "ok"}

    @app.get("/health/ready")
    def ready(db=Depends(database)):
        try:
            db.execute(text("SELECT version_num FROM alembic_version"))
        except Exception:
            return JSONResponse({"status": "not_ready"}, status_code=503)
        return {"status": "ready"}

    @app.get("/v1/admin/models", dependencies=[Depends(admin)])
    def models():
        return {"models": list(MODEL_IDS), "assignment": "one_model_per_session_all_roles"}

    @app.post("/v1/admin/studies", dependencies=[Depends(admin)], status_code=201)
    def create_study(config: StudyConfig, db=Depends(database)):
        study = Study(id=config.id, config=config.model_dump(), active=False)
        db.add(study)
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            raise HTTPException(409, "Study ID already exists; create a new version with a new ID") from None
        return {"id": study.id, "active": False}

    @app.post("/v1/admin/studies/{study_id}/activate", dependencies=[Depends(admin)])
    def activate(study_id: str, db=Depends(database)):
        study = db.get(Study, study_id)
        if not study:
            raise HTTPException(404, "Study not found")
        if not study.config.get("prolific_study_id") or not study.config.get("completion_code"):
            raise HTTPException(409, "Set Prolific study ID and completion code in a new study configuration")
        if not settings.openrouter_api_key.get_secret_value():
            raise HTTPException(409, "OpenRouter is not configured")
        study.active = True
        db.commit()
        return {"active": True}

    @app.post("/v1/admin/studies/{study_id}/pause", dependencies=[Depends(admin)])
    def pause(study_id: str, db=Depends(database)):
        study = db.get(Study, study_id)
        if not study:
            raise HTTPException(404, "Study not found")
        study.active = False
        db.commit()
        return {"active": False}

    @app.get("/v1/studies/{study_id}")
    def study_info(study_id: str, x_admin_key: str | None = Header(default=None), db=Depends(database)):
        study = db.get(Study, study_id)
        if not study:
            raise HTTPException(404, "Study not found")
        if not study.active:
            check_admin(x_admin_key, settings)
        c = study.config
        return {"id": study.id, "title": c["title"], "version": c["version"],
                "consent_version": c["consent_version"], "consent_text": c["consent_text"],
                "steps": [{k: s[k] for k in ("id", "title", "kind")} for s in c["steps"]]}

    @app.post("/v1/studies/{study_id}/sessions", status_code=201)
    def enroll(study_id: str, body: Enroll, x_admin_key: str | None = Header(default=None),
               db=Depends(database)):
        study = db.get(Study, study_id)
        if not study:
            raise HTTPException(404, "Study not found")
        if not study.active:
            check_admin(x_admin_key, settings)
        config = study.config
        if config["prolific_study_id"] and body.STUDY_ID != config["prolific_study_id"]:
            raise HTTPException(422, "Prolific study ID mismatch")
        if body.consent_version != config["consent_version"]:
            raise HTTPException(409, "Consent version changed; reload the study")
        # Atomic cap survives multiple API replicas; rollback also undoes duplicate enrolments.
        reserved = db.execute(update(Study).where(
            Study.id == study_id, Study.enrolled < config["max_participants"]
        ).values(enrolled=Study.enrolled + 1))
        if reserved.rowcount != 1:
            raise HTTPException(409, "Study capacity reached")
        token, token_hash = issue_token(settings.session_secret.get_secret_value())
        participant = ParticipantSession(
            study_id=study_id, prolific_pid=body.PROLIFIC_PID, prolific_study_id=body.STUDY_ID,
            prolific_session_id=body.SESSION_ID, token_hash=token_hash,
            model_id=secrets.choice(config["models"]), condition=secrets.choice(config["conditions"]),
            snapshot=config,
        )
        db.add(participant)
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            raise HTTPException(409, "Already enrolled; resume with your stored session token") from None
        return {**session_view(participant), "session_token": token}

    @app.get("/v1/sessions/{session_id}")
    def get_session(session_id: str, authorization: str | None = Header(default=None), db=Depends(database)):
        return session_view(owned(db, session_id, authorization))

    @app.post("/v1/sessions/{session_id}/steps/{step_id}")
    def answer(session_id: str, step_id: str, body: Answer,
               authorization: str | None = Header(default=None), db=Depends(database)):
        session = owned(db, session_id, authorization)
        previous = db.scalar(select(StepResponse).where(
            StepResponse.session_id == session_id, StepResponse.step_id == step_id))
        payload = {"answers": body.answers, "include_in_analysis": body.include_in_analysis}
        if previous:
            if previous.request_id == body.request_id and previous.payload == payload:
                return session_view(session)
            raise HTTPException(409, "Step already submitted")
        step = public_step(session)
        if not step or step["id"] != step_id or session.status != "active":
            raise HTTPException(409, "Submit the current step in order")
        validate_answers(step, body.answers)
        if step["kind"] == "final_check" and body.include_in_analysis is None:
            raise HTTPException(422, "Analysis inclusion choice required")
        if step["kind"] != "final_check" and body.include_in_analysis is not None:
            raise HTTPException(422, "Analysis inclusion belongs to final_check")
        if step["kind"] == "simulation":
            run = db.scalar(select(AgentRun).where(AgentRun.session_id == session_id, AgentRun.step_id == step_id))
            if not run or run.status != "succeeded":
                raise HTTPException(409, "Complete the simulation first")
        values = {"step_index": session.step_index + 1, "revision": ParticipantSession.revision + 1}
        if step["kind"] == "final_check":
            values.update(include_in_analysis=body.include_in_analysis, status="completed", completed_at=time.time())
        changed = db.execute(update(ParticipantSession).where(
            ParticipantSession.id == session_id, ParticipantSession.revision == body.revision
        ).values(**values))
        if changed.rowcount != 1:
            raise HTTPException(409, "Session changed; reload before submitting")
        db.add(StepResponse(session_id=session_id, step_id=step_id, request_id=body.request_id, payload=payload))
        db.commit()
        db.refresh(session)
        return session_view(session)

    @app.post("/v1/sessions/{session_id}/runs", status_code=202)
    def queue_run(session_id: str, authorization: str | None = Header(default=None), db=Depends(database)):
        session = owned(db, session_id, authorization)
        step = public_step(session)
        if not step or step["kind"] != "simulation" or session.status != "active":
            raise HTTPException(409, "No simulation at the current step")
        run = db.scalar(select(AgentRun).where(AgentRun.session_id == session_id, AgentRun.step_id == step["id"]))
        if not run:
            run = AgentRun(session_id=session_id, step_id=step["id"],
                           case_id=session.snapshot["steps"][session.step_index]["case_id"])
            db.add(run)
            try:
                db.commit()
            except IntegrityError:
                db.rollback()
                run = db.scalar(select(AgentRun).where(
                    AgentRun.session_id == session_id, AgentRun.step_id == step["id"]))
        return {"id": run.id, "status": run.status}

    @app.get("/v1/sessions/{session_id}/runs/{run_id}")
    def get_run(session_id: str, run_id: str, authorization: str | None = Header(default=None),
                db=Depends(database)):
        owned(db, session_id, authorization)
        run = db.get(AgentRun, run_id)
        if not run or run.session_id != session_id:
            raise HTTPException(404, "Run not found")
        messages = db.scalars(select(AgentMessage).where(AgentMessage.run_id == run.id).order_by(AgentMessage.sequence))
        return {"id": run.id, "status": run.status, "result": run.result, "error_code": run.error_code,
                "messages": [{"sequence": m.sequence, "role": m.role, "content": m.content} for m in messages]}

    @app.get("/v1/admin/studies/{study_id}/export", dependencies=[Depends(admin)])
    def export(study_id: str, offset: int = 0, limit: int = 50, db=Depends(database)):
        if offset < 0 or not 1 <= limit <= 100:
            raise HTTPException(422, "Invalid pagination")
        if not db.get(Study, study_id):
            raise HTTPException(404, "Study not found")
        sessions = db.scalars(select(ParticipantSession).where(
            ParticipantSession.study_id == study_id).order_by(ParticipantSession.created_at, ParticipantSession.id)
            .offset(offset).limit(limit))
        output = []
        for session in sessions:
            item = {**session_view(session), "prolific_pid": session.prolific_pid,
                    "prolific_study_id": session.prolific_study_id, "prolific_session_id": session.prolific_session_id,
                    "model_id": session.model_id, "condition": session.condition,
                    "created_at": session.created_at, "completed_at": session.completed_at,
                    "consent_version": session.snapshot["consent_version"], "study_version": session.snapshot["version"],
                    "responses": [], "runs": []}
            for r in db.scalars(select(StepResponse).where(StepResponse.session_id == session.id)):
                item["responses"].append({"step_id": r.step_id, "payload": r.payload, "created_at": r.created_at})
            for run in db.scalars(select(AgentRun).where(AgentRun.session_id == session.id)):
                case = next(c for c in session.snapshot["cases"] if c["id"] == run.case_id)
                messages = db.scalars(select(AgentMessage).where(AgentMessage.run_id == run.id)
                                      .order_by(AgentMessage.sequence))
                item["runs"].append({"id": run.id, "step_id": run.step_id, "case_id": run.case_id,
                    "status": run.status, "result": run.result, "error_code": run.error_code,
                    "reference_diagnosis": case["reference_diagnosis"],
                    "messages": [{k: getattr(m, k) for k in ("sequence", "role", "content", "requested_model",
                        "returned_model", "provider", "generation_id", "usage", "latency_ms", "prompt_version",
                        "created_at")} for m in messages]})
            output.append(item)
        return {"sessions": output, "next_offset": offset + limit if len(output) == limit else None}

    return app
