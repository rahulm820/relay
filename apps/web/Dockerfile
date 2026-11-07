# Frontend (Next.js). Build from repo root: docker build -f apps/web/Dockerfile .
FROM node:22-alpine AS deps
WORKDIR /repo
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY apps/web/package.json ./apps/web/
RUN npm install --include=dev --no-audit --no-fund

FROM node:22-alpine AS build
WORKDIR /repo
COPY --from=deps /repo/node_modules ./node_modules
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY apps/web ./apps/web
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build -w @relay/shared && npm run build -w @relay/web

FROM node:22-alpine AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
WORKDIR /repo
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/apps/web/.next ./apps/web/.next
COPY --from=build /repo/apps/web/package.json ./apps/web/
COPY --from=build /repo/package.json ./package.json
WORKDIR /repo/apps/web
EXPOSE 3000
CMD ["node", "/repo/node_modules/next/dist/bin/next", "start", "-p", "3000"]
