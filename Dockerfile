# Multi-target image: docker build --target api|mcp|slack|web .
# The default (last) target, `server`, holds the Node services; pick one with the command:
# `node server/dist/main.js` (API + MCP + Slack in one process, for a single free instance) or
# `node api/dist/main.js`, `node mcp/dist/http.js`, `node slack/dist/main.js` (one per service).
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm art \
 && pnpm --filter @spinroom/web build \
 && pnpm --filter @spinroom/api build \
 && pnpm --filter spinroom-mcp build \
 && pnpm --filter @spinroom/slack build \
 && pnpm --filter @spinroom/server build \
 && pnpm --filter @spinroom/api deploy --prod --legacy /out/api \
 && pnpm --filter spinroom-mcp deploy --prod --legacy /out/mcp \
 && pnpm --filter @spinroom/slack deploy --prod --legacy /out/slack \
 && pnpm --filter @spinroom/server deploy --prod --legacy /out/server \
 && cp -r apps/api/drizzle /out/server/drizzle

FROM node:22-slim AS api
WORKDIR /app
COPY --from=build /out/api ./
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/apps/api/drizzle ./drizzle
ENV NODE_ENV=production MIGRATIONS_DIR=/app/drizzle
EXPOSE 8080
CMD ["node", "dist/main.js"]

FROM node:22-slim AS mcp
WORKDIR /app
COPY --from=build /out/mcp ./
COPY --from=build /repo/apps/mcp/dist ./dist
ENV NODE_ENV=production
EXPOSE 8090
CMD ["node", "dist/http.js"]

FROM node:22-slim AS slack
WORKDIR /app
COPY --from=build /out/slack ./
COPY --from=build /repo/apps/slack/dist ./dist
ENV NODE_ENV=production
EXPOSE 8070
CMD ["node", "dist/main.js"]

# Static web app; route /v1, /oauth/{authorize,token,register,revoke} and
# /.well-known/oauth-authorization-server to the API, /v1/integrations/slack to the Slack service.
FROM nginx:1.27-alpine AS web
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80

FROM node:22-slim AS server
WORKDIR /app
COPY --from=build /out/api ./api
COPY --from=build /out/mcp ./mcp
COPY --from=build /out/slack ./slack
COPY --from=build /out/server ./server
# Migrations ship with both the API and the all-in-one server; either path holds the same files.
ENV NODE_ENV=production MIGRATIONS_DIR=/app/server/drizzle
CMD ["node", "server/dist/main.js"]
