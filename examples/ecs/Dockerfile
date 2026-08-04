FROM rust:1-bookworm AS shipper

WORKDIR /build

COPY Cargo.toml Cargo.lock ./
COPY crates ./crates

RUN cargo build --release -p pino-loki-rs \
    && strip target/release/pino-loki-rs \
    && /build/target/release/pino-loki-rs --version


FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PINO_LOKI_DRAIN_MAX_MS=8000 \
    PINO_LOKI_STATS_INTERVAL_MS=30000 \
    PINO_LOKI_TRANSPORT_TARGET=/opt/pino-loki-rs/transport.mjs \
    PINO_LOKI_BIN=/usr/local/bin/pino-loki-rs

COPY --from=shipper /build/target/release/pino-loki-rs /usr/local/bin/pino-loki-rs
COPY js/transport.mjs /opt/pino-loki-rs/transport.mjs

WORKDIR /app

COPY examples/ecs/package.json examples/ecs/pnpm-lock.yaml ./
RUN corepack enable pnpm && pnpm install --prod --frozen-lockfile

COPY examples/ecs/server.example.mjs ./server.mjs

USER node
STOPSIGNAL SIGTERM
EXPOSE 3000

CMD ["node", "server.mjs"]
