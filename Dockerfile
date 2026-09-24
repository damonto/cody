FROM node:24-trixie-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY console/package.json ./console/package.json
RUN npm ci
COPY . .
RUN npm run build:node

FROM node:24-trixie-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787
COPY --from=build /app/dist ./
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 8787
CMD ["node", "server.mjs"]
