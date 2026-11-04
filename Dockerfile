# Single Dockerfile for all Node services. Select the service with --build-arg APP=api|worker.
FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm install --include=dev --no-audit --no-fund \
 && npm run build

FROM node:22-alpine AS runtime
ARG APP
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages ./packages
COPY --from=build /repo/apps ./apps
COPY --from=build /repo/package.json ./package.json
WORKDIR /repo/apps/${APP}
CMD ["node", "dist/server.js"]
