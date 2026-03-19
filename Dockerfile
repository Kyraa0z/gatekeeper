FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:20-alpine
RUN addgroup -S gatekeeper && adduser -S gatekeeper -G gatekeeper
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --chown=gatekeeper:gatekeeper . .
RUN mkdir -p /app/data/logs && chown -R gatekeeper:gatekeeper /app/data
USER gatekeeper
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD wget -qO- http://localhost:4000/gatekeeper/verify || exit 1
CMD ["node", "server.js"]
