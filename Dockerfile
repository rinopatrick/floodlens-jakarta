FROM python:3.12-slim@sha256:0c25ff36851689e5a206091ab6465932a762a086a2ffc4d2bcc9575f4a58c52f

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    FLOODLENS_HOST=0.0.0.0 \
    FLOODLENS_ENV=production \
    FLOODLENS_HSTS=1

WORKDIR /app

COPY floodlens ./floodlens
COPY public ./public
COPY server.py ./

RUN useradd --create-home --uid 10001 floodlens \
    && chown -R floodlens:floodlens /app
USER floodlens

EXPOSE 8766

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD python -c "import os, urllib.request; port = os.environ.get('FLOODLENS_PORT') or os.environ.get('PORT') or '8766'; urllib.request.urlopen(f'http://127.0.0.1:{port}/healthz', timeout=3)"

CMD ["python", "server.py"]
