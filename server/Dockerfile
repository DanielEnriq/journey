# Vowe cloud API image. Build context is the repository root (the pnpm workspace):
#   docker build -f server/Dockerfile .
FROM node:24-slim AS build
RUN corepack enable && corepack prepare pnpm@10.34.1 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json server/
# --ignore-scripts: the workspace root is the Electron app, whose postinstall (electron-rebuild) has no
# place here. The API's dependencies need no install scripts.
RUN pnpm install --frozen-lockfile --filter vowe-api --ignore-scripts
COPY server/ server/
RUN pnpm --filter vowe-api build \
  && pnpm --filter vowe-api deploy --prod --legacy --ignore-scripts /out

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/package.json ./
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /app/server/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
