FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --chown=node:node server.js app.js index.html styles.css terms.html privacy.html ./
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
