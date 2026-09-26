# Build context: services/ (the pnpm workspace root). See README.
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /ws
# Optional: behind a TLS-intercepting proxy, pass its CA with --secret id=ca,src=<bundle>.
# Used only during install; nothing is written into the image.
ENV CA_SECRET=/run/secrets/ca
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api-stub/package.json apps/api-stub/
RUN --mount=type=secret,id=ca,required=false \
    if [ -f "$CA_SECRET" ]; then export NODE_EXTRA_CA_CERTS="$CA_SECRET" npm_config_cafile="$CA_SECRET"; fi; \
    pnpm install --frozen-lockfile --filter @chain/api-stub...
COPY packages/shared/ packages/shared/
COPY apps/api-stub/ apps/api-stub/
RUN --mount=type=secret,id=ca,required=false \
    if [ -f "$CA_SECRET" ]; then export NODE_EXTRA_CA_CERTS="$CA_SECRET" npm_config_cafile="$CA_SECRET"; fi; \
    pnpm --filter @chain/api-stub... build \
 && pnpm --filter @chain/api-stub deploy --prod --legacy /out

FROM node:22-alpine
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=build /out ./
USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/v1/openapi.json >/dev/null || exit 1
CMD ["node", "dist/server.js"]
