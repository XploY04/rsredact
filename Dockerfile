# Dependencies are installed in their own layer so that editing src/ does not
# reinstall them on every image build.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# bookworm rather than alpine: @napi-rs/canvas ships glibc builds as the main path.
FROM node:22-bookworm-slim

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
CMD ["node", "dist/server/main.js"]
