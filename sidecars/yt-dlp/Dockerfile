FROM python:3.12-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY server.py ./

ENV UBUROOM_YTDLP_HOST=0.0.0.0 \
    UBUROOM_YTDLP_PORT=8780 \
    UBUROOM_YTDLP_CACHE_DIR=/cache \
    UBUROOM_YTDLP_MAX_CACHE_BYTES=21474836480 \
    UBUROOM_YTDLP_MAX_CONCURRENT=2

VOLUME ["/cache"]
EXPOSE 8780

CMD ["python", "server.py"]
