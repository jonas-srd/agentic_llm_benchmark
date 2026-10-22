import copy
import json
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, update
from app.clinical_worker import claim_turn, process_turn
from app.main import create_app
from app.models import ClinicalCase, ClinicalTurn, ParticipantSession
from app.openrouter import ProviderError
from app.preview import demo_config
from app.schemas import StudyConfig
from tests.conftest import enroll


class Provider:
    def __init__(self):
        self.calls = []

    def complete(self, model, messages):
        self.calls.append((model, messages))
        return {"content": "The symptoms started four weeks ago.", "requested_model": model,
                "returned_model": model, "provider": "test", "generation_id": "test",
                "usage": {"total_tokens": 20}, "latency_ms": 1}


def enrolled(env, count=2):
    client, _, _ = env
    config = demo_config()
    config["cases_per_participant"] = count
    config["completion_code"] = "COMPLETE"
    state, headers = enroll(client, config)
    state = client.post(f"/v1/sessions/{state['id']}/steps/screening", headers=headers, json={
        "request_id": str(uuid.uuid4()), "revision": state["revision"],
        "answers": {"physician": True, "specialty": "Internal medicine", "years": 5}}).json()
    return state, headers


def question(client, state, headers, target="patient", tests=None):
    return client.post(f"/v1/sessions/{state['id']}/cases/{state['step']['id']}/questions", headers=headers,
        json={"request_id": str(uuid.uuid4()), "revision": state["revision"], "target": target,
              "question": "When did it start?" if target == "patient" else "", "tests": tests or []})


def test_three_rounds_fixed_model_context_separation_and_export(env):
    client, factory, _ = env
    state, headers = enrolled(env)
    path = f"/v1/sessions/{state['id']}/cases/{state['step']['id']}"
    public = client.get(path, headers=headers).json()
    assert public["rounds_used"] == 0
    assert not {"patient_facts", "reference_diagnosis", "model_id", "source_id"} & public.keys()
    provider = Provider()
    for i in range(3):
        result = question(client, state, headers, "lab" if i == 1 else "patient",
                          public["available_tests"][:1] if i == 1 else None)
        assert result.status_code == 202, result.text
        state = result.json()["session"]
        run = claim_turn(factory, "worker")
        assert run
        assert question(client, state, headers).status_code == 409
        pending_diagnosis = client.post(path + "/diagnosis", headers=headers, json={
            "request_id": str(uuid.uuid4()), "revision": state["revision"], "diagnosis": "Test", "confidence": 80})
        assert pending_diagnosis.status_code == 409
        process_turn(factory, provider, run, "worker")
    assert question(client, state, headers).status_code == 409
    public = client.get(path, headers=headers).json()
    assert public["rounds_used"] == 3 and not public["can_ask"]
    with factory() as db:
        stored = db.get(ParticipantSession, state["id"])
        case = stored.snapshot["cases"][0]
        assert len(stored.snapshot["cases"]) == 2
        assert len({c["id"] for c in stored.snapshot["cases"]}) == 2
        assert all(c[0] == stored.model_id for c in provider.calls)
        lab_input = json.loads(provider.calls[1][1][1]["content"])
        assert lab_input == {"requested_results": {public["available_tests"][0]: case["labs"][public["available_tests"][0]]}}
        patient_input = json.loads(provider.calls[0][1][1]["content"])
        assert set(patient_input) == {"patient_facts", "question", "previous_questions"}
        assert patient_input["patient_facts"] == case["patient_facts"]
    body = {"request_id": str(uuid.uuid4()), "revision": state["revision"], "diagnosis": "Test diagnosis", "confidence": 83}
    result = client.post(path + "/diagnosis", headers=headers, json=body)
    assert result.status_code == 200
    assert result.json()["completed_cases"] == 1
    assert client.post(path + "/diagnosis", headers=headers, json=body).status_code == 200
    body["diagnosis"] = "Changed"
    assert client.post(path + "/diagnosis", headers=headers, json=body).status_code == 409
    exported = client.get("/v1/admin/studies/clinician-demo-v1/export", headers={"X-Admin-Key": "a" * 40}).json()
    case_export = exported["sessions"][0]["clinical_cases"][0]
    assert case_export["diagnosis"] == "Test diagnosis"
    assert case_export["turns"][1]["metadata"]["prompt_version"] == "clinician-interaction-v1"
    assert case_export["reference_diagnosis"]


def test_early_diagnosis_skip_blocked_and_final_inclusion(env):
    client, _, _ = env
    state, headers = enrolled(env, 1)
    base = f"/v1/sessions/{state['id']}"
    assert client.post(f"{base}/steps/{state['step']['id']}", headers=headers, json={
        "request_id": str(uuid.uuid4()), "revision": state["revision"], "answers": {}}).status_code == 409
    result = client.post(f"{base}/cases/{state['step']['id']}/diagnosis", headers=headers, json={
        "request_id": str(uuid.uuid4()), "revision": state["revision"], "diagnosis": "Early answer", "confidence": 60})
    assert result.status_code == 200
    state = result.json()
    assert state["completed_cases"] == 1
    assert "completion_url" not in state
    assert state["step"]["kind"] == "final_check"
    result = client.post(f"{base}/steps/final", headers=headers, json={"request_id": str(uuid.uuid4()),
        "revision": state["revision"], "answers": {}, "include_in_analysis": False})
    assert result.status_code == 200
    assert result.json()["status"] == "completed"
    assert result.json()["include_in_analysis"] is False
    assert result.json()["completion_url"].endswith("cc=COMPLETE")


