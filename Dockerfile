FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
COPY scripts ./scripts
ENV NODE_ENV=production PORT=3000 DB_FILE=/app/data/kanakku.db
VOLUME /app/data
EXPOSE 3000
CMD ["node", "--no-warnings", "src/server.js"]
