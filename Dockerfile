# syntax=docker/dockerfile:1
FROM ghcr.io/gitleaks/gitleaks:v8.30.1 AS secret-scanner

FROM oven/bun:1.4.4 AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM dependencies AS build
COPY --chown=bun:bun . .
RUN bun run build

FROM build AS verification
COPY --from=secret-scanner /usr/bin/gitleaks /usr/local/bin/gitleaks
COPY docs/third-party/GITLEAKS_LICENSE.md /usr/share/licenses/gitleaks/LICENSE
# The verifier writes sanitized evidence and private diagnostic artifacts to
# separate bind mounts. Runtime below remains unprivileged.
USER root
CMD ["bun", "scripts/verify.ts"]

FROM oven/bun:1.4.4 AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY --from=build --chown=bun:bun /app/dist ./dist
COPY --chown=bun:bun tsconfig.json ./
COPY --chown=bun:bun src ./src
COPY --chown=bun:bun scripts ./scripts
COPY --chown=bun:bun telemetry/lib.ts telemetry/queries.ts ./telemetry/
USER bun
EXPOSE 3000
STOPSIGNAL SIGTERM
CMD ["bun", "dist/main.js"]