def test_question_idempotency_ownership_and_concurrency(env):
    client, factory, _ = env
    state, headers = enrolled(env)
    path = f"/v1/sessions/{state['id']}/cases/{state['step']['id']}"
    body = {"request_id": str(uuid.uuid4()), "revision": state["revision"], "target": "patient", "question": "Duration?"}
    assert client.post(path + "/questions", headers=headers, json=body).status_code == 202
    assert client.post(path + "/questions", headers=headers, json=body).status_code == 202
    assert client.get(path).status_code == 401
    with ThreadPoolExecutor(max_workers=4) as pool:
        claims = list(pool.map(lambda i: claim_turn(factory, str(i)), range(4)))
    assert len([c for c in claims if c]) == 1
    body["question"] = "Different?"
    assert client.post(path + "/questions", headers=headers, json=body).status_code == 409
    with factory() as db:
        assert len(db.scalars(select(ClinicalTurn)).all()) == 1


def test_parallel_questions_cannot_reserve_two_rounds(env):
    client, factory, _ = env
    state, headers = enrolled(env)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: question(client, state, headers).status_code, range(2)))
    assert sorted(results) == [202, 409]
    with factory() as db:
        assert len(db.scalars(select(ClinicalTurn)).all()) == 1
        attempt = db.scalar(select(ClinicalCase).where(ClinicalCase.step_id == state["step"]["id"]))
        assert attempt.rounds_used == 1


def test_failed_round_is_refunded_and_stale_claim_not_replayed(env):
    client, factory, _ = env
    state, headers = enrolled(env)
    class Broken:
        def complete(self, *args):
            raise ProviderError("openrouter_timeout")
    result = question(client, state, headers)
    state = result.json()["session"]
    turn_id = claim_turn(factory, "worker")
    process_turn(factory, Broken(), turn_id, "worker")
    result = question(client, state, headers)
    assert result.status_code == 202
    assert result.json()["case"]["rounds_used"] == 1
    state = result.json()["session"]
    turn_id = claim_turn(factory, "worker")
    with factory() as db:
        db.execute(update(ClinicalTurn).where(ClinicalTurn.id == turn_id).values(lease_until=time.time()-1))
        db.commit()
    assert claim_turn(factory, "worker2") is None
    assert claim_turn(factory, "worker3") is None
    with factory() as db:
        assert db.get(ClinicalTurn, turn_id).status == "interrupted"
        assert db.scalar(select(ClinicalCase).where(ClinicalCase.step_id == state["step"]["id"])).rounds_used == 0
    provider = Provider()
    process_turn(factory, provider, turn_id, "worker")
    assert provider.calls == []


def test_pool_150_assignment_and_preview_access(env):
    client, factory, settings = env
    config = demo_config()
    case = config["cases"][0]
    config["cases"] = [{**copy.deepcopy(case), "id": f"case-{i}"} for i in range(150)]
    config["cases_per_participant"] = 5
    StudyConfig.model_validate(config)
    state, headers = enroll(client, config)
    assert state["total_cases"] == 5
    with factory() as db:
        assert len(db.get(ParticipantSession, state["id"]).snapshot["cases"]) == 5
    config["cases"].append({**case, "id": "extra"})
    with pytest.raises(ValueError):
        StudyConfig.model_validate(config)
    assert client.get("/v1/preview").status_code == 404  # TestClient is not loopback.
    with TestClient(create_app(settings, factory), client=("127.0.0.1", 50000)) as local:
        assert local.get("/v1/preview").status_code == 200
        assert local.post("/v1/preview/sessions", json={"consent": True}, headers={"Origin": "https://other.example"}).status_code == 403
        assert local.post("/v1/preview/sessions", json={"consent": True}).status_code == 201
    settings.app_env = "production"
    with TestClient(create_app(settings, factory), client=("127.0.0.1", 50000)) as production:
        assert production.get("/v1/preview").status_code == 404
    assert client.post("/v1/admin/studies/clinician-demo-v1/activate", headers={"X-Admin-Key": "a" * 40}).status_code == 409


def test_frontend_served_same_origin_without_dataset_answers(env):
    client, _, _ = env
    root = client.get("/")
    assert root.status_code == 200 and "text/html" in root.headers["content-type"]
    assert "frame-ancestors 'none'" in root.headers["content-security-policy"]
    assert client.get("/study/example").status_code == 200
    script = client.get("/assets/app.js")
    assert script.status_code == 200
    assert "reference_diagnosis" not in script.text
    assert "patient_facts" not in script.text
