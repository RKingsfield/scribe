# syntax=docker/dockerfile:1.6

# ---- frontend build ---------------------------------------------------------
FROM node:20-alpine AS frontend-build
WORKDIR /work
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci
COPY frontend/ ./
RUN npm run lint
RUN npm run test
RUN npm run build

# ---- backend base -----------------------------------------------------------
FROM python:3.12-slim AS base
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1
RUN apt-get update \
 && apt-get install -y --no-install-recommends git pandoc openssh-client \
 && rm -rf /var/lib/apt/lists/*
RUN groupadd -g 1000 app && useradd -u 1000 -g app -m app
RUN git config --system safe.directory '*'
WORKDIR /app
COPY backend/pyproject.toml ./
COPY backend/src ./src
RUN pip install --no-cache-dir .

# ---- test stage (build fails if tests fail) ---------------------------------
FROM base AS test
COPY backend/tests ./tests
RUN pip install --no-cache-dir .[test]
RUN ruff check src tests
RUN mypy src/scribe
RUN pytest tests/ -v

# ---- runtime ----------------------------------------------------------------
FROM base
ENV STATIC_ROOT=/app/static \
    PORT=3030
COPY --from=frontend-build /work/dist /app/static
RUN chown -R app:app /app
USER app
EXPOSE 3030
CMD ["sh", "-c", "uvicorn scribe.main:app --host 0.0.0.0 --port ${PORT}"]
