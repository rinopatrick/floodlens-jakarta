FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    FLOODLENS_HOST=0.0.0.0 \
    FLOODLENS_PORT=8766 \
    FLOODLENS_ENV=production

WORKDIR /app

COPY floodlens ./floodlens
COPY public ./public
COPY server.py ./

RUN useradd --create-home --uid 10001 floodlens \
    && chown -R floodlens:floodlens /app
USER floodlens

EXPOSE 8766

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8766/healthz', timeout=3)"

CMD ["python", "server.py"]
