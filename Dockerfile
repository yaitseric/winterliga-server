FROM node:22-alpine

WORKDIR /app
COPY server.js seed.json ./
COPY public ./public

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=127.0.0.1 \
    DATA_DIR=/data

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data

HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "server.js"]
