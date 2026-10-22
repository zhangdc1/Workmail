FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm run extension:build && npm prune --omit=dev

FROM node:24-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001 SMTP_HOST=0.0.0.0 INTEGRATION_PYTHON=/opt/integration/bin/python
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates tini && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY integrations/requirements.txt /tmp/requirements.txt
RUN python3 -m venv /opt/integration && /opt/integration/bin/pip install --no-cache-dir -r /tmp/requirements.txt
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package*.json ./
COPY --from=build /app/dist ./dist
COPY --from=build /app/apps/api/migrations ./apps/api/migrations
COPY --from=build /app/integrations ./integrations
# Only persistent mail data needs to be writable by the runtime user.
# Keep application code/dependencies root-owned and avoid copying all layers
# merely to recursively change ownership on low-I/O VPS disks.
RUN mkdir -p /data/mail && chown node:node /data /data/mail
USER node
ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["node","dist/apps/api/src/server.js"]
