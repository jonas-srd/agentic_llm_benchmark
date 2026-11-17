import { randomUUID } from "node:crypto";
import {
  CLINICAL_PROTOCOL,
  CLINICAL_ROUNDS,
  CONFIDENCE_SCALE,
  confidenceDraft,
  POST_SURVEY_ID,
  LEGACY_POST_SURVEY_STEP,
  LEGACY_POST_SURVEY_VERSION,
  POST_SURVEY_STEPS,
  isPostSurvey,
  POST_SURVEY_VERSION,
} from "@clinical/shared";
import { insert, now, type Database } from "./db.js";
import { allocationScope, caseKey } from "../domain/protocol.js";
export async function migrate(db: Database) {
  const j = db.postgres ? "JSONB" : "JSON";
  const f = db.postgres ? "DOUBLE PRECISION" : "REAL";
  await db.tx(async (tx) => {
    const statements = [
      "CREATE TABLE IF NOT EXISTS app_migrations (version TEXT PRIMARY KEY)",
      `CREATE TABLE IF NOT EXISTS studies(id TEXT PRIMARY KEY,config ${j} NOT NULL,active BOOLEAN NOT NULL,enrolled INTEGER NOT NULL,created_at ${f} NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,study_id TEXT NOT NULL REFERENCES studies(id),prolific_pid TEXT NOT NULL,prolific_study_id TEXT NOT NULL,prolific_session_id TEXT NOT NULL,token_hash TEXT NOT NULL,model_id TEXT NOT NULL,condition TEXT NOT NULL,snapshot ${j} NOT NULL,step_index INTEGER NOT NULL,revision INTEGER NOT NULL,status TEXT NOT NULL,include_in_analysis BOOLEAN,created_at ${f} NOT NULL,completed_at ${f},UNIQUE(study_id,prolific_pid))`,
      `CREATE TABLE IF NOT EXISTS responses(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id),step_id TEXT NOT NULL,request_id TEXT NOT NULL,payload ${j} NOT NULL,created_at ${f} NOT NULL,UNIQUE(session_id,step_id))`,
      `CREATE TABLE IF NOT EXISTS clinical_cases(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id),step_id TEXT NOT NULL,case_id TEXT NOT NULL,rounds_used INTEGER NOT NULL,diagnosis TEXT,confidence INTEGER,diagnosis_request_id TEXT,started_at ${f},completed_at ${f},UNIQUE(session_id,step_id))`,
      `CREATE TABLE IF NOT EXISTS clinical_turns(id TEXT PRIMARY KEY,case_attempt_id TEXT NOT NULL REFERENCES clinical_cases(id),request_id TEXT NOT NULL,round_number INTEGER NOT NULL,target TEXT NOT NULL,question TEXT NOT NULL,tests ${j} NOT NULL,status TEXT NOT NULL,response TEXT,metadata_json ${j},error_code TEXT,worker_id TEXT,lease_until ${f},created_at ${f} NOT NULL,finished_at ${f},UNIQUE(case_attempt_id,request_id))`,
      `CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id),step_id TEXT NOT NULL,case_id TEXT NOT NULL,status TEXT NOT NULL,lease_until ${f},worker_id TEXT,error_code TEXT,result ${j},created_at ${f} NOT NULL,finished_at ${f},UNIQUE(session_id,step_id))`,
      `CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),sequence INTEGER NOT NULL,role TEXT NOT NULL,content TEXT NOT NULL,requested_model TEXT NOT NULL,returned_model TEXT NOT NULL,provider TEXT,generation_id TEXT,usage ${j} NOT NULL,latency_ms INTEGER NOT NULL,prompt_version TEXT NOT NULL,created_at ${f} NOT NULL,UNIQUE(run_id,sequence))`,
      `CREATE TABLE IF NOT EXISTS task_drafts(session_id TEXT NOT NULL REFERENCES sessions(id),step_id TEXT NOT NULL,data ${j} NOT NULL,revision INTEGER NOT NULL,updated_at ${f} NOT NULL,PRIMARY KEY(session_id,step_id))`,
      `CREATE TABLE IF NOT EXISTS study_events(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id),step_id TEXT NOT NULL,event_type TEXT NOT NULL,data ${j} NOT NULL,created_at ${f} NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS case_media(id TEXT PRIMARY KEY,mime_type TEXT NOT NULL,data_base64 TEXT NOT NULL,created_at ${f} NOT NULL)`,
      "CREATE TABLE IF NOT EXISTS allocation_locks(scope TEXT PRIMARY KEY)",
      `CREATE TABLE IF NOT EXISTS case_allocations(scope TEXT NOT NULL,case_key TEXT NOT NULL,session_id TEXT NOT NULL REFERENCES sessions(id),case_id TEXT NOT NULL,created_at ${f} NOT NULL,PRIMARY KEY(scope,case_key))`,
      `CREATE TABLE IF NOT EXISTS study_timings(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id),step_id TEXT NOT NULL,phase TEXT NOT NULL,round_number INTEGER NOT NULL,elapsed_ms INTEGER NOT NULL,active_ms INTEGER NOT NULL,created_at ${f} NOT NULL,updated_at ${f} NOT NULL)`,
      "CREATE INDEX IF NOT EXISTS ix_study_timings_session ON study_timings(session_id,step_id)",
      "CREATE INDEX IF NOT EXISTS ix_clinical_queue ON clinical_turns(status,created_at)",
      "CREATE INDEX IF NOT EXISTS ix_agent_queue ON runs(status,created_at)",
      "CREATE INDEX IF NOT EXISTS ix_study_events_session ON study_events(session_id,created_at)",
      "INSERT INTO app_migrations(version) VALUES ($1) ON CONFLICT(version) DO NOTHING",
    ];
    for (const sql of statements)
      await tx.query(sql, sql.includes("$1") ? ["001_typescript_study"] : []);
    const applied = await tx.query(
      "SELECT version FROM app_migrations WHERE version=$1",
      ["002_exclusive_cases_timing"],
    );
    if (!applied.rows.length) {
      // Reserve previously assigned cases too; never free an abandoned doctor's cases.
      const sessions = (
        await tx.query(
          "SELECT id,study_id,snapshot,created_at FROM sessions ORDER BY created_at,id",
        )
      ).rows;
      for (const s of sessions) {
        const scope = allocationScope(s.snapshot);
        if (!scope) continue;
        for (const c of s.snapshot.cases)
          await tx.query(
            "INSERT INTO case_allocations(scope,case_key,session_id,case_id,created_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(scope,case_key) DO NOTHING",
            [scope, caseKey({ id: s.study_id }, c), s.id, c.id, s.created_at],
          );
      }
      await tx.query(
        "INSERT INTO app_migrations(version) VALUES($1) ON CONFLICT(version) DO NOTHING",
        ["002_exclusive_cases_timing"],
      );
    }
    const ranked = await tx.query(
      "SELECT version FROM app_migrations WHERE version=$1",
      ["003_ranked_diagnoses"],
    );
    if (!ranked.rows.length) {
      await tx.query(
        `ALTER TABLE clinical_cases ADD COLUMN diagnoses_json ${j}`,
      );
      await tx.query("INSERT INTO app_migrations(version) VALUES($1)", [
        "003_ranked_diagnoses",
      ]);
    }
    await tx.query(`CREATE TABLE IF NOT EXISTS diagnosis_judgments(
      id TEXT PRIMARY KEY,
      case_attempt_id TEXT UNIQUE REFERENCES clinical_cases(id),
      run_id TEXT UNIQUE REFERENCES runs(id),
      payload ${j} NOT NULL, prompt_version TEXT NOT NULL, model_id TEXT NOT NULL,
      status TEXT NOT NULL, result ${j}, error_code TEXT, worker_id TEXT,
      lease_until ${f}, created_at ${f} NOT NULL, finished_at ${f},
      CHECK ((case_attempt_id IS NOT NULL AND run_id IS NULL) OR (case_attempt_id IS NULL AND run_id IS NOT NULL)))`);
    await tx.query(
      "CREATE INDEX IF NOT EXISTS ix_judgment_queue ON diagnosis_judgments(status,created_at)",
    );
    await tx.query(
      "INSERT INTO app_migrations(version) VALUES($1) ON CONFLICT(version) DO NOTHING",
      ["004_diagnosis_judge"],
    );
    const confidenceMigration = await tx.query(
      "SELECT version FROM app_migrations WHERE version=$1",
      ["005_confidence_post_survey"],
    );
    if (!confidenceMigration.rows.length) {
      await tx.query(
        "ALTER TABLE clinical_cases ADD COLUMN confidence_scale TEXT NOT NULL DEFAULT 'percent_0_100'",
      );
      for (const session of (
        await tx.query("SELECT * FROM sessions WHERE status='active'")
      ).rows) {
        if (session.snapshot.workflow !== "clinician") continue;
        const snapshot = structuredClone(session.snapshot);
        const finalIndex = snapshot.steps.findIndex(
          (step: any) => step.kind === "final_check",
        );
        if (finalIndex < 0)
          throw new Error("Active clinician session has no final check");
        if (!snapshot.steps.some((step: any) => step.id === POST_SURVEY_ID))
          snapshot.steps.splice(finalIndex, 0, LEGACY_POST_SURVEY_STEP);
        snapshot.clinical_protocol_version = "patient-only-top3-likert-v3";
        snapshot.post_survey_version = LEGACY_POST_SURVEY_VERSION;
        await tx.query(
          "UPDATE sessions SET snapshot=$1,revision=revision+1 WHERE id=$2",
          [snapshot, session.id],
        );
        await tx.query(
          "UPDATE clinical_cases SET confidence_scale=$1 WHERE session_id=$2 AND completed_at IS NULL",
          [CONFIDENCE_SCALE, session.id],
        );
        await insert(tx, "study_events", {
          id: randomUUID(),
          session_id: session.id,
          step_id: snapshot.steps[session.step_index]?.id || "intro",
          event_type: "confidence_protocol_updated",
          created_at: now(),
          data: {
            previous_protocol:
              session.snapshot.clinical_protocol_version || null,
            protocol_version: "patient-only-top3-likert-v3",
            post_survey_version: LEGACY_POST_SURVEY_VERSION,
          },
        });
        for (const draft of (
          await tx.query(
            "SELECT d.* FROM task_drafts d JOIN clinical_cases a ON a.session_id=d.session_id AND a.step_id=d.step_id WHERE d.session_id=$1 AND a.completed_at IS NULL",
            [session.id],
          )
        ).rows) {
          await insert(tx, "study_events", {
            id: randomUUID(),
            session_id: session.id,
            step_id: draft.step_id,
            event_type: "legacy_diagnosis_draft_preserved",
            created_at: now(),
            data: draft.data,
          });
          const diagnoses = confidenceDraft(
            draft.data.diagnoses ||
              (draft.data.diagnosis
                ? [{ diagnosis: draft.data.diagnosis }]
                : []),
            3,
          );
          await tx.query(
            "UPDATE task_drafts SET data=$1,revision=revision+1,updated_at=$2 WHERE session_id=$3 AND step_id=$4",
            [{ ...draft.data, diagnoses }, now(), session.id, draft.step_id],
          );
        }
      }
      await tx.query("INSERT INTO app_migrations(version) VALUES($1)", [
        "005_confidence_post_survey",
      ]);
    }
    const singleDiagnosis = await tx.query(
      "SELECT version FROM app_migrations WHERE version=$1",
      ["006_single_diagnosis"],
    );
    if (!singleDiagnosis.rows.length) {
      for (const session of (
        await tx.query("SELECT * FROM sessions WHERE status='active'")
      ).rows) {
        if (session.snapshot.workflow !== "clinician") continue;
        const snapshot = {
          ...session.snapshot,
          clinical_protocol_version: "patient-only-top1-likert-v4",
        };
        await tx.query(
          "UPDATE sessions SET snapshot=$1,revision=revision+1 WHERE id=$2",
          [snapshot, session.id],
        );
        await insert(tx, "study_events", {
          id: randomUUID(),
          session_id: session.id,
          step_id: snapshot.steps[session.step_index]?.id || "intro",
          event_type: "single_diagnosis_protocol_updated",
          created_at: now(),
          data: {
            previous_protocol:
              session.snapshot.clinical_protocol_version || null,
            protocol_version: "patient-only-top1-likert-v4",
          },
        });
        for (const draft of (
          await tx.query(
            "SELECT d.* FROM task_drafts d JOIN clinical_cases a ON a.session_id=d.session_id AND a.step_id=d.step_id WHERE d.session_id=$1 AND a.completed_at IS NULL",
            [session.id],
          )
        ).rows) {
          if (draft.data.diagnoses?.length === 1) continue;
          await insert(tx, "study_events", {
            id: randomUUID(),
            session_id: session.id,
            step_id: draft.step_id,
            event_type: "ranked_diagnosis_draft_preserved",
            created_at: now(),
            data: draft.data,
          });
          await tx.query(
            "UPDATE task_drafts SET data=$1,revision=revision+1,updated_at=$2 WHERE session_id=$3 AND step_id=$4",
            [
              {
                ...draft.data,
                diagnoses: confidenceDraft(
                  draft.data.diagnoses ||
                    (draft.data.diagnosis
                      ? [{ diagnosis: draft.data.diagnosis }]
                      : []),
                ),
              },
              now(),
              session.id,
              draft.step_id,
            ],
          );
        }
      }
      await tx.query("INSERT INTO app_migrations(version) VALUES($1)", [
        "006_single_diagnosis",
      ]);
    }
    const threeRounds = await tx.query(
      "SELECT version FROM app_migrations WHERE version=$1",
      ["007_three_question_rounds"],
    );
    if (!threeRounds.rows.length) {
      for (const session of (
        await tx.query("SELECT * FROM sessions WHERE status='active'")
      ).rows) {
        if (session.snapshot.workflow !== "clinician") continue;
        const snapshot = {
          ...session.snapshot,
          max_question_rounds: CLINICAL_ROUNDS,
          clinical_protocol_version: CLINICAL_PROTOCOL,
        };
        await tx.query(
          "UPDATE sessions SET snapshot=$1,revision=revision+1 WHERE id=$2",
          [snapshot, session.id],
        );
        await insert(tx, "study_events", {
          id: randomUUID(),
          session_id: session.id,
          step_id: snapshot.steps[session.step_index]?.id || "intro",
          event_type: "question_round_limit_updated",
          created_at: now(),
          data: {
            previous_protocol:
              session.snapshot.clinical_protocol_version || null,
            previous_max_rounds: session.snapshot.max_question_rounds || 5,
            protocol_version: CLINICAL_PROTOCOL,
            max_rounds: CLINICAL_ROUNDS,
          },
        });
      }
      await tx.query("INSERT INTO app_migrations(version) VALUES($1)", [
        "007_three_question_rounds",
      ]);
    }
    const surveyPages = await tx.query(
      "SELECT version FROM app_migrations WHERE version=$1",
      ["008_survey_pages_and_sources"],
    );
    if (!surveyPages.rows.length) {
      for (const session of (
        await tx.query("SELECT * FROM sessions WHERE status='active'")
      ).rows) {
        if (
          session.snapshot.workflow !== "clinician" ||
          session.snapshot.post_survey_version === POST_SURVEY_VERSION
        )
          continue;
        const snapshot = structuredClone(session.snapshot);
        const surveyIndex = snapshot.steps.findIndex((step: any) =>
          isPostSurvey(step.id),
        );
        // Keep an already reached survey, including any browser draft, on its original instrument.
        if (surveyIndex < 0 || session.step_index >= surveyIndex) continue;
        const responses = (
          await tx.query("SELECT step_id FROM responses WHERE session_id=$1", [
            session.id,
          ])
        ).rows;
        if (responses.some((response) => isPostSurvey(response.step_id)))
          continue;
        const currentId = snapshot.steps[session.step_index].id;
        snapshot.steps = snapshot.steps.filter(
          (step: any) => !isPostSurvey(step.id),
        );
        const finalIndex = snapshot.steps.findIndex(
          (step: any) => step.kind === "final_check",
        );
        if (finalIndex < 0)
          throw new Error("Active clinician session has no final check");
        snapshot.steps.splice(finalIndex, 0, ...POST_SURVEY_STEPS);
        snapshot.post_survey_version = POST_SURVEY_VERSION;
        await tx.query(
          "UPDATE sessions SET snapshot=$1,step_index=$2,revision=revision+1 WHERE id=$3",
          [
            snapshot,
            snapshot.steps.findIndex((step: any) => step.id === currentId),
            session.id,
          ],
        );
        await insert(tx, "study_events", {
          id: randomUUID(),
          session_id: session.id,
          step_id: currentId,
          event_type: "post_survey_updated",
          created_at: now(),
          data: {
            previous_version: session.snapshot.post_survey_version || null,
            post_survey_version: POST_SURVEY_VERSION,
          },
        });
      }
      await tx.query("INSERT INTO app_migrations(version) VALUES($1)", [
        "008_survey_pages_and_sources",
      ]);
    }
  });
}
