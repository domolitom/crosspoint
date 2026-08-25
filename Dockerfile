# Build every workspace, then ship only what the server needs at runtime.
FROM node:22-alpine AS build
WORKDIR /app

# Manifests first, so a source-only change does not reinstall dependencies.
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/e2e/package.json packages/e2e/
COPY packages/mcp/package.json packages/mcp/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci

COPY . .
RUN npm run build


FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    CROSSPOINT_PORT=4000 \
    CROSSPOINT_DIAGRAMS=/diagrams

COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/e2e/package.json packages/e2e/
COPY packages/mcp/package.json packages/mcp/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci --omit=dev && npm cache clean --force

# `static.ts` resolves the canvas relative to packages/server/dist, so the tree shape matters.
COPY --from=build /app/packages/core/dist   packages/core/dist
COPY --from=build /app/packages/server/dist packages/server/dist
COPY --from=build /app/packages/web/dist    packages/web/dist

# Diagrams are the user's work and must outlive the container.
VOLUME /diagrams
EXPOSE 4000
USER node
CMD ["node", "packages/server/dist/index.js"]
