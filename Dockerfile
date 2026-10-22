FROM node:24-bookworm-slim AS build
WORKDIR /workspace
COPY package.json package-lock.json tsconfig.json ./
COPY apps/backend/package.json apps/backend/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci
COPY packages/shared packages/shared
COPY apps/backend apps/backend
RUN npm run build --workspace @clinical/shared && npm run build --workspace @clinical/backend
RUN npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production APP_ENV=production HOST=::
WORKDIR /workspace
COPY --from=build --chown=node:node /workspace/node_modules ./node_modules
COPY --from=build --chown=node:node /workspace/package.json ./package.json
COPY --from=build --chown=node:node /workspace/packages/shared ./packages/shared
COPY --from=build --chown=node:node /workspace/apps/backend/package.json ./apps/backend/package.json
COPY --from=build --chown=node:node /workspace/apps/backend/dist ./apps/backend/dist
USER node
EXPOSE 8000
CMD ["node","apps/backend/dist/apps/backend/src/index.js"]
