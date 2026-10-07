# Multi-target image: docker build --target api|mcp|slack|web .
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
 && pnpm --filter @spinroom/api deploy --prod --legacy /out/api \
 && pnpm --filter spinroom-mcp deploy --prod --legacy /out/mcp \
 && pnpm --filter @spinroom/slack deploy --prod --legacy /out/slack

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
