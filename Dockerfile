FROM node:22.23.2-bookworm-slim AS build
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
  python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm install --global npm@11.6.1 && npm ci
COPY app ./app
COPY components ./components
COPY lib ./lib
COPY server ./server
COPY shared ./shared
COPY src ./src
COPY public ./public
COPY next.config.ts vite.config.ts tsconfig.json next-env.d.ts ./
RUN npm run build
RUN npm prune --omit=dev

FROM node:22.23.2-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

RUN apt-get update && apt-get install -y --no-install-recommends \
  python3 python3-venv python3-pip \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/lib ./lib
COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/shared ./shared
COPY --chown=node:node db ./db
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node agent ./agent

RUN python3 -m venv /app/agent/.venv \
  && /app/agent/.venv/bin/pip install --no-cache-dir -r /app/agent/requirements.txt \
  && chown -R node:node /app/agent

ENV DEBUG_AGENT_PYTHON_PATH=/app/agent/.venv/bin/python
USER node
EXPOSE 3000
CMD ["node", "node_modules/vinext/dist/cli.js", "start", "-H", "0.0.0.0", "-p", "3000"]
