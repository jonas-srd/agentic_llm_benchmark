import type { Database } from "./db.js";
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
      "CREATE INDEX IF NOT EXISTS ix_clinical_queue ON clinical_turns(status,created_at)",
      "CREATE INDEX IF NOT EXISTS ix_agent_queue ON runs(status,created_at)",
      "CREATE INDEX IF NOT EXISTS ix_study_events_session ON study_events(session_id,created_at)",
      "INSERT INTO app_migrations(version) VALUES ($1) ON CONFLICT(version) DO NOTHING",
    ];
    for (const sql of statements)
      await tx.query(sql, sql.includes("$1") ? ["001_typescript_study"] : []);
  });
}
