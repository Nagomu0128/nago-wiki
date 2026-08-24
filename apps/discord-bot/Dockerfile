FROM node:24-bookworm-slim AS build
WORKDIR /workspace
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/discord-bot/package.json apps/discord-bot/package.json
RUN npm ci --workspace @nago-wiki/discord-bot --include-workspace-root
COPY apps/discord-bot apps/discord-bot
RUN npm run build --workspace @nago-wiki/discord-bot

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /workspace
COPY package.json package-lock.json ./
COPY apps/discord-bot/package.json apps/discord-bot/package.json
RUN npm ci --omit=dev --workspace @nago-wiki/discord-bot --include-workspace-root && npm cache clean --force
COPY --from=build /workspace/apps/discord-bot/dist apps/discord-bot/dist
USER node
EXPOSE 8080
CMD ["node", "apps/discord-bot/dist/index.js"]
