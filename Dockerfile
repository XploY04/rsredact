# The base is pinned by digest, a multi-arch index, so a rebuild cannot pick up
# a different image. Bump the tag and digest together.
ARG NODE_IMAGE=node:22.23.4-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d

# Dependencies are installed in their own layer so that editing src/ does not
# reinstall them on every image build.
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src ./src
RUN npm run build

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# bookworm rather than alpine: @napi-rs/canvas ships glibc builds as the main path.
FROM ${NODE_IMAGE}

# Redaction boxes are placed by measuring each character in a proxy font. With no
# fonts installed every width comes back the same, the box drifts by a character,
# and the first letter of an email stays readable. Liberation matches the metrics
# of Arial, Times and Courier, the fonts most CVs are set in.
RUN apt-get update \
    && apt-get install -y --no-install-recommends fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

LABEL org.opencontainers.image.title="rsredact" \
      org.opencontainers.image.description="Resume redaction over HTTP" \
      org.opencontainers.image.source="https://github.com/RemoteStar-AI/rsredact" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
# openai is an optional peer of the library, so --omit=dev leaves it out, but the
# server needs it. It has no dependencies of its own, so the locked copy from the
# build stage is all it takes.
COPY --from=build /app/node_modules/openai ./node_modules/openai
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 8080
# The slim image has no curl, so node asks.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "dist/server/main.js"]
