import logging
import signal
import threading
import time
import uuid
from sqlalchemy import select, update
from sqlalchemy.exc import OperationalError, ProgrammingError
from app.agents import PROMPT_VERSION, run_simulation
from app.config import get_settings
from app.db import session_factory
from app.models import AgentMessage, AgentRun, ParticipantSession
from app.openrouter import OpenRouter, ProviderError
from app.schemas import StudyConfig
from app.clinical_worker import claim_turn, process_turn

log = logging.getLogger("worker")
LEASE_SECONDS = 180


def claim_run(factory, worker_id):
    now = time.time()
    with factory() as db:
        # Ambiguous interrupted calls are never automatically replayed or billed again.
        db.execute(update(AgentRun).where(AgentRun.status == "running", AgentRun.lease_until < now).values(
            status="interrupted", error_code="worker_lease_expired", finished_at=now))
        candidate = db.scalar(select(AgentRun.id).where(AgentRun.status == "queued")
                              .order_by(AgentRun.created_at).limit(1))
        if not candidate:
            db.commit()
            return None
        changed = db.execute(update(AgentRun).where(AgentRun.id == candidate, AgentRun.status == "queued").values(
            status="running", worker_id=worker_id, lease_until=now + LEASE_SECONDS))
        db.commit()
        return candidate if changed.rowcount == 1 else None


def process_run(factory, provider, run_id, worker_id):
    with factory() as db:
        run = db.get(AgentRun, run_id)
        participant = db.get(ParticipantSession, run.session_id)
        config = StudyConfig.model_validate(participant.snapshot)
        case = next(c for c in config.cases if c.id == run.case_id)
        model = participant.model_id
    sequence = 0

    def renew():
        with factory() as db:
            result = db.execute(update(AgentRun).where(
                AgentRun.id == run_id, AgentRun.worker_id == worker_id, AgentRun.status == "running",
                AgentRun.lease_until > time.time(),
            ).values(lease_until=time.time() + LEASE_SECONDS))
            db.commit()
            if result.rowcount != 1:
                raise ProviderError("worker_lease_lost")

    def record(role, reply):
        nonlocal sequence
        renew()
        with factory() as db:
            db.add(AgentMessage(run_id=run_id, sequence=sequence, role=role,
                                prompt_version=PROMPT_VERSION, **reply))
            db.commit()
        sequence += 1

    try:
        result = run_simulation(config, case, model, provider, record, renew)
        state = {"status": "succeeded", "result": result, "error_code": None}
    except ProviderError as exc:
        state = {"status": "failed", "error_code": str(exc)}
    except Exception:
        # Do not log case content, participant IDs, credentials or raw provider responses.
        state = {"status": "failed", "error_code": "invalid_agent_output_or_processing_error"}
    with factory() as db:
        db.execute(update(AgentRun).where(
            AgentRun.id == run_id, AgentRun.worker_id == worker_id, AgentRun.status == "running",
            AgentRun.lease_until > time.time(),
        ).values(**state, finished_at=time.time(), lease_until=None))
        db.commit()
    log.info("Run %s: %s", run_id, state["status"])


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    settings = get_settings()
    factory = session_factory()
    provider = OpenRouter(settings)
    worker_id = str(uuid.uuid4())
    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())
    while not stop.is_set():
        try:
            turn_id = claim_turn(factory, worker_id)
            if turn_id:
                process_turn(factory, provider, turn_id, worker_id)
                continue
            run_id = claim_run(factory, worker_id)
            if run_id:
                process_run(factory, provider, run_id, worker_id)
            else:
                stop.wait(settings.worker_poll_seconds)
        except (OperationalError, ProgrammingError):
            log.warning("Database unavailable; waiting for migrations or reconnection")
            stop.wait(5)


if __name__ == "__main__":
    main()
