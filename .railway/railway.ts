import { defineRailway, postgres, preserve, project, service, volume } from "railway/iac";

// Secrets are set in Railway before the first apply; they never enter this file.
// Services are uploaded from this repository with `railway up --service <name>`.
export default defineRailway(() => {
  const database = postgres("Postgres");
  const databaseVolume = volume("postgres-volume", {
    region: "sfo",
    sizeMB: 5000,
  });
  const commonDeploy = {
    restartPolicyMaxRetries: 5,
    multiRegionConfig: { sfo: { numReplicas: 1 } },
  };
  const api = service("api", {
    build: { builder: "DOCKERFILE", dockerfilePath: "Dockerfile" },
    deploy: {
      ...commonDeploy,
      preDeployCommand: ["node apps/backend/dist/apps/backend/src/migrate.js"],
      startCommand: "node apps/backend/dist/apps/backend/src/index.js",
      healthcheckPath: "/health/ready",
      healthcheckTimeout: 120,
      drainingSeconds: 120,
    },
    env: {
      APP_ENV: "production",
      PORT: "8000",
      HOST: "::",
      DATABASE_URL: database.env.DATABASE_URL,
      ADMIN_API_KEY: preserve(),
      SESSION_SECRET: preserve(),
      OPENROUTER_API_KEY: preserve(),
      FRONTEND_URL: "https://${{web.RAILWAY_PUBLIC_DOMAIN}}",
      PUBLIC_DEMO_STUDY_ID: "clinical-150-ae4e477e",
      PUBLIC_DEMO_MAX_SESSIONS: "100",
    },
  });
  const worker = service("worker", {
    build: { builder: "DOCKERFILE", dockerfilePath: "Dockerfile" },
    deploy: {
      ...commonDeploy,
      startCommand: "node apps/backend/dist/apps/backend/src/worker.js",
      drainingSeconds: 180,
    },
    env: {
      APP_ENV: "production",
      DATABASE_URL: database.env.DATABASE_URL,
      ADMIN_API_KEY: api.env.ADMIN_API_KEY,
      SESSION_SECRET: api.env.SESSION_SECRET,
      OPENROUTER_API_KEY: api.env.OPENROUTER_API_KEY,
      FRONTEND_URL: api.env.FRONTEND_URL,
    },
  });
  const web = service("web", {
    build: { builder: "DOCKERFILE", dockerfilePath: "apps/web/Dockerfile" },
    deploy: {
      ...commonDeploy,
      startCommand: "node apps/web/server.js",
      healthcheckPath: "/api/health",
      healthcheckTimeout: 120,
    },
    env: {
      APP_ENV: "production",
      PORT: "3000",
      HOSTNAME: "0.0.0.0",
      BACKEND_URL: "http://${{api.RAILWAY_PRIVATE_DOMAIN}}:8000",
      PUBLIC_FRONTEND_URL: "https://${{web.RAILWAY_PUBLIC_DOMAIN}}",
    },
  });
  return project("clinical-reasoning-study", {
    resources: [database, databaseVolume, api, worker, web],
  });
});
