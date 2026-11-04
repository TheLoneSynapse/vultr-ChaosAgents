FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY server.py /server.py
USER nobody
WORKDIR /app
CMD ["python", "/server.py"]
