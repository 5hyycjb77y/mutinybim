# The editor demo (packages/bim-devserver) for docker-compose.yml. Build context
# = the repository root. Not a production image: it carries the dev tooling the
# editor bundle is built with.
FROM node:22-bookworm-slim

RUN mkdir /repo && chown node:node /repo
WORKDIR /repo
USER node
COPY --chown=node:node . .
RUN if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi \
  && npm cache clean --force

ENV BIM_DEV_PORT=3095
EXPOSE 3095
CMD ["npm", "run", "demo"]
