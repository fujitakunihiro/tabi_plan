FROM node:22-alpine
WORKDIR /app
COPY --chown=node:node server.js app.js index.html styles.css ./
USER node
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
