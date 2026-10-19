# Stage 1: fetch three.js (the only front-end dependency) with npm.
FROM node:20-alpine AS vendor
WORKDIR /v
RUN echo '{"name":"vendor","private":true}' > package.json \
 && npm install --no-audit --no-fund three@0.169.0

# Stage 2: tiny Python server (stdlib + Pillow) that serves the web app and images.
FROM python:3.12-slim
RUN pip install --no-cache-dir pillow==10.4.0
WORKDIR /app
COPY server/ server/
COPY web/ web/
COPY --from=vendor /v/node_modules/three/build/three.module.js web/vendor/three.module.js
COPY --from=vendor /v/node_modules/three/examples/jsm/controls/OrbitControls.js web/vendor/addons/controls/OrbitControls.js
ENV DATA_DIR=/data CACHE_DIR=/cache WEB_DIR=/app/web PORT=8080 PYTHONUNBUFFERED=1
VOLUME ["/cache"]
EXPOSE 8080
CMD ["python", "server/server.py"]
