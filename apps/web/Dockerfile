FROM node:24-bookworm-slim AS build
WORKDIR /workspace
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json tsconfig.json ./
COPY apps/backend/package.json apps/backend/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN npm run build --workspace @clinical/shared && npm run build --workspace @clinical/web

FROM node:24-bookworm-slim AS runtime
WORKDIR /workspace
ENV NODE_ENV=production APP_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
COPY --from=build --chown=node:node /workspace/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /workspace/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node","apps/web/server.js"]
